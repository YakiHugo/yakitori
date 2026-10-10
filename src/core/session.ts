import { inputContentToModelMessage } from "../core/user-input.ts"
import { kernelErrorFromUnknown } from "../kernel/errors.ts"
import type {
  CompletedExecutionItem,
  JsonObject,
  KernelError,
  SessionConfigurationSnapshot,
  StartedExecutionItem,
  TokenUsage,
  ToolExecutionItem,
  TurnCompletion,
  TurnMetrics,
} from "../kernel/events.ts"
import { createInputId, createTurnId } from "../kernel/ids.ts"
import { ContextManager, type ContextSnapshot } from "./context-manager.ts"
import type {
  ModelAttemptRecord,
  ModelContextSettings,
  ResponseItemEnvelope,
  RolloutItem,
  StoredThread,
  ThreadMetadata,
  TurnContextItem,
} from "./rollout.ts"
import {
  type AgentStatus,
  AsyncQueue,
  BoundedQueue,
  fingerprintTurnInput,
  type NotSubmittedReason,
  NotSubmittedReason as Reason,
  type SessionEvent,
  type SessionIdleCause,
  SessionIo,
  type SessionOp,
  type SessionPermissionEvent,
  SessionStatus,
  type TurnInput,
  type TurnInputSubmission,
} from "./session-io.ts"
import {
  PersistContext,
  type RolloutAppend,
  type SessionRolloutStore,
} from "./thread-store.ts"
import { createUserInput, inputContentFromModelMessage } from "./user-input.ts"

export type { TurnCompletion } from "../kernel/events.ts"

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
  recordModelAttempt(attempt: ModelAttemptRecord): Promise<void>
  recordInitialInput(): Promise<void>
  recordModelContext(settings: ModelContextSettings): Promise<void>
  snapshot(): SessionSnapshot
  recordUsage(usage: TokenUsage): Promise<void>
  recordRequestStartedAt(startedAt: number): void
  invalidateRequestStartedAt(): void
  recordTurnMetrics(metrics: TurnMetrics): void
  recordContextTokens(
    input: Readonly<{
      activeContextTokens: number
      inputTokens?: number
      estimatedPrefill?: boolean
      capacityTokens?: number
      historyAnchorItemId: string
      historyAnchorTokens?: number
      provider: string
      model: string
    }>,
  ): Promise<void>
  emitModelStream(input: {
    readonly itemId: string
    readonly kind: "assistant" | "reasoning"
    readonly delta: string
  }): void
  emitWarning(message: string, diagnostic?: KernelError): void
  emitItemStarted(item: StartedExecutionItem): void
  recordToolStarted(item: ToolExecutionItem): Promise<void>
  emitPermissionEvent(event: SessionPermissionEvent): void
  recordConversationItems(items: readonly ResponseItemEnvelope[]): Promise<void>
  recordItemCompletions(items: readonly CompletedExecutionItem[]): Promise<void>
  recordToolResult(
    response: ResponseItemEnvelope,
    completion: Extract<CompletedExecutionItem, { toolCallId: string }>,
  ): Promise<void>
  recordWorldStateUpdate(
    items: readonly ResponseItemEnvelope[],
    update: Readonly<{
      full: boolean
      state: JsonObject
      snapshot: JsonObject
    }>,
  ): Promise<void>
  replaceConversationHistory(input: {
    readonly replacement: readonly ResponseItemEnvelope[]
    readonly summary: string
    readonly baseHistoryLength: number
    readonly expectedPrefix?: readonly ResponseItemEnvelope[]
    readonly worldState?: Readonly<{ state: JsonObject; snapshot: JsonObject }>
  }): Promise<boolean>
}

export type TurnProcessor = {
  prepare(
    snapshot: SessionSnapshot,
    input: TurnInput,
  ): TurnContextItem | Promise<TurnContextItem>
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
  dispose?(): void | Promise<void>
}

// The processor owns effects outside Session state, so cancellation must stop
// the underlying task rather than only detach its Promise from the Session.
export type TurnTask = {
  // biome-ignore lint/suspicious/noConfusingVoidType: Tasks such as manual compaction return no completion metadata.
  readonly completion: Promise<TurnCompletion | void>
  abort(): void
}

