import type {
  JsonObject,
  SessionConfigurationSnapshot,
  TokenUsage,
} from "../kernel/events.ts"
import { fingerprintInputAdmission } from "../kernel/operation.ts"
import { InputRole } from "../kernel/events.ts"
import { ContextManager, type ContextSnapshot } from "./context-manager.ts"
import type {
  ResponseItemEnvelope,
  RolloutItem,
  StoredThread,
  ThreadMetadata,
  TurnContextItem,
} from "./rollout.ts"
import {
  AsyncQueue,
  BoundedQueue,
  type NotSubmittedReason,
  NotSubmittedReason as Reason,
  type SessionEvent,
  type SessionPermissionEvent,
  SessionIo,
  type SessionOp,
  SessionStatus,
  type TurnInput,
  type TurnInputSubmission,
} from "./session-io.ts"
import { PersistContext, type ThreadStore } from "./thread-store.ts"

const submissionCapacity = 512
const gracefulInterruptionTimeoutMs = 100

export type SessionSnapshot = {
  readonly metadata: ThreadMetadata
  readonly context: ContextSnapshot
  readonly configuration?: SessionConfigurationSnapshot
  readonly activeTurnId?: string
}

export type TurnControl = {
  readonly signal: AbortSignal
  takeSteering(): readonly TurnInput[]
  takeSteeringOrComplete():
    | { readonly type: "steering"; readonly inputs: readonly TurnInput[] }
    | { readonly type: "complete" }
}

export type TurnRuntime = {
  snapshot(): SessionSnapshot
  recordUsage(usage: TokenUsage): void
  emitModelStream(input: {
    readonly itemId: string
    readonly kind: "assistant" | "reasoning"
    readonly text: string
  }): void
  emitPermissionEvent(event: SessionPermissionEvent): void
  recordConversationItems(items: readonly ResponseItemEnvelope[]): Promise<void>
  recordWorldStateUpdate(
    items: readonly ResponseItemEnvelope[],
    state: JsonObject,
  ): Promise<void>
  replaceConversationHistory(input: {
    readonly replacement: readonly ResponseItemEnvelope[]
    readonly summary: string
  }): Promise<void>
  recordWorldState(state: JsonObject): Promise<void>
}

export type TurnProcessor = {
  prepare(snapshot: SessionSnapshot, input: TurnInput): TurnContextItem
  prepareSteering?(
    snapshot: SessionSnapshot,
    input: TurnInput,
  ): SessionConfigurationSnapshot | undefined
  start(
    runtime: TurnRuntime,
    input: TurnInput,
    context: TurnContextItem,
    control: TurnControl,
  ): TurnTask
}

// The processor owns effects outside Session state, so cancellation must stop
// the underlying task rather than only detach its Promise from the Session.
export type TurnTask = {
  readonly completion: Promise<void>
  abort(): void
}

type ActiveTurn = {
  readonly input: TurnInput
  readonly context: TurnContextItem
  readonly abort: AbortController
  readonly steering: TurnInput[]
  acceptingSteering: boolean
  usage: TokenUsage | undefined
  readonly resolveAbort: () => void
  taskHandle: TurnTask | undefined
  task: Promise<void>
  interruptReason: string | undefined
}

