import { answerTextParts } from "../protocol/model-output.ts"
import type { ModelOutputPresentation } from "../protocol/model-output.ts"
import {
  TaskCleanupError,
  type ExecutionContext,
  type SessionTask,
  type SessionTaskRunner,
  type SessionTaskHandle,
  type TaskOutcome,
  type TaskSettlement,
  type TurnControl,
} from "./session-task.ts"
import { kernelErrorFromUnknown } from "../kernel/errors.ts"
import type {
  CompletedExecutionItem,
  JsonObject,
  KernelError,
  SessionConfigurationSnapshot,
  StartedExecutionItem,
  TokenUsage,
  ToolExecutionItem,
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
  ThreadMessageAdmission,
  TurnContextItem,
} from "./rollout.ts"
import {
  type AgentStatus,
  AsyncQueue,
  BoundedQueue,
  createSessionEventReceiver,
  fingerprintTurnInput,
  type NotSubmittedReason,
  NotSubmittedReason as Reason,
  type SessionEvent,
  type SessionIdleCause,
  type SessionEndpoints,
  type SessionOp,
  type SessionPermissionEvent,
  SessionStatus,
  type TurnInput,
  type InputSource,
  type InputPurpose,
  type TurnInputSubmission,
} from "./session-io.ts"
import {
  PersistContext,
  type RolloutAppend,
  type SessionRolloutStore,
} from "./thread-store.ts"
import { createUserInput, inputContentToModelMessage } from "./user-input.ts"

export type { TurnCompletion } from "../kernel/events.ts"

const submissionCapacity = 512
const gracefulInterruptionTimeoutMs = 100

export type SessionSnapshot = Readonly<{
  metadata: ThreadMetadata
  context: ContextSnapshot
  configuration?: SessionConfigurationSnapshot
  activeTurnId?: string
}>

export type ExecutionRecord =
  | Readonly<{ type: "usage"; usage: TokenUsage }>
  | Readonly<{ type: "world_state"; snapshot: JsonObject }>
  | Readonly<{ type: "tool_started"; item: ToolExecutionItem }>
  | Readonly<{
      type: "tool_result"
      completion: Extract<CompletedExecutionItem, { toolCallId: string }>
    }>
  | Readonly<{ type: "conversation"; items: readonly ResponseItemEnvelope[] }>

type ActiveTurn = {
  messageAdmission?: Readonly<{ resolve(): void; reject(error: unknown): void }>
  readonly input: TurnInput
  readonly inputItem: ResponseItemEnvelope
  inputRecorded: boolean
  // Compaction can replace model history before a continued answer finishes.
  assistantItems: ResponseItemEnvelope[]
  context: TurnContextItem | undefined
  readonly execution: ExecutionContext
  readonly definition: SessionTask
  readonly abort: AbortController
  readonly steering: TurnInput[]
  readonly steeringFingerprints: Map<string, string>
  acceptingSteering: boolean
  finishing: boolean
  usage: TokenUsage | undefined
  lastRequestStartedAt: string | undefined
  metrics: TurnMetrics | undefined
  escalation: Promise<void> | undefined
  escalationTimer: ReturnType<typeof setTimeout> | undefined
  cleanupError: unknown
  readonly handle: SessionTaskHandle
  readonly finalized: Promise<void>
  interruptReason: string | undefined
}

type ForkBarrierCommand = Readonly<{
  type: "fork_barrier"
  run: (snapshot: SessionSnapshot) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}>

type SessionCommand = SessionOp | ForkBarrierCommand

type AcceptedAgentMessage = {
  readonly envelope: ResponseItemEnvelope
  readonly items: readonly RolloutItem[]
  append?: RolloutAppend
}

type AcceptedThreadMessage = {
  readonly admission: ThreadMessageAdmission
  readonly envelope: ResponseItemEnvelope
  durable: boolean
  consumed: boolean
  appendAttempted?: boolean
  append?: RolloutAppend
}

type PendingTurnStart = {
  readonly input: TurnInput
  readonly context: TurnContextItem
  readonly inputItem: ResponseItemEnvelope
  readonly items: readonly RolloutItem[]
  append?: RolloutAppend
}