type ActiveTurn = {
  readonly input: TurnInput
  readonly inputItem: ResponseItemEnvelope
  inputRecorded: boolean
  // Compaction can replace model history before a continued answer finishes.
  assistantItems: ResponseItemEnvelope[]
  readonly context: TurnContextItem
  readonly abort: AbortController
  readonly steering: TurnInput[]
  readonly steeringFingerprints: Map<string, string>
  acceptingSteering: boolean
  finishing: boolean
  usage: TokenUsage | undefined
  lastRequestStartedAt: string | undefined
  metrics: TurnMetrics | undefined
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

type AcceptedAgentMessage = {
  readonly envelope: ResponseItemEnvelope
  readonly items: readonly RolloutItem[]
  append?: RolloutAppend
}

type PendingTurnStart = {
  readonly input: TurnInput
  readonly context: TurnContextItem
  readonly inputItem: ResponseItemEnvelope
  readonly items: readonly RolloutItem[]
  readonly requestFingerprint: string
  append?: RolloutAppend
}

export class Session {
  readonly id: string
  readonly io: SessionIo
  readonly #metadata: ThreadMetadata
  readonly #contextManager: ContextManager
  #configuration: SessionConfigurationSnapshot | undefined
  readonly #submittedInputs = new Map<
    string,
    Readonly<{
      fingerprint: string | undefined
      restoredFingerprint?: string
      inputItemId: string
      turnId: string
    }>
  >()
  #pendingTurnStart: PendingTurnStart | undefined
  // Resolves when the pending Turn's recording has either launched or failed,
  // so barrier operations (fork) can wait out the recording instead of
  // racing it.
  #pendingTurnReady: Promise<void> | undefined
  readonly #store: SessionRolloutStore
  readonly #processor: TurnProcessor
  readonly #submissions = new BoundedQueue<SessionCommand>(submissionCapacity)
  readonly #events = new AsyncQueue<SessionEvent>()
  readonly #statusListeners = new Set<
    (status: SessionStatus, idleCause?: SessionIdleCause) => void
  >()
  readonly #agentStatusListeners = new Set<(status: AgentStatus) => void>()
  readonly #receivedAgentMessageIds = new Set<string>()
  readonly #acceptedAgentMessages = new Map<string, AcceptedAgentMessage>()
  #contextMutationTail = Promise.resolve()
  readonly #onPersistenceError?: ((error: unknown) => void) | undefined
  #status: SessionStatus = SessionStatus.Idle
  #agentStatus: AgentStatus
  #activeTurn: ActiveTurn | undefined
  #closing = false
  readonly #submissionLoop: Promise<void>

  constructor(input: {
    stored: StoredThread
    store: SessionRolloutStore
    processor: TurnProcessor
    onPersistenceError?: (error: unknown) => void
  }) {
    this.id = input.stored.metadata.id
    this.#metadata = structuredClone(input.stored.metadata)
    this.#contextManager = ContextManager.fromStoredThread(input.stored)
    this.#configuration = latestConfiguration(input.stored)
    this.#agentStatus = agentStatusFromStoredThread(input.stored)
    const recordedInputs = new Map(
      input.stored.rollout.flatMap((record) =>
        record.item.type === "response_item"
          ? [[record.item.item.id, record.item.item] as const]
          : [],
      ),
    )
    let recordedTurnId: string | undefined
    for (const record of input.stored.rollout) {
      if (record.item.type === "agent_message") {
        this.#receivedAgentMessageIds.add(record.item.messageId)
      }
      if (record.item.type === "turn_started")
        recordedTurnId = record.item.turnId
      if (record.item.type === "response_item")
        this.#rememberRecordedSteer(
          record.item.item,
          recordedTurnId ?? record.item.item.turnId,
        )
      if (record.item.type === "turn_started") {
        const recorded = recordedInputs.get(record.item.inputItemId)
        const restoredFingerprint =
          recorded === undefined || record.item.requestFingerprint === undefined
            ? undefined
            : recordedInputFingerprint(recorded, record.item.requestFingerprint)
        this.#submittedInputs.set(record.item.turnId, {
          fingerprint: record.item.requestFingerprint,
          ...(restoredFingerprint === undefined ? {} : { restoredFingerprint }),
          inputItemId: record.item.inputItemId,
          turnId: record.item.turnId,
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
      readAgentStatus: () => this.#agentStatus,
      subscribeAgentStatus: (listener) => {
        this.#agentStatusListeners.add(listener)
        return () => this.#agentStatusListeners.delete(listener)
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
      // The acknowledged Turn owns a persistence task before its processor
      // task exists. Wait for that fence before disposing the processor and
      // closing its writer.
      await this.#pendingTurnReady
      await this.#activeTurn?.task.catch(() => undefined)
    } finally {
      try {
        await this.#processor.dispose?.()
      } finally {
        try {
          await this.#shutdownPersistence()
        } finally {
          this.#setStatus(SessionStatus.Shutdown)
          this.#setAgentStatus("shutdown")
          this.#events.close()
          this.#submissions.close()
        }
      }
    }
  }

  async #dispatch(
    operation: Exclude<SessionOp, { readonly type: "shutdown" }>,
  ): Promise<void> {
    if (operation.type === "compact") {
      try {
        operation.reply.resolve(
          await this.#routeTurnInput(
            {
              submissionId: operation.requestId,
              content: createUserInput("/compact"),
              manualCompact: true,
            },
            { type: "start_if_idle" },
          ),
        )
      } catch (error) {
        operation.reply.reject(error)
      }
      return
    }
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
    if (operation.type === "fail_agent") {
      try {
        if (this.#pendingTurnStart !== undefined)
          throw new Error("The previous Turn must be persisted first.")
        if (this.#activeTurn === undefined) {
          await this.#recordAgentFailure(operation.message)
        }
        operation.reply.resolve(this.#agentStatus)
      } catch (error) {
        operation.reply.reject(error)
      }
      return
    }
    if (operation.type === "agent_message") {
      try {
        if (this.#pendingTurnStart !== undefined)
          throw new Error("The previous Turn must be persisted first.")
        await this.#recordAgentMessage(operation.messageId, operation.text)
        operation.reply.resolve()
      } catch (error) {
        operation.reply.reject(error)
      }
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

  #rememberRecordedSteer(item: ResponseItemEnvelope, turnId: string): void {
    if (
      !item.id.startsWith("message_") ||
      item.item.role !== "user" ||
      item.item.context !== undefined
    )
      return
    // Older steering envelopes identify their request but did not persist its
    // fingerprint; reserve that ID and report a conflict rather than guessing
    // intent from lossy legacy model content and repeating its effects.
    const restoredFingerprint =
      item.submissionMetadata?.requestFingerprint === undefined
        ? undefined
        : recordedInputFingerprint(
            item,
            item.submissionMetadata.requestFingerprint,
          )
    this.#submittedInputs.set(item.turnId, {
      fingerprint: item.submissionMetadata?.requestFingerprint,
      ...(restoredFingerprint === undefined ? {} : { restoredFingerprint }),
      inputItemId: item.id,
      turnId,
    })
  }

  async #routeTurnInput(
    input: TurnInput,
    mode: Extract<SessionOp, { readonly type: "turn_input" }>["mode"],
  ): Promise<TurnInputSubmission> {
    const fingerprint = fingerprintTurnInput(input)
    const submitted = this.#submittedInputs.get(input.submissionId)
    if (submitted !== undefined) {
      if (
        submitted.fingerprint !== fingerprint &&
        (submitted.restoredFingerprint === undefined ||
          submitted.restoredFingerprint !== restoredInputFingerprint(input))
      ) {
        return notSubmitted(Reason.RequestConflict)
      }
      return {
        type: "replayed",
        turnId: submitted.turnId,
        inputItemId: submitted.inputItemId,
      }
    }
    const active = this.#activeTurn
    if (mode.type === "start_if_idle") {
      return active === undefined
        ? this.#startTurn(input)
        : notSubmitted(Reason.NotIdle)
    }
    if (active === undefined || !active.acceptingSteering) {
      return notSubmitted(Reason.NoActiveTurn)
    }
    if (active.input.submissionId !== mode.expectedTurnId) {
      return notSubmitted(Reason.TurnMismatch)
    }
    const previousSteering = active.steeringFingerprints.get(input.submissionId)
    if (previousSteering !== undefined) {
      return previousSteering === fingerprint
        ? { type: "steered", turnId: active.input.submissionId }
        : notSubmitted(Reason.RequestConflict)
    }
    await this.#acceptSteering(active, input)
    active.steeringFingerprints.set(input.submissionId, fingerprint)
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

  // The admission decision happens here, on the actor: prepare the batch,
  // register the dedupe entry, and establish the active Turn so follow-up
  // commands (steer, interrupt, shutdown) see it synchronously. Durability
  // continues in the background (Codex: ack at the routing decision, record
  // in the run task). Accepted input materializes the new rollout before
  // sampling; a blocked prompt leaves the staged Session unmaterialized.
  async #startTurn(input: TurnInput): Promise<TurnInputSubmission> {
    let context: TurnContextItem
    try {
      context = await this.#processor.prepare(this.snapshot(), input)
    } catch (error) {
      await this.#recordAgentFailure(
        error instanceof Error ? error.message : "Turn preparation failed.",
      )
      throw error
    }
    if (context.turnId !== input.submissionId) {
      throw new Error("Turn processor prepared a mismatched Turn id.")
    }
    this.#configuration = structuredClone(context.configuration)
    const inputItem = buildInputItem(input)
    const requestFingerprint = fingerprintTurnInput(input)
    const items: readonly RolloutItem[] = [
      {
        type: "turn_started",
        turnId: input.submissionId,
        inputItemId: inputItem.id,
        requestFingerprint,
      },
      { type: "turn_context", context },
    ]
    const pending: PendingTurnStart = {
      input,
      context,
      inputItem,
      items,
      requestFingerprint,
    }
    this.#pendingTurnStart = pending
    this.#submittedInputs.set(input.submissionId, {
      fingerprint: requestFingerprint,
      inputItemId: inputItem.id,
      turnId: input.submissionId,
    })
    const abort = new AbortController()
    const aborted = deferred<void>()
    const active: ActiveTurn = {
      finishing: false,
      input,
      inputItem,
      inputRecorded: false,
      assistantItems: [],
      context,
      abort,
      steering: [],
      steeringFingerprints: new Map(),
      acceptingSteering: true,
      usage: undefined,
      lastRequestStartedAt: undefined,
      metrics: undefined,
      resolveAbort: () => aborted.resolve(),
      taskHandle: undefined,
      task: Promise.resolve(),
      interruptReason: undefined,
    }
    this.#activeTurn = active
    this.#setStatus(SessionStatus.Active)
    this.#setAgentStatus("running")
    this.#events.send({ type: "turn.started", threadId: this.id, input })
    const launch = (async () => {
      try {
        await this.#persistAndLaunchTurn(pending, active, aborted.promise)
      } catch (error) {
        await this.#failPendingTurn(pending, active, error)
      }
    })().catch((error: unknown) => {
      this.#reportPersistenceError(error)
    })
    const ready = launch.finally(() => {
      if (this.#pendingTurnReady === ready) this.#pendingTurnReady = undefined
    })
    this.#pendingTurnReady = ready
    return {
      type: "started",
      turnId: input.submissionId,
      inputItemId: inputItem.id,
    }
  }

  async #persistAndLaunchTurn(
    pending: PendingTurnStart,
    active: ActiveTurn,
    aborted: Promise<void>,
  ): Promise<void> {
    const input = pending.input
    try {
      pending.append = await this.#store.appendItems(this.id, pending.items)
    } catch {
      // A rejected append may already have queued or written the batch. Drain
      // and inspect it before deciding whether to append again.
      try {
        await this.#store.flushThread(this.id)
        const rollout = (await this.#store.readThread(this.id))?.rollout ?? []
        const start = rollout.find(
          (entry) =>
            entry.item.type === "turn_started" &&
            entry.item.turnId === input.submissionId &&
            entry.item.inputItemId === pending.inputItem.id,
        )
        if (start !== undefined) {
          const inputRecord = rollout.find(
            (entry) =>
              entry.item.type === "response_item" &&
              entry.item.item.id === pending.inputItem.id,
          )
          const contextRecord = rollout.find(
            (entry) =>
              entry.item.type === "turn_context" &&
              entry.item.context.turnId === input.submissionId,
          )
          if (inputRecord !== undefined || contextRecord?.seq !== start.seq + 1)
            throw new Error("The pending Turn has incomplete stored start.")
          pending.append = {
            throughSeq: contextRecord.seq + 1,
            records: [start, contextRecord],
          }
        } else {
          const inputPresent = rollout.some(
            (entry) =>
              entry.item.type === "response_item" &&
              entry.item.item.id === pending.inputItem.id,
          )
          const contextPresent = rollout.some(
            (entry) =>
              entry.item.type === "turn_context" &&
              entry.item.context.turnId === input.submissionId,
          )
          const partial = inputPresent || contextPresent
          if (partial)
            throw new Error("The pending Turn has incomplete stored start.")
          pending.append = await this.#store.appendItems(this.id, pending.items)
        }
      } catch (error) {
        this.#reportPersistenceError(error)
        throw error
      }
    }
    if (this.#pendingTurnStart === pending) this.#pendingTurnStart = undefined
    if (pending.append === undefined)
      throw new Error("A persisted Turn has no rollout sequence.")
    this.#events.send({
      type: "rollout.appended",
      threadId: this.id,
      ...pending.append,
    })

    let taskHandle: TurnTask
    try {
      taskHandle = this.#processor.start(
        this.#turnRuntime(active),
        input,
        active.context,
        {
          signal: active.abort.signal,
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
        (completion) =>
          active.abort.signal.aborted
            ? { type: "interrupted" as const }
            : {
                type: "completed" as const,
                ...(completion === undefined ? {} : { completion }),
              },
        (error: unknown) =>
          active.abort.signal.aborted
            ? { type: "interrupted" as const }
            : { type: "failed" as const, error },
      )
      .finally(() => {
        processorSettled = true
      })
    const outcome = Promise.race([
      settled,
      aborted.then(async () => {
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
  }

  // A Turn that never became durable: clear the starting marker, unwind the
  // active shell, and surface the failure. The dedupe entry stays: the batch
  // may already be durable, and a retry must replay rather than risk a
  // duplicate — the Turn's failure is visible through the agent status.
  async #failPendingTurn(
    pending: PendingTurnStart,
    active: ActiveTurn,
    error: unknown,
  ): Promise<void> {
    active.finishing = true
    active.acceptingSteering = false
    if (this.#pendingTurnStart === pending) this.#pendingTurnStart = undefined
    try {
      await this.#store.flushThread(this.id)
    } catch (recoveryError) {
      this.#reportPersistenceError(recoveryError)
    }
    try {
      await this.#recordAgentFailure(
        error instanceof Error ? error.message : "Turn persistence failed.",
      )
    } catch (failureError) {
      this.#reportPersistenceError(failureError)
    } finally {
      // Keep ownership until the failure status is settled, as for a started
      // Turn; otherwise it can overwrite a newly admitted Turn's status.
      this.#releaseTurn(active, "failed")
    }
  }

  async #finishTurn(
    active: ActiveTurn,
    outcome:
      | Readonly<{ type: "completed"; completion?: TurnCompletion }>
      | { readonly type: "interrupted" }
      | { readonly type: "failed"; readonly error: unknown },
  ): Promise<void> {
    if (this.#activeTurn !== active) return
    active.finishing = true
    active.acceptingSteering = false
    // Results already being committed must precede the terminal record. New
    // commits are rejected, including tools that outlive the interruption grace.
    await this.#contextMutationTail

    if (outcome.type === "interrupted") {
      await this.#appendRollout([
        {
          type: "turn_completed",
          turnId: active.input.submissionId,
          outcome: "interrupted",
          ...(active.usage === undefined ? {} : { usage: active.usage }),
          ...(active.metrics === undefined ? {} : { metrics: active.metrics }),
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
      this.#setAgentStatus("interrupted")
      this.#releaseTurn(active, "interrupted")
      return
    }

    if (outcome.type === "failed") {
      const error = kernelErrorFromUnknown(outcome.error)
      const message = error.message
      await this.#appendRollout([
        {
          type: "turn_completed",
          turnId: active.input.submissionId,
          outcome: "failed",
          ...(active.usage === undefined ? {} : { usage: active.usage }),
          ...(active.metrics === undefined ? {} : { metrics: active.metrics }),
          error,
        },
      ])
      await this.#flushRollout()
      this.#events.send({
        type: "session.error",
        threadId: this.id,
        operation: "turn_input",
        message,
      })
      this.#events.send({
        type: "turn.failed",
        threadId: this.id,
        input: active.input,
        error,
      })
      this.#setAgentStatus({ errored: message })
      this.#releaseTurn(active, "failed")
      return
    }

    const completedText = answerText(
      outcome.completion?.answerItemIds === undefined
        ? this.#contextManager.snapshot().history
        : active.assistantItems,
      active.input.submissionId,
      outcome.completion?.answerItemIds,
    )
    await this.#appendRollout([
      {
        type: "turn_completed",
        turnId: active.input.submissionId,
        outcome: "completed",
        ...(outcome.completion === undefined
          ? {}
          : { completion: outcome.completion }),
        ...(active.lastRequestStartedAt === undefined
          ? {}
          : { lastRequestStartedAt: active.lastRequestStartedAt }),
        ...(active.usage === undefined ? {} : { usage: active.usage }),
        ...(active.metrics === undefined ? {} : { metrics: active.metrics }),
      },
    ])
    await this.#flushRollout()
    this.#events.send({
      type: "turn.completed",
      threadId: this.id,
      input: active.input,
      ...(outcome.completion === undefined
        ? {}
        : { completion: outcome.completion }),
    })
    this.#setAgentStatus({
      completed: completedText,
      ...(outcome.completion?.reason === undefined
        ? {}
        : { reason: outcome.completion.reason }),
    })
    this.#releaseTurn(active, "completed")
  }

  #releaseTurn(active: ActiveTurn, idleCause: SessionIdleCause): void {
    if (this.#activeTurn !== active) return
    this.#activeTurn = undefined
    if (!this.#closing) this.#setStatus(SessionStatus.Idle, idleCause)
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
      if (this.#activeTurn !== active || active.finishing) {
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
      recordInitialInput: async () => {
        requireLease()
        if (active.inputRecorded) return
        await this.#withContextMutation(async () => {
          requireLease()
          if (active.inputRecorded) return
          const items: readonly RolloutItem[] = [
            { type: "response_item", item: active.inputItem },
          ]
          this.#contextManager.record([active.inputItem])
          active.inputRecorded = true
          let append: RolloutAppend
          try {
            append = await this.#store.appendItems(this.id, items)
          } catch (error) {
            this.#reportPersistenceError(error)
            try {
              await this.#store.flushThread(this.id)
              const stored = await this.#store.readThread(this.id)
              const existing = stored?.rollout.find(
                ({ item }) =>
                  item.type === "response_item" &&
                  item.item.id === active.inputItem.id,
              )
              append =
                existing === undefined
                  ? await this.#store.appendItems(this.id, items)
                  : { throughSeq: existing.seq + 1, records: [existing] }
            } catch (recoveryError) {
              this.#reportPersistenceError(recoveryError)
              this.#events.send({
                type: "runtime.warning",
                threadId: this.id,
                turnId: active.input.submissionId,
                message: "Failed to save the accepted user input.",
              })
              return
            }
          }
          try {
            await this.#store.persistThread(this.id, PersistContext.TurnStart)
          } catch (error) {
            this.#reportPersistenceError(error)
            this.#events.send({
              type: "runtime.warning",
              threadId: this.id,
              turnId: active.input.submissionId,
              message: "Failed to save the accepted user input.",
            })
          }
          this.#events.send({
            type: "rollout.appended",
            threadId: this.id,
            ...append,
          })
        })
      },
      recordModelContext: async (settings) => {
        requireLease()
        await this.#appendRollout([{ type: "model_context", settings }])
        this.#contextManager.setPreviousModel(settings)
      },
      snapshot: () => {
        requireLease()
        return this.snapshot()
      },
      recordUsage: async (usage) => {
        requireActive()
        const snapshot = structuredClone(usage)
        active.usage = snapshot
        // Admission is fenced above, not inside the queue: finishTurn waits
        // for admitted writes even after it marks the Turn as finishing.
        await this.#withContextMutation(async () => {
          const items: readonly RolloutItem[] = [
            {
              type: "turn_usage",
              turnId: active.input.submissionId,
              usage: snapshot,
            },
          ]
          try {
            const append = await this.#store.appendItems(this.id, items)
            await this.#store.flushThread(this.id)
            this.#events.send({
              type: "rollout.appended",
              threadId: this.id,
              ...append,
            })
          } catch (error) {
            this.#reportPersistenceError(error)
            throw error
          }
        })
      },
      recordRequestStartedAt: (startedAt) => {
        requireLease()
        active.lastRequestStartedAt = new Date(startedAt).toISOString()
      },
      invalidateRequestStartedAt: () => {
        requireLease()
        active.lastRequestStartedAt = undefined
      },
      recordTurnMetrics: (metrics) => {
        requireActive()
        active.metrics = metrics
      },
      recordContextTokens: async (input) => {
        requireLease()
        if (
          !Number.isSafeInteger(input.activeContextTokens) ||
          input.activeContextTokens < 0 ||
          (input.inputTokens !== undefined &&
            (!Number.isSafeInteger(input.inputTokens) ||
              input.inputTokens < 0)) ||
          (input.capacityTokens !== undefined &&
            (!Number.isSafeInteger(input.capacityTokens) ||
              input.capacityTokens < 0)) ||
          (input.historyAnchorTokens !== undefined &&
            (!Number.isSafeInteger(input.historyAnchorTokens) ||
              input.historyAnchorTokens < 0)) ||
          input.historyAnchorItemId.trim().length === 0 ||
          input.provider.trim().length === 0 ||
          input.model.trim().length === 0
        ) {
          throw new Error(
            "Active context tokens must be a non-negative integer.",
          )
        }
        const next = this.#contextManager.contextTokensAfterUpdate(input)
        await this.#appendRollout([
          {
            type: "token_count",
            turnId: active.input.submissionId,
            ...next,
            ...(input.capacityTokens === undefined
              ? {}
              : { capacityTokens: input.capacityTokens }),
          },
        ])
        this.#contextManager.setContextTokens(next)
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
      emitWarning: (message, diagnostic) => {
        requireLease()
        this.#events.send({
          type: "runtime.warning",
          threadId: this.id,
          turnId: active.input.submissionId,
          message,
          ...(diagnostic?.code === undefined ? {} : { code: diagnostic.code }),
          ...(diagnostic?.details === undefined
            ? {}
            : { details: diagnostic.details }),
        })
      },
      recordToolStarted: async (item) => {
        requireLease()
        // Tool starts must survive a GUI reconnect while the model stream is
        // still active. Use the same durable item id for start and completion.
        await this.#appendRollout([
          {
            type: "item_started",
            turnId: active.input.submissionId,
            item: structuredClone(item),
          },
        ])
        requireLease()
      },
      emitItemStarted: (item) => {
        requireLease()
        this.#events.send({
          type: "item.started",
          threadId: this.id,
          turnId: active.input.submissionId,
          item: structuredClone(item),
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
      recordModelAttempt: async (attempt) => {
        requireActive()
        await this.#appendRollout([
          { type: "model_attempt", turnId: active.input.submissionId, attempt },
        ])
      },
      recordConversationItems: async (items) => {
        requireLease()
        if (items.length === 0) return
        await this.#withContextMutation(async () => {
          requireLease()
          await this.#appendRollout(
            items.map((item): RolloutItem => ({ type: "response_item", item })),
          )
          for (const item of items)
            this.#rememberRecordedSteer(item, active.input.submissionId)
          this.#contextManager.record(items)
          active.assistantItems.push(
            ...items.filter((item) => item.item.role === "assistant"),
          )
        })
      },
      recordItemCompletions: async (items) => {
        requireLease()
        if (items.length === 0) return
        await this.#appendRollout(
          items.map(
            (item): RolloutItem => ({
              type: "item_completed",
              turnId: active.input.submissionId,
              item,
            }),
          ),
        )
      },
      recordToolResult: async (response, completion) => {
        // Cancellation stops new work, but Codex-style draining still records
        // completed tool effects until this Turn begins finalization.
        requireActive()
        if (
          response.turnId !== active.input.submissionId ||
          response.item.role !== "tool" ||
          response.item.toolCallId !== completion.toolCallId ||
          response.id !== completion.resultItemId
        ) {
          throw new Error("Tool result does not match its completion and Turn.")
        }
        // Admission happened before joining the mutation queue. Finalization
        // waits for this queue, so retain the result even if it starts meanwhile.
        await this.#withContextMutation(async () => {
          await this.#appendRollout([
            { type: "response_item", item: response },
            {
              type: "item_completed",
              turnId: active.input.submissionId,
              item: completion,
            },
          ])
          this.#contextManager.record([response])
        })
      },
      recordWorldStateUpdate: async (items, update) => {
        requireLease()
        await this.#withContextMutation(async () => {
          requireLease()
          if (items.length > 0) {
            this.#contextManager.record(items)
          }
          this.#contextManager.setWorldStateBaseline(update.snapshot)
          await this.#appendRollout([
            ...items.map(
              (item): RolloutItem => ({ type: "response_item", item }),
            ),
            {
              type: "world_state",
              turnId: active.input.submissionId,
              full: update.full,
              state: update.state,
            },
          ])
        })
      },
      replaceConversationHistory: async (input) => {
        requireLease()
        return this.#withContextMutation(async () => {
          requireLease()
          const current = this.#contextManager.snapshot().history
          if (
            input.expectedPrefix !== undefined &&
            (input.expectedPrefix.length !== input.baseHistoryLength ||
              JSON.stringify(current.slice(0, input.baseHistoryLength)) !==
                JSON.stringify(input.expectedPrefix))
          )
            return false
          // A pre-Turn checkpoint covers only the old prefix. Keep both the
          // already admitted current input and messages appended meanwhile.
          const concurrentTail = current.slice(input.baseHistoryLength)
          const replacement = [...input.replacement, ...concurrentTail]
          const items: readonly RolloutItem[] = [
            {
              type: "compacted",
              turnId: active.input.submissionId,
              replacement,
              summary: input.summary,
            },
            ...(input.worldState === undefined
              ? []
              : [
                  {
                    type: "world_state" as const,
                    turnId: active.input.submissionId,
                    full: true,
                    state: input.worldState.state,
                  },
                ]),
          ]
          let append: RolloutAppend
          try {
            append = await this.#store.appendItems(this.id, items)
            await this.#store.flushThread(this.id)
          } catch (error) {
            this.#reportPersistenceError(error)
            throw error
          }
          this.#contextManager.replace(replacement)
          if (input.worldState !== undefined) {
            this.#contextManager.setWorldStateBaseline(
              input.worldState.snapshot,
            )
          }
          this.#events.send({
            type: "rollout.appended",
            threadId: this.id,
            ...append,
          })
          return true
        })
      },
    }
  }

  async #runForkBarrier(operation: ForkBarrierCommand): Promise<void> {
    try {
      // A Turn being recorded must land before the barrier snapshots: wait
      // out the recording instead of racing it.
      await this.#pendingTurnReady
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
      const append = await this.#store.appendItems(this.id, items)
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        ...append,
      })
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

  #setStatus(status: SessionStatus, idleCause?: SessionIdleCause): void {
    if (this.#status === status) return
    this.#status = status
    for (const listener of this.#statusListeners) {
      queueMicrotask(() => {
        try {
          listener(status, idleCause)
        } catch {
          // A watch subscriber cannot break Session lifecycle transitions.
        }
      })
    }
  }

  #setAgentStatus(status: AgentStatus): void {
    this.#agentStatus = status
    for (const listener of this.#agentStatusListeners) {
      queueMicrotask(() => {
        try {
          listener(status)
        } catch {
          // A watch subscriber cannot break Session lifecycle transitions.
        }
      })
    }
  }

  async #recordAgentFailure(message: string): Promise<void> {
    if (
      typeof this.#agentStatus === "object" &&
      "errored" in this.#agentStatus &&
      this.#agentStatus.errored === message
    ) {
      return
    }
    const items: readonly RolloutItem[] = [
      { type: "agent_status", status: "errored", error: message },
    ]
    try {
      const append = await this.#store.appendItems(this.id, items)
      await this.#store.flushThread(this.id)
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        ...append,
      })
    } catch (error) {
      this.#reportPersistenceError(error)
      throw error
    }
    this.#setAgentStatus({ errored: message })
  }

  async #recordAgentMessage(messageId: string, text: string): Promise<void> {
    await this.#withContextMutation(async () => {
      if (this.#receivedAgentMessageIds.has(messageId)) return
      let accepted = this.#acceptedAgentMessages.get(messageId)
      try {
        if (accepted === undefined) {
          const envelope: ResponseItemEnvelope = {
            id: messageId,
            turnId: this.#activeTurn?.input.submissionId ?? createTurnId(),
            createdAt: new Date().toISOString(),
            item: { role: "user", content: [{ type: "text", text }] },
          }
          const items: readonly RolloutItem[] = [
            { type: "agent_message", messageId, item: envelope },
          ]
          const append = this.#store.appendItems(this.id, items)
          accepted = { envelope, items }
          this.#acceptedAgentMessages.set(messageId, accepted)
          this.#contextManager.record([envelope])
          try {
            accepted.append = await append
          } catch {
            // The batch may already be in the writer's retry buffer. Persist
            // it before acknowledging an out-of-band agent message.
            await this.#store.persistThread(this.id, PersistContext.TurnStart)
          }
        }
        await this.#store.flushThread(this.id)
        if (accepted.append === undefined) {
          await this.#store.persistThread(this.id, PersistContext.TurnStart)
          const stored = await this.#store.readThread(this.id)
          const record = stored?.rollout.find(
            (entry) =>
              entry.item.type === "agent_message" &&
              entry.item.messageId === messageId,
          )
          if (record !== undefined)
            accepted.append = { throughSeq: record.seq + 1, records: [record] }
          else {
            accepted.append = await this.#store.appendItems(
              this.id,
              accepted.items,
            )
            await this.#store.flushThread(this.id)
          }
        }
      } catch (error) {
        this.#reportPersistenceError(error)
        throw error
      }
      this.#acceptedAgentMessages.delete(messageId)
      this.#receivedAgentMessageIds.add(messageId)
      if (accepted.append !== undefined) {
        this.#events.send({
          type: "rollout.appended",
          threadId: this.id,
          ...accepted.append,
        })
      }
    })
  }

  #withContextMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#contextMutationTail.then(run)
    this.#contextMutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