type ForkBarrierCommand = {
  readonly type: "fork_barrier"
  readonly run: (snapshot: SessionSnapshot) => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

type SessionCommand = SessionOp | ForkBarrierCommand

export class Session {
  readonly id: string
  readonly io: SessionIo
  readonly #metadata: ThreadMetadata
  readonly #contextManager: ContextManager
  #configuration: SessionConfigurationSnapshot | undefined
  readonly #submittedTurns = new Map<
    string,
    { readonly fingerprint: string; readonly inputItemId: string }
  >()
  readonly #store: ThreadStore
  readonly #processor: TurnProcessor
  readonly #submissions = new BoundedQueue<SessionCommand>(submissionCapacity)
  readonly #events = new AsyncQueue<SessionEvent>()
  readonly #statusListeners = new Set<(status: SessionStatus) => void>()
  readonly #onPersistenceError?: ((error: unknown) => void) | undefined
  #status: SessionStatus = SessionStatus.Idle
  #activeTurn: ActiveTurn | undefined
  #closing = false
  readonly #submissionLoop: Promise<void>

  constructor(input: {
    stored: StoredThread
    store: ThreadStore
    processor: TurnProcessor
    onPersistenceError?: (error: unknown) => void
  }) {
    this.id = input.stored.metadata.id
    this.#metadata = structuredClone(input.stored.metadata)
    this.#contextManager = ContextManager.fromStoredThread(input.stored)
    this.#configuration = latestConfiguration(input.stored)
    for (const record of input.stored.rollout) {
      if (
        record.item.type === "turn_started" &&
        record.item.requestFingerprint !== undefined
      ) {
        this.#submittedTurns.set(record.item.turnId, {
          fingerprint: record.item.requestFingerprint,
          inputItemId: record.item.inputItemId,
        })
      }
    }
    this.#store = input.store
    this.#processor = input.processor
    this.#onPersistenceError = input.onPersistenceError
    this.#submissionLoop = this.#runSubmissionLoop()
    this.io = new SessionIo({
      send: (operation) => this.#submissions.send(operation),
      beforeShutdown: () => {
        this.#closing = true
      },
      events: this.#events,
      readStatus: () => this.#status,
      subscribeStatus: (listener) => {
        this.#statusListeners.add(listener)
        return () => this.#statusListeners.delete(listener)
      },
      termination: this.#submissionLoop,
    })
  }

  snapshot(): SessionSnapshot {
    return {
      metadata: structuredClone(this.#metadata),
      context: this.#contextManager.snapshot(),
      ...(this.#configuration === undefined
        ? {}
        : { configuration: structuredClone(this.#configuration) }),
      ...(this.#activeTurn === undefined
        ? {}
        : { activeTurnId: this.#activeTurn.input.submissionId }),
    }
  }

  withForkBarrier<T>(
    run: (snapshot: SessionSnapshot) => Promise<T>,
  ): Promise<T> {
    if (this.#closing)
      return Promise.reject(new Error("Session is shutting down."))
    return new Promise<T>((resolve, reject) => {
      void this.#submissions
        .send({
          type: "fork_barrier",
          run,
          resolve: (value) => resolve(value as T),
          reject,
        })
        .catch(reject)
    })
  }

  async #runSubmissionLoop(): Promise<void> {
    try {
      for (;;) {
        const operation = await this.#submissions.receive()
        if (operation === undefined) break
        if (operation.type === "shutdown") {
          this.#submissions.close()
          this.#interruptActiveTurn("shutdown")
          break
        }
        if (operation.type === "fork_barrier") {
          await this.#runForkBarrier(operation)
          continue
        }
        await this.#dispatch(operation)
      }
      await this.#activeTurn?.task.catch(() => undefined)
    } finally {
      try {
        await this.#shutdownPersistence()
      } finally {
        this.#setStatus(SessionStatus.Shutdown)
        this.#events.close()
        this.#submissions.close()
      }
    }
  }

  async #dispatch(
    operation: Exclude<SessionOp, { readonly type: "shutdown" }>,
  ): Promise<void> {
    if (operation.type === "interrupt") {
      if (
        operation.expectedTurnId !== undefined &&
        this.#activeTurn?.input.submissionId !== operation.expectedTurnId
      ) {
        operation.reply?.resolve(false)
        return
      }
      this.#interruptActiveTurn(operation.reason ?? "interrupted")
      operation.reply?.resolve(true)
      return
    }
    try {
      operation.reply.resolve(
        await this.#routeTurnInput(operation.input, operation.mode),
      )
    } catch (error) {
      operation.reply.reject(error)
    }
  }

  async #routeTurnInput(
    input: TurnInput,
    mode: Extract<SessionOp, { readonly type: "turn_input" }>["mode"],
  ): Promise<TurnInputSubmission> {
    const fingerprint = turnInputFingerprint(input)
    const submitted = this.#submittedTurns.get(input.submissionId)
    if (submitted !== undefined) {
      if (submitted.fingerprint !== fingerprint) {
        return notSubmitted(Reason.RequestConflict)
      }
      return {
        type: "replayed",
        turnId: input.submissionId,
        inputItemId: submitted.inputItemId,
      }
    }
    const active = this.#activeTurn
    if (mode.type === "start_if_idle") {
      return active === undefined
        ? this.#startTurn(input)
        : notSubmitted(Reason.NotIdle)
    }
    if (mode.type === "start_or_steer") {
      if (active === undefined) return this.#startTurn(input)
      if (!active.acceptingSteering) return notSubmitted(Reason.NotIdle)
      await this.#acceptSteering(active, input)
      return { type: "steered", turnId: active.input.submissionId }
    }
    if (active === undefined || !active.acceptingSteering) {
      return notSubmitted(Reason.NoActiveTurn)
    }
    if (active.input.submissionId !== mode.expectedTurnId) {
      return notSubmitted(Reason.TurnMismatch)
    }
    await this.#acceptSteering(active, input)
    return { type: "steered", turnId: active.input.submissionId }
  }

  async #acceptSteering(active: ActiveTurn, input: TurnInput): Promise<void> {
    const configuration =
      input.modelSelection === undefined
        ? undefined
        : this.#processor.prepareSteering?.(this.snapshot(), input)
    if (input.modelSelection !== undefined && configuration === undefined) {
      throw new Error("Turn processor does not support steering settings.")
    }
    active.steering.push(input)
    if (configuration === undefined) return
    const selection = input.modelSelection
    if (selection === undefined) {
      throw new Error("Steering configuration requires a model selection.")
    }
    this.#configuration = structuredClone(configuration)
    await this.#appendRollout([
      {
        type: "turn_context",
        context: {
          turnId: input.submissionId,
          configuration,
          selection,
        },
      },
    ])
  }

  async #startTurn(input: TurnInput): Promise<TurnInputSubmission> {
    const context = this.#processor.prepare(this.snapshot(), input)
    if (context.turnId !== input.submissionId) {
      throw new Error("Turn processor prepared a mismatched Turn id.")
    }
    this.#configuration = structuredClone(context.configuration)
    const inputItem: ResponseItemEnvelope = {
      id: `input_${globalThis.crypto.randomUUID()}`,
      turnId: input.submissionId,
      createdAt: new Date().toISOString(),
      item: {
        role: "user",
        content:
          input.content.text.length === 0
            ? []
            : [{ type: "text", text: input.content.text }],
        ...(input.content.attachments === undefined ||
        input.content.attachments.length === 0
          ? {}
          : {
              images: input.content.attachments.map((attachment) => ({
                type: "image" as const,
                mediaType: attachment.mediaType,
                detail: attachment.detail ?? "high",
                file: attachment.file,
                sizeBytes: attachment.sizeBytes,
              })),
            }),
      },
      ...turnInputSubmissionMetadata(input),
    }
    const requestFingerprint = turnInputFingerprint(input)
    this.#submittedTurns.set(input.submissionId, {
      fingerprint: requestFingerprint,
      inputItemId: inputItem.id,
    })
    this.#contextManager.record([inputItem])
    try {
      await this.#appendRollout([
        { type: "response_item", item: inputItem },
        { type: "turn_context", context },
        {
          type: "turn_started",
          turnId: input.submissionId,
          inputItemId: inputItem.id,
          requestFingerprint,
        },
      ])
      await this.#persist(PersistContext.TurnStart)
    } catch (error) {
      this.#submittedTurns.delete(input.submissionId)
      throw error
    }

    const abort = new AbortController()
    const aborted = deferred<void>()
    const active: ActiveTurn = {
      input,
      context,
      abort,
      steering: [],
      acceptingSteering: true,
      usage: undefined,
      resolveAbort: () => aborted.resolve(),
      taskHandle: undefined,
      task: Promise.resolve(),
      interruptReason: undefined,
    }
    this.#activeTurn = active
    this.#setStatus(SessionStatus.Active)
    this.#events.send({ type: "turn.started", threadId: this.id, input })

    let taskHandle: TurnTask
    try {
      taskHandle = this.#processor.start(
        this.#turnRuntime(active),
        input,
        context,
        {
          signal: abort.signal,
          takeSteering: () => active.steering.splice(0),
          takeSteeringOrComplete: () => {
            const inputs = active.steering.splice(0)
            if (inputs.length > 0) return { type: "steering", inputs }
            active.acceptingSteering = false
            return { type: "complete" }
          },
        },
      )
    } catch (error) {
      taskHandle = {
        completion: Promise.reject(error),
        abort() {},
      }
    }
    active.taskHandle = taskHandle
    const processorTask = taskHandle.completion
    let processorSettled = false
    const settled = processorTask
      .then(
        () =>
          abort.signal.aborted
            ? { type: "interrupted" as const }
            : { type: "completed" as const },
        (error: unknown) =>
          abort.signal.aborted
            ? { type: "interrupted" as const }
            : { type: "failed" as const, error },
      )
      .finally(() => {
        processorSettled = true
      })
    const outcome = Promise.race([
      settled,
      aborted.promise.then(async () => {
        await Promise.race([
          processorTask.catch(() => undefined),
          delay(gracefulInterruptionTimeoutMs),
        ])
        if (!processorSettled) {
          try {
            active.taskHandle?.abort()
          } catch (error) {
            this.#events.send({
              type: "session.error",
              threadId: this.id,
              operation: "interrupt",
              message:
                error instanceof Error
                  ? error.message
                  : "Turn hard abort failed.",
            })
          }
        }
        return { type: "interrupted" as const }
      }),
    ])
    void processorTask.catch(() => undefined)
    active.task = outcome.then((result) => this.#finishTurn(active, result))
    return { type: "started", turnId: input.submissionId }
  }

  async #finishTurn(
    active: ActiveTurn,
    outcome:
      | { readonly type: "completed" }
      | { readonly type: "interrupted" }
      | { readonly type: "failed"; readonly error: unknown },
  ): Promise<void> {
    if (this.#activeTurn !== active) return
    active.acceptingSteering = false

    if (outcome.type === "interrupted") {
      await this.#appendRollout([
        {
          type: "turn_completed",
          turnId: active.input.submissionId,
          outcome: "interrupted",
          ...(active.usage === undefined ? {} : { usage: active.usage }),
        },
      ])
      await this.#flushRollout()
      this.#events.send({
        type: "turn.interrupted",
        threadId: this.id,
        input: active.input,
        ...(active.interruptReason === undefined
          ? {}
          : { reason: active.interruptReason }),
      })
      this.#releaseTurn(active)
      return
    }

    if (outcome.type === "failed") {
      const message =
        outcome.error instanceof Error
          ? outcome.error.message
          : "Turn execution failed."
      await this.#appendRollout([
        {
          type: "turn_completed",
          turnId: active.input.submissionId,
          outcome: "failed",
          ...(active.usage === undefined ? {} : { usage: active.usage }),
          error: { message },
        },
      ])
      await this.#flushRollout()
      this.#events.send({
        type: "session.error",
        threadId: this.id,
        operation: "turn_input",
        message,
      })
      this.#releaseTurn(active)
      return
    }

    await this.#appendRollout([
      {
        type: "turn_completed",
        turnId: active.input.submissionId,
        outcome: "completed",
        ...(active.usage === undefined ? {} : { usage: active.usage }),
      },
    ])
    await this.#flushRollout()
    this.#events.send({
      type: "turn.completed",
      threadId: this.id,
      input: active.input,
    })
    this.#releaseTurn(active)
  }

  #releaseTurn(active: ActiveTurn): void {
    if (this.#activeTurn !== active) return
    this.#activeTurn = undefined
    if (!this.#closing) this.#setStatus(SessionStatus.Idle)
  }

  #interruptActiveTurn(reason: string): void {
    if (this.#activeTurn === undefined) return
    this.#activeTurn.interruptReason = reason
    this.#activeTurn.acceptingSteering = false
    this.#activeTurn.abort.abort()
    this.#activeTurn.resolveAbort()
  }

  #turnRuntime(active: ActiveTurn): TurnRuntime {
    const requireActive = () => {
      if (this.#activeTurn !== active) {
        throw new Error("Turn is no longer active.")
      }
    }
    const requireLease = () => {
      requireActive()
      if (active.abort.signal.aborted) {
        throw new Error("Turn is no longer active.")
      }
    }
    return {
      snapshot: () => {
        requireLease()
        return this.snapshot()
      },
      recordUsage: (usage) => {
        requireActive()
        active.usage = structuredClone(usage)
      },
      emitModelStream: (input) => {
        requireLease()
        this.#events.send({
          type: "model.stream",
          threadId: this.id,
          turnId: active.input.submissionId,
          ...input,
        })
      },
      emitPermissionEvent: (event) => {
        requireActive()
        if (
          event.sessionId !== this.id ||
          event.turnId !== active.input.submissionId
        ) {
          throw new Error(
            "Permission event does not belong to the active Turn.",
          )
        }
        this.#events.send({
          type: "permission",
          threadId: this.id,
          event: structuredClone(event),
        })
      },
      recordConversationItems: async (items) => {
        requireLease()
        if (items.length === 0) return
        this.#contextManager.record(items)
        await this.#appendRollout(
          items.map((item): RolloutItem => ({ type: "response_item", item })),
        )
      },
      recordWorldStateUpdate: async (items, state) => {
        requireLease()
        if (items.length > 0) this.#contextManager.record(items)
        this.#contextManager.setWorldStateBaseline(state)
        await this.#appendRollout([
          ...items.map(
            (item): RolloutItem => ({ type: "response_item", item }),
          ),
          {
            type: "world_state",
            turnId: active.input.submissionId,
            state,
          },
        ])
      },
      replaceConversationHistory: async (input) => {
        requireLease()
        this.#contextManager.replace(input.replacement)
        await this.#appendRollout([
          {
            type: "compacted",
            turnId: active.input.submissionId,
            ...input,
          },
        ])
      },
      recordWorldState: async (state) => {
        requireLease()
        this.#contextManager.setWorldStateBaseline(state)
        await this.#appendRollout([
          {
            type: "world_state",
            turnId: active.input.submissionId,
            state,
          },
        ])
      },
    }
  }

  async #runForkBarrier(operation: ForkBarrierCommand): Promise<void> {
    try {
      this.#interruptActiveTurn("conversation_fork")
      await this.#activeTurn?.task.catch(() => undefined)
      await this.#store.flushThread(this.id)
      operation.resolve(await operation.run(this.snapshot()))
    } catch (error) {
      operation.reject(error)
    }
  }

  async #appendRollout(items: readonly RolloutItem[]): Promise<void> {
    try {
      const throughSeq = await this.#store.appendItems(this.id, items)
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        throughSeq,
        items: structuredClone(items),
      })
    } catch (error) {
      this.#reportPersistenceError(error)
    }
  }

  async #persist(context: PersistContext): Promise<void> {
    try {
      await this.#store.persistThread(this.id, context)
    } catch (error) {
      this.#reportPersistenceError(error)
    }
  }

  async #flushRollout(): Promise<void> {
    try {
      await this.#store.flushThread(this.id)
    } catch (error) {
      this.#reportPersistenceError(error)
    }
  }

  async #shutdownPersistence(): Promise<void> {
    try {
      await this.#store.flushThread(this.id)
    } catch (error) {
      this.#reportPersistenceError(error)
    }
    try {
      await this.#store.shutdownThread(this.id)
    } catch (error) {
      this.#reportPersistenceError(error)
    }
  }

  #reportPersistenceError(error: unknown): void {
    try {
      this.#onPersistenceError?.(error)
    } catch {
      // Observability callbacks cannot break Session lifecycle.
    }
    this.#events.send({
      type: "session.error",
      threadId: this.id,
      operation: "persistence",
      message:
        error instanceof Error ? error.message : "Thread persistence failed.",
    })
  }

  #setStatus(status: SessionStatus): void {
    if (this.#status === status) return
    this.#status = status
    for (const listener of this.#statusListeners) {
      queueMicrotask(() => {
        try {
          listener(status)
        } catch {
          // A watch subscriber cannot break Session lifecycle transitions.
        }
      })
    }
  }
}

function turnInputFingerprint(input: TurnInput): string {
  return fingerprintInputAdmission({
    role: InputRole.User,
    content: input.content,
    ...(input.modelSelection === undefined
      ? {}
      : { modelSelection: input.modelSelection }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.parentInputId === undefined
      ? {}
      : { parentInputId: input.parentInputId }),
  })
}

function turnInputSubmissionMetadata(
  input: TurnInput,
): Pick<ResponseItemEnvelope, "submissionMetadata"> | undefined {
  if (
    input.modelSelection === undefined &&
    input.parentInputId === undefined &&
    input.metadata === undefined
  ) {
    return undefined
  }
  return {
    submissionMetadata: {
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(input.parentInputId === undefined
        ? {}
        : { parentInputId: input.parentInputId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  }
}

function notSubmitted(reason: NotSubmittedReason): TurnInputSubmission {
  return { type: "not_submitted", reason }
}

function latestConfiguration(
  stored: StoredThread,
): SessionConfigurationSnapshot | undefined {
  for (let index = stored.rollout.length - 1; index >= 0; index -= 1) {
    const item = stored.rollout[index]?.item
    if (item?.type === "turn_context") {
      return structuredClone(item.context.configuration)
    }
  }
  return undefined
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
