import type { Session, SessionSnapshot } from "./session.ts"
import type {
  SessionEvent,
  SessionStatus,
  SubmitTurnInput,
  TurnInputSubmission,
} from "./session-io.ts"

// Public agent-thread handle. Session remains the owner of state and execution;
// SessionIo is the only ordinary command/event transport exposed to callers.
export class AgentThread {
  readonly id: string
  readonly #session: Session

  constructor(session: Session) {
    this.id = session.id
    this.#session = session
  }

  get status(): SessionStatus {
    return this.#session.io.status
  }

  get termination(): Promise<void> {
    return this.#session.io.termination
  }

  startOrSteer(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#session.io.startOrSteer(input)
  }

  startIfIdle(input: SubmitTurnInput): Promise<TurnInputSubmission> {
    return this.#session.io.startIfIdle(input)
  }

  steer(
    input: SubmitTurnInput,
    expectedTurnId: string,
  ): Promise<TurnInputSubmission> {
    return this.#session.io.steer(input, expectedTurnId)
  }

  interrupt(reason?: string): Promise<void> {
    return this.#session.io.interrupt(reason)
  }

  interruptTurn(expectedTurnId: string, reason?: string): Promise<boolean> {
    return this.#session.io.interruptTurn(expectedTurnId, reason)
  }

  shutdownAndWait(): Promise<void> {
    return this.#session.io.shutdownAndWait()
  }

  nextEvent(): Promise<SessionEvent | undefined> {
    return this.#session.io.nextEvent()
  }

  subscribeStatus(listener: (status: SessionStatus) => void): () => void {
    return this.#session.io.subscribeStatus(listener)
  }

  snapshot(): SessionSnapshot {
    return this.#session.snapshot()
  }

  withForkBarrier<T>(
    run: (snapshot: SessionSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.#session.withForkBarrier(run)
  }
}