// Before drafts were persisted, model blocks and submission metadata retained
// the input's meaning. The new draft folds empty/adjacent text blocks and makes
// default image detail explicit. Compare that format only for restored IDs
// that have an admission fingerprint; never infer identity for an unverified ID.
function recordedInputFingerprint(
  envelope: ResponseItemEnvelope,
  admissionFingerprint: string,
): string | undefined {
  if (envelope.submissionMetadata?.content !== undefined) return undefined
  const message = envelope.item
  const content =
    message.role === "user"
      ? inputContentFromModelMessage(message)
      : message.role === "developer" && message.context?.type === "goal"
        ? createUserInput(message.content.map((block) => block.text).join(""))
        : undefined
  if (content === undefined) return undefined
  return restoredInputFingerprint({
    submissionId: envelope.turnId,
    content,
    ...(message.role === "developer" && message.context?.type === "goal"
      ? { goalId: message.context.goalId }
      : {}),
    ...(admissionFingerprint.startsWith("compact:")
      ? { manualCompact: true }
      : {}),
    ...(envelope.submissionMetadata?.modelSelection === undefined
      ? {}
      : { modelSelection: envelope.submissionMetadata.modelSelection }),
    ...(envelope.submissionMetadata?.parentInputId === undefined
      ? {}
      : { parentInputId: envelope.submissionMetadata.parentInputId }),
    ...(envelope.submissionMetadata?.metadata === undefined
      ? {}
      : { metadata: envelope.submissionMetadata.metadata }),
  })
}

