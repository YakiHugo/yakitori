import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isDeepStrictEqual } from "node:util"
import type {
  EngineAdapter,
  EngineBinding,
  EngineEvent,
  EngineInput,
  EnginePermissionResponse,
  EngineSendResult,
} from "./engines/engine.ts"

export type ExternalAppSession = Readonly<{
  id: string
  title?: string
  projectId?: string
  binding: EngineBinding
  createdAt: number
  updatedAt: number
}>
export type ObservedEngineEvent = Readonly<{
  seq: number
  createdAt: number
  event:
    | EngineEvent
    | Readonly<{
        type: "input.submitted"
        requestId: string
        turnId: string
        text: string
      }>
    | Readonly<{
        type: "permission.resolved"
        requestId: string
        turnId?: string
        optionId: string
      }>
}>
export type ExternalRequest = Readonly<{
  requestId: string
  input: EngineInput
  status: "pending" | "accepted" | "rejected" | "terminal" | "unknown"
  turnId?: string
  reason?: string
}>
export type ExternalSessionRead = Readonly<{
  session: ExternalAppSession
  events: readonly ObservedEngineEvent[]
  requests: readonly ExternalRequest[]
  history: "observed"
}>

// This is an app display/index store for external engines, never their context
// database. Native Yakitori sessions continue to use their canonical rollout.
export class ExternalSessionService {
  readonly #changed: ((sessionId: string) => void) | undefined
  readonly #engine: EngineAdapter
  readonly #database: DatabaseSync
  readonly #bound = new Map<string, Promise<EngineBinding>>()
  readonly #unsubscribe = new Map<string, () => void>()
  readonly #listeners = new Map<
    string,
    Set<(event: ObservedEngineEvent) => void>
  >()
  readonly #sending = new Map<string, Promise<EngineSendResult>>()
  readonly #operations = new Set<Promise<unknown>>()
  #closing = false
  #closed = false
  #closeTask: Promise<void> | undefined

