import type {
  EventMetadata,
  JsonObject,
  ModelMessage,
} from "../kernel/events.ts"
import { createItemId, createSessionId, createTurnId } from "../kernel/ids.ts"
import { AgentThread } from "./agent-thread.ts"
import type { ModelContextSettings, StoredThread } from "./rollout.ts"
import { Session, type TurnProcessor } from "./session.ts"
import { SessionStatus } from "./session-io.ts"
import type {
  CreateThreadMetadata,
  ThreadStore,
  ThreadStoreForkResult,
  ThreadStoreListInput,
} from "./thread-store.ts"

export type CreateThreadInput = {
  readonly threadId?: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly projectId?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentThreadId?: string
  readonly conversationId?: string
  readonly metadata?: EventMetadata
  readonly initialContext?: Readonly<{
    sourceThreadId: string
    messages: readonly ModelMessage[]
    worldStateBaseline?: JsonObject
    previousModel?: ModelContextSettings
    activeContextTokens?: number
  }>
}

export type ForkThreadInput = {
  readonly sourceThreadId: string
  readonly beforeTurnId: string
  readonly title?: string
  readonly metadata?: EventMetadata
  readonly forkedFromInputId?: string
  readonly forkReason?: import("../kernel/events.ts").ForkReason
}

export type ThreadManagerOptions = {
  readonly store: ThreadStore
  readonly createTurnProcessor: (
    stored: StoredThread,
  ) => TurnProcessor | Promise<TurnProcessor>
  readonly onPersistenceError?: (error: unknown, threadId: string) => void
  readonly onBackgroundError?: (
    error: unknown,
    threadId: string,
    operation: string,
  ) => void
  readonly maxResidentSubagentThreads?: number
}