function restoredInputFingerprint(input: TurnInput): string {
  return fingerprintTurnInput({
    ...input,
    content: {
      ...input.content,
      attachments: input.content.attachments.map((attachment) =>
        attachment.mediaType === "application/pdf"
          ? attachment
          : { ...attachment, detail: attachment.detail ?? "high" },
      ),
    },
  })
}

export function agentStatusFromStoredThread(stored: StoredThread): AgentStatus {
  let status: AgentStatus = "pending_init"
  const responseItems = stored.rollout.flatMap((record) =>
    record.item.type === "response_item" ? [record.item.item] : [],
  )
  for (const record of stored.rollout) {
    const item = record.item
    if (item.type === "agent_status") {
      status = { errored: item.error }
      continue
    }
    if (item.type === "turn_started") {
      // A reconstructed Session has no live task for an unmatched start.
      status = "interrupted"
      continue
    }
    if (item.type !== "turn_completed") continue
    if (item.outcome === "interrupted") {
      status = "interrupted"
    } else if (item.outcome === "failed") {
      status = { errored: item.error?.message ?? "Turn execution failed." }
    } else {
      status = {
        completed: answerText(
          responseItems,
          item.turnId,
          item.completion?.answerItemIds,
        ),
        ...(item.completion?.reason === undefined
          ? {}
          : { reason: item.completion.reason }),
      }
    }
  }
  return status
}

function answerText(
  items: readonly ResponseItemEnvelope[],
  turnId: string,
  answerItemIds?: readonly string[],
): string | null {
  const assistants = items.filter(
    (item) => item.turnId === turnId && item.item.role === "assistant",
  )
  const answer =
    answerItemIds === undefined
      ? assistants.slice(-1)
      : answerItemIds.map((id) => {
          const item = assistants.find((candidate) => candidate.id === id)
          if (item === undefined) {
            throw new Error(
              `Turn answer references missing assistant item ${id}.`,
            )
          }
          return item
        })
  const text = answer
    .flatMap((item) =>
      item.item.role === "assistant" ? item.item.content : [],
    )
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
  return text.length === 0 ? null : text
}

function buildInputItem(input: TurnInput): ResponseItemEnvelope {
  const submissionMetadata = turnInputSubmissionMetadata(input)
  return {
    id: createInputId(),
    turnId: input.submissionId,
    createdAt: new Date().toISOString(),
    item: inputContentToModelMessage(input.content, input.goalId),
    ...submissionMetadata,
  }
}

function turnInputSubmissionMetadata(
  input: TurnInput,
): Pick<ResponseItemEnvelope, "submissionMetadata"> {
  return {
    submissionMetadata: {
      content: input.content,
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
