import type { EventStore } from "./event-store.ts"
import {
  EventType,
  InputRole,
  type EventEnvelope,
  type EventMetadata,
  type TextContent,
} from "./events.ts"
import {
  createInputId,
  createSessionId,
  createTurnId,
  type InputId,
  type SessionId,
  type TurnId,
} from "./ids.ts"

export type SessionKernel = {
  createSession(input?: CreateSessionInput): Promise<CreateSessionResult>
  admitInput(input: AdmitInputInput): Promise<AdmitInputResult>
  startTurn(input: StartTurnInput): Promise<StartTurnResult>
}

export type CreateSessionInput = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly parentSessionId?: SessionId
  readonly metadata?: EventMetadata
}

export type CreateSessionResult = {
  readonly sessionId: SessionId
  readonly event: EventEnvelope
}

export type AdmitInputInput = {
  readonly sessionId: SessionId
  readonly content: TextContent
  readonly role?: InputRole
  readonly parentInputId?: InputId
  readonly metadata?: EventMetadata
}

export type AdmitInputResult = {
  readonly inputId: InputId
  readonly event: EventEnvelope
}

export type StartTurnInput = {
  readonly sessionId: SessionId
  readonly inputId: InputId
  readonly parentTurnId?: TurnId
  readonly metadata?: EventMetadata
}

export type StartTurnResult = {
  readonly turnId: TurnId
  readonly events: readonly EventEnvelope[]
}

export function createSessionKernel(eventStore: EventStore): SessionKernel {
  return {
    async createSession(input = {}) {
      const sessionId = createSessionId()
      const event = await eventStore.appendEvent(sessionId, {
        type: EventType.SessionCreated,
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.workingDirectory === undefined
            ? {}
            : { workingDirectory: input.workingDirectory }),
          ...(input.parentSessionId === undefined
            ? {}
            : { parentSessionId: input.parentSessionId }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })

      return { sessionId, event }
    },

    async admitInput(input) {
      const events = await eventStore.readEvents(input.sessionId)
      requireSessionCreated(events, input.sessionId)
      if (input.parentInputId !== undefined) {
        requireInputAdmitted(events, input.parentInputId)
      }

      const inputId = createInputId()
      const event = await eventStore.appendEvent(input.sessionId, {
        type: EventType.InputAdmitted,
        data: {
          inputId,
          role: input.role ?? InputRole.User,
          content: input.content,
          ...(input.parentInputId === undefined
            ? {}
            : { parentInputId: input.parentInputId }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })

      return { inputId, event }
    },

    async startTurn(input) {
      const events = await eventStore.readEvents(input.sessionId)
      requireSessionCreated(events, input.sessionId)
      requireInputReadyForTurn(events, input.inputId)
      if (input.parentTurnId !== undefined) {
        requireTurnStarted(events, input.parentTurnId)
      }

      const turnId = createTurnId()
      return {
        turnId,
        events: await eventStore.appendEvents(input.sessionId, [
          {
            type: EventType.InputPromoted,
            data: {
              inputId: input.inputId,
              turnId,
            },
          },
          {
            type: EventType.TurnStarted,
            data: {
              turnId,
              inputId: input.inputId,
              ...(input.parentTurnId === undefined
                ? {}
                : { parentTurnId: input.parentTurnId }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: input.metadata }),
            },
          },
        ]),
      }
    },
  }
}

function requireSessionCreated(
  events: readonly EventEnvelope[],
  sessionId: SessionId,
): void {
  if (events.at(0)?.type === EventType.SessionCreated) return
  throw new Error(`Session ${sessionId} has not been created.`)
}

function requireInputReadyForTurn(
  events: readonly EventEnvelope[],
  inputId: InputId,
): void {
  requireInputAdmitted(events, inputId)

  if (
    events.some(
      (event) =>
        event.type === EventType.InputCancelled &&
        event.data.inputId === inputId,
    )
  ) {
    throw new Error(`Input ${inputId} has been cancelled.`)
  }

  if (
    events.some(
      (event) =>
        event.type === EventType.InputPromoted &&
        event.data.inputId === inputId,
    )
  ) {
    throw new Error(`Input ${inputId} has already been promoted.`)
  }
}

function requireInputAdmitted(
  events: readonly EventEnvelope[],
  inputId: InputId,
): void {
  if (
    events.some(
      (event) =>
        event.type === EventType.InputAdmitted &&
        event.data.inputId === inputId,
    )
  ) {
    return
  }

  throw new Error(`Input ${inputId} has not been admitted.`)
}

function requireTurnStarted(
  events: readonly EventEnvelope[],
  turnId: TurnId,
): void {
  if (
    events.some(
      (event) =>
        event.type === EventType.TurnStarted && event.data.turnId === turnId,
    )
  ) {
    return
  }

  throw new Error(`Turn ${turnId} has not been started.`)
}