  constructor(options: {
    engine: EngineAdapter
    databasePath: string
    changed?: (sessionId: string) => void
  }) {
    this.#changed = options.changed
    this.#engine = options.engine
    if (options.databasePath !== ":memory:")
      mkdirSync(dirname(options.databasePath), { recursive: true })
    this.#database = new DatabaseSync(options.databasePath)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS external_sessions (id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE IF NOT EXISTS external_requests (session_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, request_id));
    `)
    // A process restart is not evidence that the external engine stopped. Keep
    // unfinished submissions explicitly unknown rather than automatically retry.
    for (const session of this.list()) {
      for (const request of this.#requests(session.id)) {
        if (request.status !== "pending" && request.status !== "accepted")
          continue
        this.#saveRequest(session.id, { ...request, status: "unknown" })
        if (request.turnId !== undefined)
          this.#append(session.id, {
            type: "turn.status",
            turnId: request.turnId,
            status: "disconnected",
            message: "Application restarted before observing completion.",
          })
      }
    }
  }

  create(input: {
    cwd: string
    title?: string
    projectId?: string
  }): Promise<ExternalAppSession> {
    return this.#run(() => this.#create(input))
  }

  async #create(input: {
    cwd: string
    title?: string
    projectId?: string
  }): Promise<ExternalAppSession> {
    await this.#engine.connect()
    this.#checkAccepting()
    const id = `session_${randomUUID()}`
    const binding = await this.#engine.bind({
      appSessionId: id,
      cwd: input.cwd,
    })
    if (
      binding.engineId !== this.#engine.id ||
      binding.appSessionId !== id ||
      binding.cwd !== input.cwd
    )
      throw new Error("Engine returned an invalid session binding.")
    this.#checkAccepting()
    const now = Date.now()
    const session: ExternalAppSession = {
      id,
      binding,
      createdAt: now,
      updatedAt: now,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    }
    this.#database
      .prepare(
        "INSERT INTO external_sessions (id, engine_id, data) VALUES (?, ?, ?)",
      )
      .run(id, this.#engine.id, JSON.stringify(session))
    this.#listen(binding)
    this.#changed?.(id)
    return session
  }

  list(): ExternalAppSession[] {
    this.#checkOpen()
    return this.#database
      .prepare("SELECT data FROM external_sessions WHERE engine_id = ?")
      .all(this.#engine.id)
      .map((row) => JSON.parse(String(row.data)) as ExternalAppSession)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  read(id: string): ExternalSessionRead | undefined {
    this.#checkOpen()
    const session = this.#session(id)
    if (session === undefined) return undefined
    const events = this.#database
      .prepare(
        "SELECT data FROM external_events WHERE session_id = ? ORDER BY seq",
      )
      .all(id)
      .map((row) => JSON.parse(String(row.data)) as ObservedEngineEvent)
    return {
      session,
      events,
      requests: this.#requests(id),
      history: "observed",
    }
  }

  send(id: string, input: EngineInput): Promise<EngineSendResult> {
    return this.#run(() => this.#admit(id, input))
  }

  async #admit(id: string, input: EngineInput): Promise<EngineSendResult> {
    this.#require(id)
    const existing = this.#requests(id).find(
      (request) => request.requestId === input.requestId,
    )
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.input, input))
        return { status: "rejected", reason: "request_conflict" }
      const active = this.#sending.get(`${id}\0${input.requestId}`)
      if (active !== undefined) return active
      if (
        (existing.status === "accepted" || existing.status === "terminal") &&
        existing.turnId !== undefined
      )
        return { status: "accepted", turnId: existing.turnId, replayed: true }
      return {
        status: "rejected",
        reason:
          existing.status === "rejected"
            ? (existing.reason ?? "rejected")
            : "outcome_unknown",
      }
    }
    // Persist the intent before crossing the process boundary. Any exception
    // after this fence leaves an unknown outcome which cannot be blindly sent.
    this.#saveRequest(id, {
      requestId: input.requestId,
      input,
      status: "pending",
    })
    const sending = this.#send(id, input)
    this.#sending.set(`${id}\0${input.requestId}`, sending)
    try {
      return await sending
    } finally {
      this.#sending.delete(`${id}\0${input.requestId}`)
    }
  }

  async #send(id: string, input: EngineInput): Promise<EngineSendResult> {
    try {
      const binding = await this.#bind(id)
      this.#checkAccepting()
      const result = await this.#engine.send(binding, input)
      if (result.status === "rejected") {
        this.#saveRequest(id, {
          requestId: input.requestId,
          input,
          status: "rejected",
          reason: result.reason,
        })
        return result
      }
      const observed = this.read(id)
        ?.events.slice()
        .reverse()
        .find(
          ({ event }) =>
            event.type === "turn.status" && event.turnId === result.turnId,
        )?.event
      const status =
        observed?.type === "turn.status" && observed.status === "disconnected"
          ? "unknown"
          : observed?.type === "turn.status" &&
              ["completed", "failed", "cancelled"].includes(observed.status)
            ? "terminal"
            : "accepted"
      this.#saveRequest(id, {
        requestId: input.requestId,
        input,
        status,
        turnId: result.turnId,
      })
      this.#append(id, {
        type: "input.submitted",
        requestId: input.requestId,
        turnId: result.turnId,
        text: input.text,
      })
      return result
    } catch (error) {
      this.#saveRequest(id, {
        requestId: input.requestId,
        input,
        status: "unknown",
        reason: error instanceof Error ? error.message : "Engine send failed.",
      })
      throw error
    }
  }

  cancel(id: string, turnId: string, reason?: string) {
    return this.#run(async () => {
      const binding = await this.#bind(id)
      this.#checkAccepting()
      return this.#engine.cancel(binding, turnId, reason)
    })
  }

  respondPermission(
    id: string,
    response: EnginePermissionResponse,
  ): Promise<boolean> {
    return this.#run(() => this.#respondPermission(id, response))
  }

  async #respondPermission(
    id: string,
    response: EnginePermissionResponse,
  ): Promise<boolean> {
    const binding = await this.#bind(id)
    this.#checkAccepting()
    const resolved = await this.#engine.respondPermission(binding, response)
    if (resolved)
      this.#append(id, {
        type: "permission.resolved",
        requestId: response.requestId,
        optionId: response.optionId,
        ...(response.turnId === undefined ? {} : { turnId: response.turnId }),
      })
    return resolved
  }

  subscribe(
    id: string,
    listener: (event: ObservedEngineEvent) => void,
  ): () => void {
    this.#checkAccepting()
    this.#require(id)
    const listeners = this.#listeners.get(id) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(id)
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closing = true
    this.#closeTask ??= this.#close()
    return this.#closeTask
  }

  async #close(): Promise<void> {
    // Keep the journal writable while shutdown events and in-flight operations
    // settle. The admission fence prevents their awaits from reconnecting.
    // Adapter close must settle active requests before the journal is closed.
    try {
      await this.#engine.close()
    } finally {
      await Promise.allSettled(this.#operations)
      for (const unsubscribe of this.#unsubscribe.values()) unsubscribe()
      this.#listeners.clear()
      this.#database.close()
      this.#closed = true
    }
  }

  async #bind(id: string): Promise<EngineBinding> {
    const session = this.#require(id)
    const existing = this.#bound.get(id)
    if (existing !== undefined) return existing
    const pending = (async () => {
      await this.#engine.connect()
      this.#checkAccepting()
      const binding = await this.#engine.bind({
        appSessionId: id,
        engineSessionId: session.binding.engineSessionId,
        cwd: session.binding.cwd,
      })
      if (
        binding.engineSessionId !== session.binding.engineSessionId ||
        binding.engineId !== session.binding.engineId ||
        binding.appSessionId !== id ||
        binding.cwd !== session.binding.cwd
      )
        throw new Error(
          "Engine reconnect changed the immutable session binding.",
        )
      this.#checkAccepting()
      this.#listen(binding)
      return binding
    })()
    this.#bound.set(id, pending)
    try {
      return await pending
    } finally {
      this.#bound.delete(id)
    }
  }

  #listen(binding: EngineBinding): void {
    this.#unsubscribe.get(binding.appSessionId)?.()
    this.#unsubscribe.set(
      binding.appSessionId,
      this.#engine.subscribe(binding, (event) => {
        this.#append(binding.appSessionId, event)
      }),
    )
  }

  #append(id: string, event: ObservedEngineEvent["event"]): void {
    const row = this.#database
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM external_events WHERE session_id = ?",
      )
      .get(id)
    const observed: ObservedEngineEvent = {
      seq: Number(row?.seq ?? 0) + 1,
      createdAt: Date.now(),
      event,
    }
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#database
        .prepare(
          "INSERT INTO external_events (session_id, seq, data) VALUES (?, ?, ?)",
        )
        .run(id, observed.seq, JSON.stringify(observed))
      if (event.type === "turn.status") {
        const status =
          event.status === "disconnected"
            ? "unknown"
            : ["completed", "failed", "cancelled"].includes(event.status)
              ? "terminal"
              : undefined
        if (status !== undefined)
          for (const request of this.#requests(id)) {
            if (request.turnId === event.turnId)
              this.#saveRequest(id, { ...request, status })
          }
      }
      const session = this.#require(id)
      this.#database
        .prepare("UPDATE external_sessions SET data = ? WHERE id = ?")
        .run(JSON.stringify({ ...session, updatedAt: observed.createdAt }), id)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
    this.#changed?.(id)
    for (const listener of this.#listeners.get(id) ?? []) listener(observed)
  }

  #requests(id: string): ExternalRequest[] {
    return this.#database
      .prepare(
        "SELECT data FROM external_requests WHERE session_id = ? ORDER BY rowid",
      )
      .all(id)
      .map((row) => JSON.parse(String(row.data)) as ExternalRequest)
  }

  #saveRequest(id: string, request: ExternalRequest): void {
    this.#database
      .prepare(
        "INSERT INTO external_requests (session_id, request_id, data) VALUES (?, ?, ?) ON CONFLICT(session_id, request_id) DO UPDATE SET data = excluded.data",
      )
      .run(id, request.requestId, JSON.stringify(request))
  }

  #session(id: string): ExternalAppSession | undefined {
    const row = this.#database
      .prepare(
        "SELECT data FROM external_sessions WHERE id = ? AND engine_id = ?",
      )
      .get(id, this.#engine.id)
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.data)) as ExternalAppSession)
  }

  #require(id: string): ExternalAppSession {
    this.#checkOpen()
    const session = this.#session(id)
    if (session === undefined)
      throw new Error(`External app session ${id} was not found.`)
    return session
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#checkAccepting()
    const task = operation()
    this.#operations.add(task)
    try {
      return await task
    } finally {
      this.#operations.delete(task)
    }
  }

  #checkAccepting(): void {
    if (this.#closing || this.#closed)
      throw new Error("External session service is closed.")
  }

  #checkOpen(): void {
    if (this.#closed) throw new Error("External session service is closed.")
  }
}

export function createExternalSessionService(options: {
  engine: EngineAdapter
  databasePath: string
  changed?: (sessionId: string) => void
}): ExternalSessionService {
  return new ExternalSessionService(options)
}

export function listStoredExternalEngineIds(
  databasePath: string,
): readonly string[] {
  if (!existsSync(databasePath)) return []
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_sessions'",
      )
      .get()
    if (table === undefined) return []
    return database
      .prepare(
        "SELECT DISTINCT engine_id FROM external_sessions ORDER BY engine_id",
      )
      .all()
      .map((row) => String(row.engine_id))
  } finally {
    database.close()
  }
}
