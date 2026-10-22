import { createRequestId } from "../kernel/ids.ts"
import { isThreadMessageProvenance } from "../protocol/input-queue.ts"
import type { SessionSnapshot } from "./session.ts"
import type {
  AgentStatus,
  SessionEndpoints,
  SessionEvent,
  SessionEventReceiver,
  SessionIdleCause,
  SessionStatus,
  SubmitTurnInput,
  TurnInput,
  TurnInputMode,
  TurnInputSubmission,
} from "./session-io.ts"

export type LocalSessionAccess = Readonly<{
  snapshot(): SessionSnapshot
  withForkBarrier<T>(run: (snapshot: SessionSnapshot) => Promise<T>): Promise<T>
}>

// Endpoints can be forwarded without exposing the local Session owner. The
// event endpoint transfers a single receiver; copying it does not broadcast.
export class AgentThread {
  readonly id: string
  readonly #endpoints: SessionEndpoints
  readonly #events: SessionEventReceiver
  readonly #local: LocalSessionAccess

  constructor(
    input: Readonly<{
      id: string
      endpoints: SessionEndpoints
      local: LocalSessionAccess
    }>,
  ) {
    this.id = input.id
    this.#endpoints = input.endpoints
    this.#events = input.endpoints.events.transfer()
    this.#local = input.local
  }

  get termination(): Promise<void> {
    return this.#endpoints.termination
  }

  get status(): SessionStatus {
    return this.#endpoints.readStatus()
  }

  subscribeStatus(
    listener: (status: SessionStatus, idleCause?: SessionIdleCause) => void,
  ): () => void {
    return this.#endpoints.subscribeStatus(listener)
  }

  get agentStatus(): AgentStatus {
    return this.#endpoints.readAgentStatus()
  }

  subscribeAgentStatus(listener: (status: AgentStatus) => void): () => void {
    return this.#endpoints.subscribeAgentStatus(listener)
  }

  startIfIdle(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "start_if_idle" })
  }

  startOrSteer(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "start_or_steer" })
  }

  compact(requestId: string): Promise<TurnInputSubmission> {
    return new Promise((resolve, reject) => {
      void this.#endpoints
        .send({
          type: "compact",
          requestId,
          reply: { resolve, reject },
        })
        .catch(reject)
    })
  }

  steer(
    input: SubmitTurnInput,
    expectedTurnId: string,
  ): Promise<TurnInputSubmission> {
    return this.#submitTurnInput(input, { type: "steer", expectedTurnId })
  }

  async interrupt(reason?: string): Promise<void> {
    await this.#endpoints.send({
      type: "interrupt",
      ...(reason === undefined ? {} : { reason }),
    })
  }

  async interruptTurn(
    expectedTurnId: string,
    reason?: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      void this.#endpoints
        .send({
          type: "interrupt",
          expectedTurnId,
          ...(reason === undefined ? {} : { reason }),
          reply: { resolve, reject },
        })
        .catch(reject)
    })
  }

  async failAgent(message: string): Promise<AgentStatus> {
    return new Promise((resolve, reject) => {
      void this.#endpoints
        .send({
          type: "fail_agent",
          message,
          reply: { resolve, reject },
        })
        .catch(reject)
    })
  }

  async deliverAgentMessage(messageId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.#endpoints
        .send({
          type: "agent_message",
          messageId,
          text,
          reply: { resolve, reject },
        })
        .catch(reject)
    })
  }

  shutdownAndWait(): Promise<void> {
    return this.#endpoints.shutdown()
  }

  shutdownIfIdle(): Promise<boolean> {
    return this.#endpoints.shutdownIfIdle()
  }

  nextEvent(): Promise<SessionEvent | undefined> {
    return this.#events.receive()
  }

  async #submitTurnInput(
    input: SubmitTurnInput,
    mode: TurnInputMode,
  ): Promise<TurnInputSubmission> {
    input = structuredClone(input)
    if (
      input.provenance !== undefined &&
      (!isThreadMessageProvenance(input.provenance) ||
        input.goalId !== undefined ||
        input.manualCompact === true ||
        input.content.attachments.length > 0 ||
        (input.content.references?.length ?? 0) > 0)
    )
      throw new TypeError(
        "Thread messages require a valid source and text-only external content.",
      )
    const turnInput: TurnInput = {
      submissionId: input.submissionId ?? createRequestId(),
      content: input.content,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.provenance === undefined
        ? {}
        : { provenance: input.provenance }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.parentInputId === undefined
        ? {}
        : { parentInputId: input.parentInputId }),
    }
    return new Promise((resolve, reject) => {
      void this.#endpoints
        .send({
          type: "turn_input",
          input: turnInput,
          mode,
          reply: { resolve, reject },
        })
        .catch(reject)
    })
  }

  snapshot(): SessionSnapshot {
    return this.#local.snapshot()
  }

  withForkBarrier<T>(
    run: (snapshot: SessionSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.#local.withForkBarrier(run)
  }
}
