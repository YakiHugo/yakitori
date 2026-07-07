import type { EventStore } from "./event-store.ts"
import {
  EventType,
  InputRole,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type ItemKind,
  ItemStatus,
  type KernelError,
  type TextContent,
} from "./events.ts"
import {
  createInputId,
  createItemId,
  createSessionId,
  createTurnId,
} from "./ids.ts"
import {
  InputState,
  projectSession,
  TurnState,
  type InputProjection,
  type ItemProjection,
  type SessionProjection,
  type TurnProjection,
} from "./session-projector.ts"

export type SessionKernel = {
  createSession(input?: CreateSessionInput): Promise<CreateSessionResult>
  admitInput(input: AdmitInputInput): Promise<AdmitInputResult>
  startTurn(input: StartTurnInput): Promise<StartTurnResult>
  appendItem(input: AppendItemInput): Promise<AppendItemResult>
  updateItem(input: UpdateItemInput): Promise<UpdateItemResult>
  completeItem(input: CompleteItemInput): Promise<CompleteItemResult>
  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult>
  failTurn(input: FailTurnInput): Promise<FailTurnResult>
  cancelTurn(input: CancelTurnInput): Promise<CancelTurnResult>
}

export type CreateSessionInput = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export type CreateSessionResult = {
  readonly sessionId: string
  readonly event: EventEnvelope
}

export type AdmitInputInput = {
  readonly sessionId: string
  readonly content: TextContent
  readonly role?: InputRole
  readonly parentInputId?: string
  readonly metadata?: EventMetadata
}

export type AdmitInputResult = {
  readonly inputId: string
  readonly event: EventEnvelope
}

export type StartTurnInput = {
  readonly sessionId: string
  readonly inputId: string
  readonly parentTurnId?: string
  readonly metadata?: EventMetadata
}

export type StartTurnResult = {
  readonly turnId: string
  readonly events: readonly EventEnvelope[]
}

export type AppendItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly kind: ItemKind
  readonly content: ItemContent
  readonly parentItemId?: string
  readonly status?: ItemStatus
  readonly providerMetadata?: EventMetadata
}

export type AppendItemResult = {
  readonly itemId: string
  readonly event: EventEnvelope
}

export type UpdateItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly content?: ItemContent
  readonly metadata?: EventMetadata
}

export type UpdateItemResult = {
  readonly event: EventEnvelope
}

export type CompleteItemInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly status?: typeof ItemStatus.Completed | typeof ItemStatus.Failed
  readonly metadata?: EventMetadata
}

export type CompleteItemResult = {
  readonly event: EventEnvelope
}

export type CompleteTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly outputItemId?: string
  readonly metadata?: EventMetadata
}

export type CompleteTurnResult = {
  readonly event: EventEnvelope
}

export type FailTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly error: KernelError
}

export type FailTurnResult = {
  readonly event: EventEnvelope
}

export type CancelTurnInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
}

export type CancelTurnResult = {
  readonly event: EventEnvelope
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
      const session = await readSessionProjection(eventStore, input.sessionId)
      if (input.parentInputId !== undefined) {
        requireInput(session, input.parentInputId)
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
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireInputReadyForTurn(requireInput(session, input.inputId))
      if (input.parentTurnId !== undefined) {
        requireTurnStarted(session, input.parentTurnId)
      }
      requireNoActiveTurn(session)

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

    async appendItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.parentItemId !== undefined) {
        requireItem(session, input.turnId, input.parentItemId)
      }

      const itemId = createItemId()
      const event = await eventStore.appendEvent(input.sessionId, {
        type: EventType.ItemAppended,
        data: {
          itemId,
          turnId: input.turnId,
          kind: input.kind,
          content: input.content,
          ...(input.parentItemId === undefined
            ? {}
            : { parentItemId: input.parentItemId }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.providerMetadata === undefined
            ? {}
            : { providerMetadata: input.providerMetadata }),
        },
      })

      return { itemId, event }
    },

    async updateItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireOpenItem(session, input.turnId, input.itemId)
      requireItemUpdate(input)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ItemUpdated,
          data: {
            itemId: input.itemId,
            turnId: input.turnId,
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
      }
    },

    async completeItem(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      requireOpenItem(session, input.turnId, input.itemId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.ItemCompleted,
          data: {
            itemId: input.itemId,
            turnId: input.turnId,
            status: input.status ?? ItemStatus.Completed,
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
      }
    },

    async completeTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)
      if (input.outputItemId !== undefined) {
        requireItem(session, input.turnId, input.outputItemId)
      }

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.TurnCompleted,
          data: {
            turnId: input.turnId,
            ...(input.outputItemId === undefined
              ? {}
              : { outputItemId: input.outputItemId }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
        }),
      }
    },

    async failTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.TurnFailed,
          data: {
            turnId: input.turnId,
            error: input.error,
          },
        }),
      }
    },

    async cancelTurn(input) {
      const session = await readSessionProjection(eventStore, input.sessionId)
      requireActiveTurn(session, input.turnId)

      return {
        event: await eventStore.appendEvent(input.sessionId, {
          type: EventType.TurnCancelled,
          data: {
            turnId: input.turnId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        }),
      }
    },
  }
}

async function readSessionProjection(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionProjection> {
  const session = projectSession(await eventStore.readEvents(sessionId))
  if (session) return session
  throw new Error(`Session ${sessionId} has not been created.`)
}

function requireInputReadyForTurn(input: InputProjection): void {
  if (input.state === InputState.Cancelled) {
    throw new Error(`Input ${input.inputId} has been cancelled.`)
  }
  if (input.state === InputState.Promoted) {
    throw new Error(`Input ${input.inputId} has already been promoted.`)
  }
}

function requireInput(
  session: SessionProjection,
  inputId: string,
): InputProjection {
  const input = session.inputs.find(
    (candidate) => candidate.inputId === inputId,
  )
  if (input) return input
  throw new Error(`Input ${inputId} has not been admitted.`)
}

function requireTurnStarted(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = session.turns.find((candidate) => candidate.turnId === turnId)
  if (turn) return turn

  throw new Error(`Turn ${turnId} has not been started.`)
}

function requireItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = session.items.find((candidate) => candidate.itemId === itemId)
  if (!item) throw new Error(`Item ${itemId} has not been appended.`)
  if (item.turnId === turnId) return item
  throw new Error(`Item ${itemId} does not belong to turn ${turnId}.`)
}

function requireOpenItem(
  session: SessionProjection,
  turnId: string,
  itemId: string,
): ItemProjection {
  const item = requireItem(session, turnId, itemId)
  if (item.status === ItemStatus.InProgress) return item
  throw new Error(`Item ${itemId} is already ${item.status}.`)
}

function requireItemUpdate(input: UpdateItemInput): void {
  if (input.content !== undefined || input.metadata !== undefined) return
  throw new Error(`Item ${input.itemId} update has no changes.`)
}

function requireNoActiveTurn(session: SessionProjection): void {
  const turn = session.turns.find(
    (candidate) => candidate.state === TurnState.Started,
  )
  if (!turn) return
  throw new Error(
    `Session ${session.id} already has active turn ${turn.turnId}.`,
  )
}

function requireActiveTurn(
  session: SessionProjection,
  turnId: string,
): TurnProjection {
  const turn = requireTurnStarted(session, turnId)
  if (turn.state === TurnState.Started) return turn
  throw new Error(`Turn ${turnId} is already ${turn.state}.`)
}