export class Session {
  readonly id: string
  readonly endpoints: SessionEndpoints
  readonly #executionObservers = new Map<
    ExecutionContext,
    Set<(record: ExecutionRecord) => void>
  >()
  readonly #metadata: ThreadMetadata
  readonly #contextManager: ContextManager
  #configuration: SessionConfigurationSnapshot | undefined
  readonly #submittedInputs = new Map<
    string,
    Readonly<{
      fingerprint: string | undefined
      source: InputSource
      purpose: InputPurpose
      inputItemId: string
      turnId: string
      threadId: string
    }>
  >()
  readonly #threadMessages = new Map<string, AcceptedThreadMessage>()
  #pendingTurnStart: PendingTurnStart | undefined
  readonly #store: SessionRolloutStore
  readonly #processor: SessionTaskRunner
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
    processor: SessionTaskRunner
    onPersistenceError?: (error: unknown) => void
  }) {
    this.id = input.stored.metadata.id
    this.#metadata = structuredClone(input.stored.metadata)
    this.#contextManager = ContextManager.fromStoredThread(input.stored)
    this.#configuration = latestConfiguration(input.stored)
    this.#agentStatus = agentStatusFromStoredThread(input.stored)
    let recordedTurnId: string | undefined
    for (const record of input.stored.rollout) {
      if (record.item.type === "agent_message") {
        this.#receivedAgentMessageIds.add(record.item.messageId)
      }
      if (record.item.type === "turn_started")
        recordedTurnId = record.item.turnId
      if (record.item.type === "response_item")
        this.#rememberRecordedInput(
          record.item.item,
          recordedTurnId ?? record.item.item.turnId,
          record.threadId,
        )
      if (record.item.type === "turn_started") {
        this.#submittedInputs.set(record.item.turnId, {
          threadId: record.threadId,
          fingerprint: record.item.requestFingerprint,
          source: record.item.source ?? "human",
          purpose: record.item.purpose ?? "message",
          inputItemId: record.item.inputItemId,
          turnId: record.item.turnId,
        })
      }
    }
    // Explicit receipts retain the target Turn even for unconsumed steering.
    for (const { threadId, item } of input.stored.rollout) {
      // Forked conversation history retains its original recipient. Those
      // receipts never establish an admission in this independent actor.
      if (threadId !== this.id) continue
      if (item.type === "thread_message_admitted") {
        this.#threadMessages.set(item.submissionId, {
          admission: item,
          envelope: { ...buildInputItem(item.input), id: item.inputItemId },
          durable: true,
          consumed: false,
        })
        this.#submittedInputs.set(item.submissionId, {
          threadId,
          fingerprint: item.requestFingerprint,
          source: inputSource(item.input),
          purpose: inputPurpose(item.input),
          inputItemId: item.inputItemId,
          turnId: item.targetTurnId,
        })
      } else if (item.type === "thread_message_consumed") {
        const accepted = this.#threadMessages.get(item.submissionId)
        if (accepted !== undefined) accepted.consumed = true
      }
    }
    this.#store = input.store
    this.#processor = input.processor
    this.#onPersistenceError = input.onPersistenceError
    this.#submissionLoop = this.#runSubmissionLoop()
    this.endpoints = {
      send: (operation) =>
        this.#closing
          ? Promise.reject(new Error("Session is shutting down."))
          : this.#submissions.send(operation),
      shutdown: () => {
        if (!this.#closing) {
          this.#closing = true
          void this.#submissions.send({ type: "shutdown" })
        }
        return this.#submissionLoop
      },
      events: createSessionEventReceiver(() => this.#events.receive()),
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
    }
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
      // The task owns preparation, recording and resource settlement. Finish
      // those before disposing Session services and closing its writer.
      await this.#activeTurn?.finalized
      if (this.#activeTurn?.cleanupError !== undefined)
        throw this.#activeTurn.cleanupError
    } finally {
      this.#closing = true
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
    operation: Exclude<SessionOp, Readonly<{ type: "shutdown" }>>,
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
    if (operation.input.provenance !== undefined) {
      // Registration is synchronous; the external sender awaits its durable
      // receipt independently, so discovery cannot block cancellation commands.
      void this.#routeTurnInput(operation.input, operation.mode).then(
        operation.reply.resolve,
        operation.reply.reject,
      )
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

  #rememberRecordedInput(
    item: ResponseItemEnvelope,
    turnId: string,
    threadId = this.id,
  ): void {
    if (item.submissionMetadata?.source === undefined) return
    this.#submittedInputs.set(item.turnId, {
      threadId,
      fingerprint: item.submissionMetadata?.requestFingerprint,
      source: item.submissionMetadata?.source ?? "human",
      purpose: item.submissionMetadata?.purpose ?? "message",
      inputItemId: item.id,
      turnId,
    })
  }

  async #routeTurnInput(
    input: TurnInput,
    mode: Extract<SessionOp, Readonly<{ type: "turn_input" }>>["mode"],
  ): Promise<TurnInputSubmission> {
    const fingerprint = fingerprintTurnInput(input)
    const recorded = this.#submittedInputs.get(input.submissionId)
    const submitted =
      input.provenance !== undefined && recorded?.threadId !== this.id
        ? undefined
        : recorded
    if (submitted !== undefined) {
      if (
        (submitted.source === "human" &&
          submitted.purpose !== "question_answer") ||
        inputPurpose(input) !== submitted.purpose ||
        inputSource(input) !== submitted.source ||
        submitted.fingerprint !== fingerprint
      ) {
        return notSubmitted(Reason.RequestConflict)
      }
      let message = this.#threadMessages.get(input.submissionId)
      if (input.provenance !== undefined && message === undefined) {
        // A crash can preserve turn_started before its external-message receipt.
        // The matching source-sensitive fingerprint proves this original start;
        // repair the receipt with its recorded identity, without executing it.
        if (
          submitted.turnId !== input.submissionId ||
          submitted.fingerprint !== fingerprint
        )
          return notSubmitted(Reason.RequestConflict)
        message = this.#acceptThreadMessage(
          input,
          submitted.turnId,
          "started",
          submitted.inputItemId,
        )
      }
      if (message !== undefined && !message.durable) {
        const accepted = message
        await this.#withContextMutation(() =>
          this.#persistThreadMessage(accepted),
        )
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
    if (active === undefined) {
      return mode.type === "start_or_steer"
        ? this.#startTurn(input)
        : notSubmitted(Reason.NoActiveTurn)
    }
    if (!active.acceptingSteering || active.finishing) {
      return notSubmitted(
        mode.type === "start_or_steer"
          ? Reason.TurnFinishing
          : Reason.NoActiveTurn,
      )
    }
    if (
      mode.type === "steer" &&
      active.input.submissionId !== mode.expectedTurnId
    ) {
      return notSubmitted(Reason.TurnMismatch)
    }
    const previousSteering = active.steeringFingerprints.get(input.submissionId)
    if (previousSteering !== undefined) {
      return inputSource(input) !== "human" && previousSteering === fingerprint
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
    let receipt: Promise<void> | undefined
    if (input.provenance !== undefined) {
      const accepted = this.#acceptThreadMessage(
        input,
        active.input.submissionId,
        "steered",
      )
      // Queue the durable receipt before the processor can consume the input.
      // Cancellation may leave it unconsumed; that state is explicit in storage.
      receipt = this.#withContextMutation(() =>
        this.#persistThreadMessage(accepted),
      )
    }
    active.steering.push(input)
    await receipt
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
    let definition: SessionTask
    try {
      definition = this.#processor.createTask(this.snapshot(), input)
    } catch (error) {
      await this.#recordAgentFailure(
        error instanceof Error ? error.message : "Task capture failed.",
      )
      throw error
    }
    const inputItem =
      input.provenance === undefined
        ? buildInputItem(input)
        : this.#acceptThreadMessage(input, input.submissionId, "started")
            .envelope
    this.#submittedInputs.set(input.submissionId, {
      threadId: this.id,
      fingerprint:
        inputSource(input) === "human" &&
        inputPurpose(input) !== "question_answer"
          ? undefined
          : fingerprintTurnInput(input),
      source: inputSource(input),
      purpose: inputPurpose(input),
      inputItemId: inputItem.id,
      turnId: input.submissionId,
    })
    const abort = new AbortController()
    let messageAdmission: ActiveTurn["messageAdmission"]
    const admitted =
      input.provenance === undefined
        ? undefined
        : new Promise<void>((resolve, reject) => {
            messageAdmission = { resolve, reject }
          })
    const execution: ExecutionContext = {
      executionId: `execution_${globalThis.crypto.randomUUID()}`,
      input,
      signal: abort.signal,
    }
    const handle: SessionTaskHandle = {
      kind: definition.kind,
      executionId: execution.executionId,
      cancel: () => this.#cancelTask(active),
      settled: Promise.resolve().then(() => this.#settleTask(active)),
    }
    const active: ActiveTurn = {
      ...(messageAdmission === undefined ? {} : { messageAdmission }),
      finishing: false,
      input,
      inputItem,
      inputRecorded: false,
      assistantItems: [],
      context: undefined,
      execution,
      definition,
      abort,
      steering: [],
      steeringFingerprints: new Map(),
      acceptingSteering: true,
      usage: undefined,
      lastRequestStartedAt: undefined,
      metrics: undefined,
      escalation: undefined,
      escalationTimer: undefined,
      cleanupError: undefined,
      handle,
      finalized: handle.settled.then((outcome) =>
        this.#onTaskSettled(active, outcome),
      ),
      interruptReason: undefined,
    }
    this.#activeTurn = active
    this.#setStatus(SessionStatus.Active)
    this.#setAgentStatus("running")
    this.#events.send({ type: "turn.started", threadId: this.id, input })
    // The handle already owns preparation and cleanup before admission publishes.
    await admitted
    return {
      type: "started",
      turnId: input.submissionId,
      inputItemId: inputItem.id,
    }
  }

  async #settleTask(active: ActiveTurn): Promise<TaskSettlement> {
    let outcome: TaskOutcome
    try {
      const completion = await active.definition.run(this, active.execution)
      outcome = active.abort.signal.aborted
        ? { type: "interrupted" }
        : {
            type: "completed",
            ...(completion === undefined ? {} : { completion }),
          }
    } catch (error) {
      if (error instanceof TaskCleanupError) active.cleanupError = error
      outcome = active.abort.signal.aborted
        ? { type: "interrupted" }
        : { type: "failed", error }
    }
    clearTimeout(active.escalationTimer)
    await active.escalation
    return active.cleanupError === undefined
      ? outcome
      : { type: "cleanup_failed", error: active.cleanupError }
  }

  async #onTaskSettled(
    active: ActiveTurn,
    outcome: TaskSettlement,
  ): Promise<void> {
    // Execution settlement has no authority to publish a business terminal.
    // Session chooses that disposition after resource settlement and admitted writes.
    if (outcome.type === "cleanup_failed") {
      active.finishing = true
      active.acceptingSteering = false
      const message =
        "Task resource cleanup failed; the Session remains occupied."
      this.#setAgentStatus({ errored: message })
      this.#events.send({
        type: "session.error",
        threadId: this.id,
        operation: "interrupt",
        message,
      })
      active.messageAdmission?.reject(outcome.error)
      return
    }
    try {
      await this.#finishTurn(active, outcome)
    } finally {
      active.messageAdmission?.reject(
        outcome.type === "failed"
          ? outcome.error
          : new Error("Task finished before its thread message admission."),
      )
    }
  }

  async beginExecution(
    execution: ExecutionContext,
    context: TurnContextItem,
  ): Promise<void> {
    const active = this.#requireExecution(execution)
    if (
      context.turnId !== active.input.submissionId ||
      active.context !== undefined
    )
      throw new Error("Task prepared a mismatched or duplicate Turn context.")
    active.context = structuredClone(context)
    this.#configuration = structuredClone(context.configuration)
    const input = active.input
    const pending: PendingTurnStart = {
      input,
      context,
      inputItem: active.inputItem,
      items: [
        {
          type: "turn_started",
          turnId: input.submissionId,
          inputItemId: active.inputItem.id,
          source: inputSource(input),
          purpose: inputPurpose(input),
          ...(inputSource(input) === "human" &&
          inputPurpose(input) !== "question_answer"
            ? {}
            : { requestFingerprint: fingerprintTurnInput(input) }),
        },
        { type: "turn_context", context },
      ],
    }
    this.#pendingTurnStart = pending
    await this.#recordTurnStart(pending)
    const message = this.#threadMessages.get(input.submissionId)
    if (message !== undefined) {
      await this.#withContextMutation(() => this.#persistThreadMessage(message))
      active.messageAdmission?.resolve()
    }
    this.#requireExecution(execution)
  }

  async #recordTurnStart(pending: PendingTurnStart): Promise<void> {
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
            entry.threadId === this.id &&
            entry.item.type === "turn_started" &&
            entry.item.turnId === input.submissionId &&
            entry.item.inputItemId === pending.inputItem.id,
        )
        if (start !== undefined) {
          const inputRecord = rollout.find(
            (entry) =>
              entry.threadId === this.id &&
              entry.item.type === "response_item" &&
              entry.item.item.id === pending.inputItem.id,
          )
          const contextRecord = rollout.find(
            (entry) =>
              entry.threadId === this.id &&
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
              entry.threadId === this.id &&
              entry.item.type === "response_item" &&
              entry.item.item.id === pending.inputItem.id,
          )
          const contextPresent = rollout.some(
            (entry) =>
              entry.threadId === this.id &&
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
  }

  async #finishTurn(active: ActiveTurn, outcome: TaskOutcome): Promise<void> {
    if (this.#activeTurn !== active) return
    active.finishing = true
    active.acceptingSteering = false
    if (this.#pendingTurnStart?.input === active.input) {
      this.#pendingTurnStart = undefined
      await this.#contextMutationTail
      try {
        await this.#store.flushThread(this.id)
      } catch (error) {
        this.#reportPersistenceError(error)
      }
      try {
        await this.#recordAgentFailure(
          outcome.type === "failed" && outcome.error instanceof Error
            ? outcome.error.message
            : "Turn persistence failed.",
        )
      } finally {
        this.#releaseTurn(active, "failed")
      }
      return
    }
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
    this.#executionObservers.delete(active.execution)
    this.#activeTurn = undefined
    if (!this.#closing) this.#setStatus(SessionStatus.Idle, idleCause)
  }

  #interruptActiveTurn(reason: string): void {
    if (this.#activeTurn === undefined) return
    this.#activeTurn.interruptReason = reason
    this.#activeTurn.handle.cancel()
  }

  #cancelTask(active: ActiveTurn): void {
    active.acceptingSteering = false
    active.abort.abort()
    if (active.escalationTimer === undefined && !active.finishing) {
      // This grace is an implementation safety boundary for transports that
      // need an explicit close. It never proves execution has stopped.
      active.escalationTimer = setTimeout(() => {
        this.#events.send({
          type: "runtime.warning",
          threadId: this.id,
          turnId: active.input.submissionId,
          code: "task.stopping",
          message:
            "Waiting for the current execution to stop and release its resources.",
        })
        active.escalation = Promise.resolve()
          .then(() => active.definition.abort?.())
          .catch((error: unknown) => {
            active.cleanupError = error
            this.#events.send({
              type: "session.error",
              threadId: this.id,
              operation: "interrupt",
              message:
                error instanceof Error ? error.message : "Task abort failed.",
            })
          })
      }, gracefulInterruptionTimeoutMs)
    }
  }

  observeExecution(
    execution: ExecutionContext,
    listener: (record: ExecutionRecord) => void,
  ): () => void {
    this.#requireExecution(execution)
    const listeners = this.#executionObservers.get(execution) ?? new Set()
    listeners.add(listener)
    this.#executionObservers.set(execution, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#executionObservers.delete(execution)
    }
  }

  #notifyExecution(execution: ExecutionContext, record: ExecutionRecord): void {
    for (const listener of this.#executionObservers.get(execution) ?? [])
      listener(record)
  }

  #requireExecution(
    execution: ExecutionContext,
    allowStopping = false,
  ): ActiveTurn {
    const active = this.#activeTurn
    if (
      active === undefined ||
      active.execution !== execution ||
      active.finishing ||
      (!allowStopping && active.abort.signal.aborted)
    )
      throw new Error("Turn execution is no longer active.")
    return active
  }

  takeSteering(execution: ExecutionContext): readonly TurnInput[] {
    return this.#requireExecution(execution).steering.splice(0)
  }

  takeSteeringOrComplete(
    execution: ExecutionContext,
  ): ReturnType<TurnControl["takeSteeringOrComplete"]> {
    const active = this.#requireExecution(execution)
    const inputs = active.steering.splice(0)
    if (inputs.length > 0) return { type: "steering", inputs }
    active.acceptingSteering = false
    return { type: "complete" }
  }

  // Ordinary records update history and publish append sequences. Save errors
  // are observable diagnostics; these operations do not promise a durable flush.
  async recordInitialInput(execution: ExecutionContext): Promise<void> {
    const active = this.#requireExecution(execution)

    if (active.inputRecorded) return
    if (active.input.provenance !== undefined) {
      await this.recordThreadMessageInput(execution, active.input)
      active.inputRecorded = true
      return
    }
    await this.#withContextMutation(async () => {
      this.#requireExecution(execution)
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
  }

  async recordModelContext(
    execution: ExecutionContext,
    settings: ModelContextSettings,
  ): Promise<void> {
    this.#requireExecution(execution)

    await this.#appendRollout([{ type: "model_context", settings }])
    this.#contextManager.setPreviousModel(settings)
  }

  async recordModelAttempt(
    execution: ExecutionContext,
    attempt: ModelAttemptRecord,
  ): Promise<void> {
    const active = this.#requireExecution(execution, true)
    await this.#appendRollout([
      { type: "model_attempt", turnId: active.input.submissionId, attempt },
    ])
  }

  executionSnapshot(execution: ExecutionContext): SessionSnapshot {
    this.#requireExecution(execution)

    return this.snapshot()
  }

  // This checkpoint resolves only after the writer flush; failure propagates.
  async checkpointUsage(
    execution: ExecutionContext,
    usage: TokenUsage,
  ): Promise<void> {
    const active = this.#requireExecution(execution, true)

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
    this.#notifyExecution(execution, { type: "usage", usage: snapshot })
  }

  recordRequestStartedAt(execution: ExecutionContext, startedAt: number): void {
    const active = this.#requireExecution(execution)

    active.lastRequestStartedAt = new Date(startedAt).toISOString()
  }

  invalidateRequestStartedAt(execution: ExecutionContext): void {
    const active = this.#requireExecution(execution)

    active.lastRequestStartedAt = undefined
  }

  recordTurnMetrics(execution: ExecutionContext, metrics: TurnMetrics): void {
    const active = this.#requireExecution(execution, true)

    active.metrics = metrics
  }

  async recordContextTokens(
    execution: ExecutionContext,
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
  ): Promise<void> {
    const active = this.#requireExecution(execution)

    if (
      !Number.isSafeInteger(input.activeContextTokens) ||
      input.activeContextTokens < 0 ||
      (input.inputTokens !== undefined &&
        (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0)) ||
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
      throw new Error("Active context tokens must be a non-negative integer.")
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
  }

  // itemId already identifies the display part, including its reasoning/part suffix.
  emitModelStream(
    execution: ExecutionContext,
    input: ModelOutputPresentation &
      Readonly<{
        itemId: string
        kind: "assistant" | "reasoning"
        delta: string
      }>,
  ): void {
    const active = this.#requireExecution(execution)

    this.#events.send({
      type: "model.stream",
      threadId: this.id,
      turnId: active.input.submissionId,
      ...input,
    })
  }

  emitWarning(
    execution: ExecutionContext,
    message: string,
    diagnostic?: KernelError,
  ): void {
    const active = this.#requireExecution(execution)

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
  }

  async recordToolStarted(
    execution: ExecutionContext,
    item: ToolExecutionItem,
  ): Promise<void> {
    const active = this.#requireExecution(execution)

    // Tool starts must survive a GUI reconnect while the model stream is
    // still active. Use the same durable item id for start and completion.
    await this.#appendRollout([
      {
        type: "item_started",
        turnId: active.input.submissionId,
        item: structuredClone(item),
      },
    ])
    this.#requireExecution(execution)
    this.#notifyExecution(execution, { type: "tool_started", item })
  }

  emitItemStarted(
    execution: ExecutionContext,
    item: StartedExecutionItem,
  ): void {
    const active = this.#requireExecution(execution)

    this.#events.send({
      type: "item.started",
      threadId: this.id,
      turnId: active.input.submissionId,
      item: structuredClone(item),
    })
  }

  emitPermissionEvent(
    execution: ExecutionContext,
    event: SessionPermissionEvent,
  ): void {
    const active = this.#requireExecution(execution, true)

    if (
      event.sessionId !== this.id ||
      event.turnId !== active.input.submissionId
    ) {
      throw new Error("Permission event does not belong to the active Turn.")
    }
    this.#events.send({
      type: "permission",
      threadId: this.id,
      event: structuredClone(event),
    })
  }

  async recordConversationItems(
    execution: ExecutionContext,
    items: readonly ResponseItemEnvelope[],
  ): Promise<void> {
    const active = this.#requireExecution(execution)

    if (items.length === 0) return
    await this.#withContextMutation(async () => {
      this.#requireExecution(execution)
      await this.#appendRollout(
        items.map((item): RolloutItem => ({ type: "response_item", item })),
      )
      for (const item of items)
        this.#rememberRecordedInput(item, active.input.submissionId)
      this.#contextManager.record(items)
      this.#notifyExecution(execution, { type: "conversation", items })
      active.assistantItems.push(
        ...items.filter((item) => item.item.role === "assistant"),
      )
    })
  }

  async recordItemCompletions(
    execution: ExecutionContext,
    items: readonly CompletedExecutionItem[],
  ): Promise<void> {
    const active = this.#requireExecution(execution)

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
  }

  async recordToolResult(
    execution: ExecutionContext,
    response: ResponseItemEnvelope,
    completion: Extract<CompletedExecutionItem, { toolCallId: string }>,
  ): Promise<void> {
    const active = this.#requireExecution(execution, true)

    // Cancellation stops new work, but Codex-style draining still records
    // completed tool effects until this Turn begins finalization.
    if (
      response.turnId !== active.input.submissionId ||
      response.item.role !== "tool" ||
      response.item.toolCallId !== completion.toolCallId ||
      response.id !== completion.resultItemId
    ) {
      throw new Error("Tool result does not match its completion and Turn.")
    }
    // Admission above is the lease check. Finalization drains this mutation
    // queue, so accepted tool effects remain writable after it starts.
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
      this.#notifyExecution(execution, { type: "tool_result", completion })
    })
  }

  async recordWorldStateUpdate(
    execution: ExecutionContext,
    items: readonly ResponseItemEnvelope[],
    update: Readonly<{
      full: boolean
      state: JsonObject
      snapshot: JsonObject
    }>,
  ): Promise<void> {
    const active = this.#requireExecution(execution)

    await this.#withContextMutation(async () => {
      this.#requireExecution(execution)
      if (items.length > 0) {
        this.#contextManager.record(items)
      }
      this.#contextManager.setWorldStateBaseline(update.snapshot)
      await this.#appendRollout([
        ...items.map((item): RolloutItem => ({ type: "response_item", item })),
        {
          type: "world_state",
          turnId: active.input.submissionId,
          full: update.full,
          state: update.state,
        },
      ])
      this.#notifyExecution(execution, {
        type: "world_state",
        snapshot: update.snapshot,
      })
    })
  }

  // Apply the replacement only after its durable checkpoint, preserving the
  // concurrent tail under the same mutation lock used by conversation records.
  async checkpointHistory(
    execution: ExecutionContext,
    input: Readonly<{
      replacement: readonly ResponseItemEnvelope[]
      summary: string
      baseHistoryLength: number
      expectedPrefix?: readonly ResponseItemEnvelope[]
      worldState?: Readonly<{
        state: JsonObject
        snapshot: JsonObject
      }>
    }>,
  ): Promise<boolean> {
    const active = this.#requireExecution(execution)

    return this.#withContextMutation(async () => {
      this.#requireExecution(execution)
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
        this.#contextManager.setWorldStateBaseline(input.worldState.snapshot)
      }
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        ...append,
      })
      return true
    })
  }

  async #runForkBarrier(operation: ForkBarrierCommand): Promise<void> {
    try {
      // Settle execution and its accepted writes before the fork snapshot.
      // Later commands remain behind this barrier.
      this.#interruptActiveTurn("conversation_fork")
      await this.#activeTurn?.finalized
      if (this.#activeTurn?.cleanupError !== undefined)
        throw this.#activeTurn.cleanupError
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
            submissionMetadata: { source: "agent", purpose: "message" },
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

  #acceptThreadMessage(
    input: TurnInput,
    targetTurnId: string,
    delivery: "started" | "steered",
    inputItemId?: string,
  ): AcceptedThreadMessage {
    if (input.provenance === undefined)
      throw new Error("Thread message has no source.")
    const envelope = buildInputItem(input, inputItemId)
    const admission: ThreadMessageAdmission = {
      type: "thread_message_admitted",
      ...input.provenance,
      submissionId: input.submissionId,
      targetTurnId,
      inputItemId: envelope.id,
      requestFingerprint: fingerprintTurnInput(input),
      input,
      delivery,
    }
    const accepted: AcceptedThreadMessage = {
      admission,
      envelope,
      durable: false,
      consumed: false,
    }
    this.#threadMessages.set(input.submissionId, accepted)
    this.#submittedInputs.set(input.submissionId, {
      threadId: this.id,
      fingerprint: admission.requestFingerprint,
      source: inputSource(input),
      purpose: inputPurpose(input),
      inputItemId: envelope.id,
      turnId: targetTurnId,
    })
    return accepted
  }

  async #persistThreadMessage(accepted: AcceptedThreadMessage): Promise<void> {
    if (accepted.durable) return
    try {
      if (accepted.append === undefined) {
        if (accepted.appendAttempted) {
          // A previous attempt may already be buffered. Drain and inspect
          // before retrying an uncertain write, never on the ordinary path.
          await this.#store.flushThread(this.id)
          const stored = await this.#store.readThread(this.id)
          const existing = stored?.rollout.find(
            ({ threadId, item }) =>
              threadId === this.id &&
              item.type === "thread_message_admitted" &&
              item.submissionId === accepted.admission.submissionId,
          )
          if (existing !== undefined) {
            if (
              existing.item.type !== "thread_message_admitted" ||
              existing.item.requestFingerprint !==
                accepted.admission.requestFingerprint ||
              existing.item.targetTurnId !== accepted.admission.targetTurnId
            )
              throw new Error("Conflicting durable thread message receipt.")
            accepted.append = {
              throughSeq: existing.seq + 1,
              records: [existing],
            }
          }
        }
        if (accepted.append === undefined) {
          accepted.appendAttempted = true
          accepted.append = await this.#store.appendItems(this.id, [
            accepted.admission,
          ])
        }
      }
      await this.#store.persistThread(this.id, PersistContext.TurnStart)
      await this.#store.flushThread(this.id)
      accepted.durable = true
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        ...accepted.append,
      })
    } catch (error) {
      this.#reportPersistenceError(error)
      throw error
    }
  }

  async recordThreadMessageInput(
    execution: ExecutionContext,
    input: TurnInput,
  ): Promise<void> {
    const active = this.#requireExecution(execution)
    await this.#withContextMutation(async () => {
      if (
        this.#activeTurn !== active ||
        active.finishing ||
        active.abort.signal.aborted
      )
        throw new Error("Turn is no longer active.")
      const accepted = this.#threadMessages.get(input.submissionId)
      if (
        accepted === undefined ||
        !accepted.durable ||
        accepted.admission.targetTurnId !== active.input.submissionId ||
        accepted.admission.requestFingerprint !== fingerprintTurnInput(input)
      )
        throw new Error("Thread message has no matching durable admission.")
      if (accepted.consumed) return
      const admission = accepted.admission
      const append = await this.#store.appendItems(this.id, [
        { type: "response_item", item: accepted.envelope },
        {
          type: "thread_message_consumed",
          sourceThreadId: admission.sourceThreadId,
          sourceRequestId: admission.sourceRequestId,
          submissionId: admission.submissionId,
          targetTurnId: admission.targetTurnId,
          inputItemId: admission.inputItemId,
        },
      ])
      await this.#store.flushThread(this.id)
      accepted.consumed = true
      this.#contextManager.record([accepted.envelope])
      this.#events.send({
        type: "rollout.appended",
        threadId: this.id,
        ...append,
      })
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