export class ThreadManager {
  readonly #store: ThreadStore
  readonly #createTurnProcessor: (
    stored: StoredThread,
  ) => TurnProcessor | Promise<TurnProcessor>
  readonly #onPersistenceError?:
    | ((error: unknown, threadId: string) => void)
    | undefined
  readonly #onBackgroundError?:
    | ((error: unknown, threadId: string, operation: string) => void)
    | undefined
  readonly #threads = new Map<string, AgentThread>()
  readonly #threadStatusSubscriptions = new Map<string, () => void>()
  readonly #runningThreadIds = new Set<string>()
  readonly #runningTurnCountListeners = new Set<(count: number) => void>()
  readonly #loads = new Map<string, Promise<AgentThread | undefined>>()
  readonly #starting = new Set<Promise<unknown>>()
  readonly #closingThreads = new Set<string>()
  readonly #lastUsed = new Map<string, number>()
  readonly #maxResidentSubagentThreads: number
  #useSequence = 0
  #residencyMaintenance: Promise<void> = Promise.resolve()
  readonly #discarding = new Set<string>()
  #closing = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: ThreadManagerOptions) {
    this.#store = options.store
    this.#createTurnProcessor = options.createTurnProcessor
    this.#onPersistenceError = options.onPersistenceError
    this.#onBackgroundError = options.onBackgroundError
    this.#maxResidentSubagentThreads =
      options.maxResidentSubagentThreads ?? Number.POSITIVE_INFINITY
    if (
      this.#maxResidentSubagentThreads !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(this.#maxResidentSubagentThreads) ||
        this.#maxResidentSubagentThreads <= 0)
    ) {
      throw new Error("maxResidentSubagentThreads must be a positive integer.")
    }
  }

  get runningTurnCount(): number {
    // Status notifications are intentionally delivered in microtasks, so the
    // set below drives change notifications but cannot be the authoritative
    // value read by a signal handler in the same tick as Turn admission.
    return [...this.#threads.values()].filter(
      (thread) => thread.status === SessionStatus.Active,
    ).length
  }

  get residentThreadCount(): number {
    return this.#threads.size
  }

  subscribeRunningTurnCount(listener: (count: number) => void): () => void {
    this.#runningTurnCountListeners.add(listener)
    return () => this.#runningTurnCountListeners.delete(listener)
  }

  getThread(threadId: string): AgentThread | undefined {
    const thread = this.#threads.get(threadId)
    if (thread === undefined || thread.status === "shutdown") return undefined
    this.#lastUsed.set(threadId, ++this.#useSequence)
    return thread
  }

  createThread(input: CreateThreadInput = {}): Promise<AgentThread> {
    this.#requireOpen()
    return this.#trackStarting(async () => {
      const now = new Date().toISOString()
      const threadId = input.threadId ?? createSessionId()
      const metadata: CreateThreadMetadata = {
        id: threadId,
        conversationId: input.conversationId ?? threadId,
        createdAt: now,
        updatedAt: now,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.workingDirectory === undefined
          ? {}
          : { workingDirectory: input.workingDirectory }),
        ...(input.projectId === undefined
          ? {}
          : { projectId: input.projectId }),
        ...(input.mateId === undefined ? {} : { mateId: input.mateId }),
        ...(input.mateRevisionId === undefined
          ? {}
          : { mateRevisionId: input.mateRevisionId }),
        ...(input.parentThreadId === undefined
          ? {}
          : { parentThreadId: input.parentThreadId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      let stored = await this.#store.createThread(metadata)
      try {
        if (input.initialContext !== undefined) {
          const initialContext = input.initialContext
          const seedTurnId = createTurnId()
          const createdAt = new Date().toISOString()
          await this.#store.appendItems(threadId, [
            ...(initialContext.previousModel === undefined
              ? []
              : [
                  {
                    type: "model_context" as const,
                    settings: initialContext.previousModel,
                  },
                ]),
            ...initialContext.messages.map((message) => ({
              type: "response_item" as const,
              item: {
                id: createItemId(),
                turnId: seedTurnId,
                createdAt,
                item: message,
                submissionMetadata: {
                  metadata: {
                    inheritedFromThreadId: initialContext.sourceThreadId,
                  },
                },
              },
            })),
            ...(initialContext.worldStateBaseline === undefined
              ? []
              : [
                  {
                    type: "world_state" as const,
                    turnId: seedTurnId,
                    full: true,
                    state: initialContext.worldStateBaseline,
                  },
                ]),
            ...(initialContext.activeContextTokens === undefined
              ? []
              : [
                  {
                    type: "token_count" as const,
                    turnId: seedTurnId,
                    activeContextTokens: initialContext.activeContextTokens,
                  },
                ]),
          ])
          await this.#store.flushThread(threadId)
          stored =
            (await this.#store.readThread(threadId)) ??
            (() => {
              throw new Error(`Thread ${threadId} disappeared while seeding.`)
            })()
        }
      } catch (error) {
        await this.#store.deleteThread(threadId)
        throw error
      }
      if (this.#closing) {
        await this.#store.deleteThread(threadId)
        throw new Error("ThreadManager shut down while creating a Thread.")
      }
      try {
        return await this.#installStored(stored)
      } catch (error) {
        await this.#store.deleteThread(threadId)
        throw error
      }
    })
  }

  resumeThread(threadId: string): Promise<AgentThread | undefined> {
    this.#requireOpen()
    if (this.#discarding.has(threadId)) {
      return Promise.reject(new Error(`Thread ${threadId} is being discarded.`))
    }
    if (this.#closingThreads.has(threadId)) {
      return Promise.reject(new Error(`Thread ${threadId} is being closed.`))
    }
    const live = this.getThread(threadId)
    if (live !== undefined) return Promise.resolve(live)
    const loading = this.#loads.get(threadId)
    if (loading !== undefined) return loading
    const load = this.#trackStarting(async () => {
      const stored = await this.#store.resumeThread(threadId)
      if (stored === undefined) return undefined
      if (
        this.#closing ||
        this.#discarding.has(threadId) ||
        this.#closingThreads.has(threadId)
      ) {
        await this.#store.discardThread(threadId)
        if (this.#closing) {
          throw new Error("ThreadManager shut down while resuming a Thread.")
        }
        if (this.#closingThreads.has(threadId)) {
          throw new Error(`Thread ${threadId} was closed while resuming.`)
        }
        throw new Error(`Thread ${threadId} was discarded while resuming.`)
      }
      return this.#installStored(stored)
    }).finally(() => {
      if (this.#loads.get(threadId) === load) this.#loads.delete(threadId)
    })
    this.#loads.set(threadId, load)
    return load
  }

  forkThread(input: ForkThreadInput): Promise<{
    readonly thread: AgentThread
    readonly result: ThreadStoreForkResult
  }> {
    this.#requireOpen()
    return this.#trackStarting(async () => {
      const source = await this.resumeThread(input.sourceThreadId)
      if (source === undefined) {
        throw new Error(`Thread ${input.sourceThreadId} was not found.`)
      }
      const sourceMetadata = source.snapshot().metadata
      const {
        rolloutId: _rolloutId,
        historyBase: _historyBase,
        ...forkableMetadata
      } = sourceMetadata
      const now = new Date().toISOString()
      const target: CreateThreadMetadata = {
        ...forkableMetadata,
        id: createSessionId(),
        createdAt: now,
        updatedAt: now,
        parentThreadId: source.id,
        forkedFromTurnId: input.beforeTurnId,
        ...(input.forkedFromInputId === undefined
          ? {}
          : { forkedFromInputId: input.forkedFromInputId }),
        ...(input.forkReason === undefined
          ? {}
          : { forkReason: input.forkReason }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      const result = await source.withForkBarrier(async () => {
        const prepared = await this.#store.prepareFork({
          sourceThreadId: source.id,
          boundary: { type: "before_turn", turnId: input.beforeTurnId },
        })
        try {
          return await this.#store.createFork({ prepared, target })
        } catch (error) {
          await this.#store.releasePreparedFork(prepared)
          throw error
        }
      })
      if (this.#closing) {
        await this.#store.deleteThread(target.id)
        throw new Error("ThreadManager shut down while forking a Thread.")
      }
      return { thread: await this.#installStored(result.thread), result }
    })
  }

  listThreads(input?: ThreadStoreListInput) {
    return this.#store.listThreads(input)
  }

  readStoredThread(threadId: string): Promise<StoredThread | undefined> {
    return this.#store.readThread(threadId)
  }

  async discardThread(threadId: string): Promise<void> {
    this.#discarding.add(threadId)
    try {
      await this.#loads.get(threadId)?.catch(() => undefined)
      const live = this.#threads.get(threadId)
      if (live !== undefined) {
        await live.shutdownAndWait()
        this.#removeInstalledThread(threadId, live)
      }
      await this.#store.deleteThread(threadId)
    } finally {
      this.#discarding.delete(threadId)
    }
  }

  async closeThread(threadId: string): Promise<boolean> {
    this.#closingThreads.add(threadId)
    try {
      await this.#loads.get(threadId)?.catch(() => undefined)
      const live = this.#threads.get(threadId)
      if (live === undefined)
        return (await this.#store.readThread(threadId)) !== undefined
      await live.shutdownAndWait()
      this.#removeInstalledThread(threadId, live)
      return true
    } finally {
      this.#closingThreads.delete(threadId)
    }
  }

  beginShutdown(): void {
    this.#closing = true
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise
    this.beginShutdown()
    this.#shutdownPromise = this.#finishShutdown()
    return this.#shutdownPromise
  }

  async #finishShutdown(): Promise<void> {
    while (this.#starting.size > 0) {
      await Promise.allSettled([...this.#starting])
    }
    await this.#residencyMaintenance
    const threads = [...this.#threads.values()]
    await Promise.all(threads.map((thread) => thread.shutdownAndWait()))
    for (const thread of threads) this.#removeInstalledThread(thread.id, thread)
  }

  async #installStored(stored: StoredThread): Promise<AgentThread> {
    this.#requireOpen()
    const threadId = stored.metadata.id
    if (this.#discarding.has(threadId)) {
      throw new Error(`Thread ${threadId} is being discarded.`)
    }
    if (this.#closingThreads.has(threadId)) {
      throw new Error(`Thread ${threadId} is being closed.`)
    }
    const existing = this.getThread(threadId)
    if (existing !== undefined) return existing
    let processor: TurnProcessor
    try {
      processor = await this.#createTurnProcessor(stored)
    } catch (error) {
      try {
        await this.#store.discardThread(threadId)
      } catch (discardError) {
        this.#reportBackgroundError(
          discardError,
          threadId,
          "discard-failed-installation",
        )
      }
      throw error
    }
    if (
      this.#closing ||
      this.#discarding.has(threadId) ||
      this.#closingThreads.has(threadId)
    ) {
      await processor.dispose?.()
      this.#requireOpen()
      throw new Error(`Thread ${threadId} cannot be installed.`)
    }
    let thread: AgentThread
    try {
      thread = new AgentThread(
        new Session({
          stored,
          store: this.#store,
          processor,
          ...(this.#onPersistenceError === undefined
            ? {}
            : {
                onPersistenceError: (error) =>
                  this.#onPersistenceError?.(error, threadId),
              }),
        }),
      )
    } catch (error) {
      const cleanup = await Promise.allSettled([
        processor.dispose?.(),
        this.#store.discardThread(threadId),
      ])
      const [disposed, discarded] = cleanup
      if (disposed?.status === "rejected") {
        this.#reportBackgroundError(
          disposed.reason,
          threadId,
          "dispose-failed-installation",
        )
      }
      if (discarded?.status === "rejected") {
        this.#reportBackgroundError(
          discarded.reason,
          threadId,
          "discard-failed-installation",
        )
      }
      throw error
    }
    this.#threads.set(threadId, thread)
    this.#lastUsed.set(threadId, ++this.#useSequence)
    this.#threadStatusSubscriptions.set(
      threadId,
      thread.subscribeStatus((status) => {
        if (this.#threads.get(threadId) !== thread) return
        this.#updateRunningThread(threadId, status === SessionStatus.Active)
        if (status === SessionStatus.Idle && isTerminalAgentThread(thread)) {
          this.#scheduleSubagentEviction(thread)
        }
      }),
    )
    this.#updateRunningThread(threadId, thread.status === SessionStatus.Active)
    void thread.termination.then(
      () => this.#removeInstalledThread(threadId, thread),
      (error: unknown) => {
        this.#removeInstalledThread(threadId, thread)
        this.#reportBackgroundError(error, threadId, "session-termination")
      },
    )
    this.#scheduleSubagentEviction(thread, threadId)
    return thread
  }

  #scheduleSubagentEviction(
    thread: AgentThread,
    protectedThreadId?: string,
  ): void {
    if (this.#closing) return
    const rootThreadId = subagentRootThreadId(thread)
    if (rootThreadId === undefined) return
    const maintenance = this.#residencyMaintenance.then(() =>
      this.#evictIdleSubagents(rootThreadId, protectedThreadId),
    )
    this.#residencyMaintenance = maintenance.catch((error) => {
      this.#reportBackgroundError(error, thread.id, "evict-idle-subagent")
    })
  }

  async #evictIdleSubagents(
    rootThreadId: string,
    protectedThreadId: string | undefined,
  ): Promise<void> {
    const subagents = [...this.#threads.values()].filter(
      (thread) => subagentRootThreadId(thread) === rootThreadId,
    )
    const candidates = [...this.#threads.values()]
      .filter(
        (thread) =>
          thread.id !== protectedThreadId &&
          subagentRootThreadId(thread) === rootThreadId &&
          thread.status === SessionStatus.Idle &&
          isTerminalAgentThread(thread),
      )
      .sort(
        (left, right) =>
          (this.#lastUsed.get(left.id) ?? 0) -
          (this.#lastUsed.get(right.id) ?? 0),
      )
    let residentCount = subagents.length
    for (const candidate of candidates) {
      if (residentCount <= this.#maxResidentSubagentThreads) break
      try {
        await this.closeThread(candidate.id)
        residentCount -= 1
      } catch (error) {
        this.#reportBackgroundError(error, candidate.id, "evict-idle-subagent")
      }
    }
  }

  #removeInstalledThread(threadId: string, thread: AgentThread): void {
    if (this.#threads.get(threadId) !== thread) return
    this.#threads.delete(threadId)
    this.#lastUsed.delete(threadId)
    this.#threadStatusSubscriptions.get(threadId)?.()
    this.#threadStatusSubscriptions.delete(threadId)
    this.#updateRunningThread(threadId, false)
  }

  #updateRunningThread(threadId: string, running: boolean): void {
    const changed = running
      ? !this.#runningThreadIds.has(threadId)
      : this.#runningThreadIds.has(threadId)
    if (!changed) return
    if (running) this.#runningThreadIds.add(threadId)
    else this.#runningThreadIds.delete(threadId)
    const count = this.runningTurnCount
    for (const listener of this.#runningTurnCountListeners) {
      try {
        listener(count)
      } catch (error) {
        this.#reportBackgroundError(
          error,
          threadId,
          "running-turn-count-listener",
        )
      }
    }
  }

  #reportBackgroundError(
    error: unknown,
    threadId: string,
    operation: string,
  ): void {
    try {
      this.#onBackgroundError?.(error, threadId, operation)
    } catch {
      // Observability callbacks cannot break ThreadManager lifecycle.
    }
  }

  #trackStarting<T>(operation: () => Promise<T>): Promise<T> {
    const result = operation()
    this.#starting.add(result)
    void result.then(
      () => this.#starting.delete(result),
      () => this.#starting.delete(result),
    )
    return result
  }

  #requireOpen(): void {
    if (this.#closing) throw new Error("ThreadManager is shut down.")
  }
}

function subagentRootThreadId(thread: AgentThread): string | undefined {
  const agent = thread.snapshot().metadata.metadata?.agent
  if (
    !isRecord(agent) ||
    agent.kind !== "subagent" ||
    typeof agent.rootThreadId !== "string"
  ) {
    return undefined
  }
  return agent.rootThreadId
}

function isTerminalAgentThread(thread: AgentThread): boolean {
  return (
    thread.agentStatus === "interrupted" ||
    typeof thread.agentStatus === "object"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