export function inputPurpose(input: TurnInput): InputPurpose {
  return (
    input.purpose ??
    (input.goalId !== undefined || input.source === "agent"
      ? "task"
      : "message")
  )
}

export function inputSource(input: TurnInput): InputSource {
  return (
    input.source ??
    (input.provenance !== undefined
      ? "agent"
      : input.goalId === undefined
        ? "human"
        : "runtime")
  )
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
      item.item.role === "assistant"
        ? answerTextParts(
            item.item.content.filter((block) => block.type === "text"),
          )
        : [],
    )
    .map((block) => block.text)
    .join("")
  return text.length === 0 ? null : text
}

function buildInputItem(
  input: TurnInput,
  id = createInputId(),
): ResponseItemEnvelope {
  const submissionMetadata = turnInputSubmissionMetadata(input)
  return {
    id,
    turnId: input.submissionId,
    createdAt: new Date().toISOString(),
    item: inputContentToModelMessage(
      input.content,
      input.goalId,
      input.provenance,
    ),
    ...submissionMetadata,
  }
}

function turnInputSubmissionMetadata(
  input: TurnInput,
): Pick<ResponseItemEnvelope, "submissionMetadata"> {
  return {
    submissionMetadata: {
      source: inputSource(input),
      purpose: inputPurpose(input),
      ...(inputSource(input) === "human" &&
      inputPurpose(input) !== "question_answer"
        ? {}
        : { requestFingerprint: fingerprintTurnInput(input) }),
      content: input.content,
      ...(input.provenance === undefined
        ? {}
        : { provenance: input.provenance }),
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
