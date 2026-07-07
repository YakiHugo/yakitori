import type { EventStore } from "./event-store.ts"
import {
  EventType,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type ItemKind,
  ItemStatus,
  type InputRole,
  type KernelError,
  type TextContent,
} from "./events.ts"

export const InputState = {
  Admitted: "admitted",
  Cancelled: "cancelled",
  Promoted: "promoted",
} as const

export const TurnState = {
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
  Started: "started",
} as const

export type InputState = (typeof InputState)[keyof typeof InputState]
export type TurnState = (typeof TurnState)[keyof typeof TurnState]

export type SessionProjection = {
  readonly id: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
  readonly inputs: readonly InputProjection[]
  readonly items: readonly ItemProjection[]
  readonly turns: readonly TurnProjection[]
}

export type InputProjection = {
  readonly inputId: string
  readonly role: InputRole
  readonly content: TextContent
  readonly state: InputState
  readonly admittedAt: string
  readonly updatedAt: string
  readonly parentInputId?: string
  readonly turnId?: string
  readonly cancelledReason?: string
  readonly metadata?: EventMetadata
}

export type TurnProjection = {
  readonly turnId: string
  readonly inputId: string
  readonly state: TurnState
  readonly startedAt: string
  readonly updatedAt: string
  readonly parentTurnId?: string
  readonly outputItemId?: string
  readonly error?: KernelError
  readonly cancelledReason?: string
  readonly metadata?: EventMetadata
  readonly itemIds: readonly string[]
}

export type ItemProjection = {
  readonly itemId: string
  readonly turnId: string
  readonly kind: ItemKind
  readonly content: ItemContent
  readonly status: ItemStatus
  readonly appendedAt: string
  readonly updatedAt: string
  readonly parentItemId?: string
  readonly providerMetadata?: EventMetadata
  readonly metadata?: EventMetadata
}

export type SessionProjector = {
  project(sessionId: string): Promise<SessionProjection | undefined>
}

type MutableSessionProjection = {
  id: string
  seq: number
  createdAt: string
  updatedAt: string
  title?: string
  workingDirectory?: string
  parentSessionId?: string
  metadata?: EventMetadata
}

type MutableInputProjection = {
  inputId: string
  role: InputRole
  content: TextContent
  state: InputState
  admittedAt: string
  updatedAt: string
  parentInputId?: string
  turnId?: string
  cancelledReason?: string
  metadata?: EventMetadata
}

type MutableTurnProjection = {
  turnId: string
  inputId: string
  state: TurnState
  startedAt: string
  updatedAt: string
  parentTurnId?: string
  outputItemId?: string
  error?: KernelError
  cancelledReason?: string
  metadata?: EventMetadata
  itemIds: string[]
}

type MutableItemProjection = {
  itemId: string
  turnId: string
  kind: ItemKind
  content: ItemContent
  status: ItemStatus
  appendedAt: string
  updatedAt: string
  parentItemId?: string
  providerMetadata?: EventMetadata
  metadata?: EventMetadata
}

export function createSessionProjector(
  eventStore: EventStore,
): SessionProjector {
  return {
    async project(sessionId) {
      return projectSession(await eventStore.readEvents(sessionId))
    },
  }
}

export function projectSession(
  events: readonly EventEnvelope[],
): SessionProjection | undefined {
  const firstEvent = events.at(0)
  if (!firstEvent) return undefined
  if (firstEvent.type !== EventType.SessionCreated) {
    throw new Error("Session projection must start with session.created.")
  }
  if (firstEvent.seq !== 1) {
    throw new Error("Session projection must start at sequence 1.")
  }

  const session = createInitialSessionProjection(firstEvent)
  const inputs = new Map<string, MutableInputProjection>()
  const items = new Map<string, MutableItemProjection>()
  const turns = new Map<string, MutableTurnProjection>()

  for (const event of events.slice(1)) {
    applyEvent(session, inputs, items, turns, event)
  }

  return {
    ...session,
    inputs: Array.from(inputs.values()),
    items: Array.from(items.values()),
    turns: Array.from(turns.values()),
  }
}

function createInitialSessionProjection(
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.SessionCreated }
  >,
): MutableSessionProjection {
  const session: MutableSessionProjection = {
    id: event.sessionId,
    seq: event.seq,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  }

  applySessionCreated(session, event)
  return session
}

function applyEvent(
  session: MutableSessionProjection,
  inputs: Map<string, MutableInputProjection>,
  items: Map<string, MutableItemProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: EventEnvelope,
): void {
  assertNextSessionEvent(session, event)
  session.seq = event.seq
  session.updatedAt = event.createdAt

  switch (event.type) {
    case EventType.SessionCreated:
      throw new Error("Session projection cannot contain multiple sessions.")
    case EventType.SessionMetadataUpdated:
      applySessionMetadataUpdated(session, event)
      return
    case EventType.InputAdmitted:
      applyInputAdmitted(inputs, event)
      return
    case EventType.InputPromoted:
      applyInputPromoted(inputs, event)
      return
    case EventType.InputCancelled:
      applyInputCancelled(inputs, event)
      return
    case EventType.TurnStarted:
      applyTurnStarted(inputs, turns, event)
      return
    case EventType.TurnCompleted:
      applyTurnCompleted(items, turns, event)
      return
    case EventType.TurnFailed:
      applyTurnFailed(turns, event)
      return
    case EventType.TurnCancelled:
      applyTurnCancelled(turns, event)
      return
    case EventType.ItemAppended:
      applyItemAppended(items, turns, event)
      return
    case EventType.ItemUpdated:
      applyItemUpdated(items, event)
      return
    case EventType.ItemCompleted:
      applyItemCompleted(items, event)
      return
    default:
      return
  }
}

function applySessionCreated(
  session: MutableSessionProjection,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.SessionCreated }
  >,
): void {
  if (event.data.title !== undefined) session.title = event.data.title
  if (event.data.workingDirectory !== undefined) {
    session.workingDirectory = event.data.workingDirectory
  }
  if (event.data.parentSessionId !== undefined) {
    session.parentSessionId = event.data.parentSessionId
  }
  if (event.data.metadata !== undefined) session.metadata = event.data.metadata
}

function applySessionMetadataUpdated(
  session: MutableSessionProjection,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.SessionMetadataUpdated }
  >,
): void {
  if (event.data.title !== undefined) session.title = event.data.title
  if (event.data.metadata !== undefined) session.metadata = event.data.metadata
}

function applyInputAdmitted(
  inputs: Map<string, MutableInputProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.InputAdmitted }
  >,
): void {
  if (inputs.has(event.data.inputId)) {
    throw new Error(`Input ${event.data.inputId} has already been admitted.`)
  }

  inputs.set(event.data.inputId, {
    inputId: event.data.inputId,
    role: event.data.role,
    content: event.data.content,
    state: InputState.Admitted,
    admittedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.parentInputId === undefined
      ? {}
      : { parentInputId: event.data.parentInputId }),
    ...(event.data.metadata === undefined
      ? {}
      : { metadata: event.data.metadata }),
  })
}

function applyInputPromoted(
  inputs: Map<string, MutableInputProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.InputPromoted }
  >,
): void {
  const input = requireInput(inputs, event.data.inputId)
  if (input.state === InputState.Cancelled) {
    throw new Error(`Input ${event.data.inputId} has been cancelled.`)
  }
  if (input.turnId !== undefined) {
    throw new Error(`Input ${event.data.inputId} has already been promoted.`)
  }

  input.state = InputState.Promoted
  input.turnId = event.data.turnId
  input.updatedAt = event.createdAt
}

function applyInputCancelled(
  inputs: Map<string, MutableInputProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.InputCancelled }
  >,
): void {
  const input = requireInput(inputs, event.data.inputId)
  if (input.state === InputState.Promoted) {
    throw new Error(`Input ${event.data.inputId} has already been promoted.`)
  }

  input.state = InputState.Cancelled
  input.updatedAt = event.createdAt
  if (event.data.reason !== undefined) {
    input.cancelledReason = event.data.reason
  }
}

function applyTurnStarted(
  inputs: Map<string, MutableInputProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.TurnStarted }
  >,
): void {
  if (turns.has(event.data.turnId)) {
    throw new Error(`Turn ${event.data.turnId} has already been started.`)
  }

  requireInput(inputs, event.data.inputId)
  turns.set(event.data.turnId, {
    turnId: event.data.turnId,
    inputId: event.data.inputId,
    state: TurnState.Started,
    startedAt: event.createdAt,
    updatedAt: event.createdAt,
    itemIds: [],
    ...(event.data.parentTurnId === undefined
      ? {}
      : { parentTurnId: event.data.parentTurnId }),
    ...(event.data.metadata === undefined
      ? {}
      : { metadata: event.data.metadata }),
  })
}

function applyTurnCompleted(
  items: Map<string, MutableItemProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.TurnCompleted }
  >,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  turn.state = TurnState.Completed
  turn.updatedAt = event.createdAt
  if (event.data.outputItemId !== undefined) {
    requireItem(items, event.data.turnId, event.data.outputItemId)
    turn.outputItemId = event.data.outputItemId
  }
  if (event.data.metadata !== undefined) turn.metadata = event.data.metadata
}

function applyTurnFailed(
  turns: Map<string, MutableTurnProjection>,
  event: Extract<EventEnvelope, { readonly type: typeof EventType.TurnFailed }>,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  turn.state = TurnState.Failed
  turn.error = event.data.error
  turn.updatedAt = event.createdAt
}

function applyTurnCancelled(
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.TurnCancelled }
  >,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  turn.state = TurnState.Cancelled
  turn.updatedAt = event.createdAt
  if (event.data.reason !== undefined) {
    turn.cancelledReason = event.data.reason
  }
}

function applyItemAppended(
  items: Map<string, MutableItemProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ItemAppended }
  >,
): void {
  if (items.has(event.data.itemId)) {
    throw new Error(`Item ${event.data.itemId} has already been appended.`)
  }

  const turn = requireActiveTurn(turns, event.data.turnId)
  if (event.data.parentItemId !== undefined) {
    requireItem(items, event.data.turnId, event.data.parentItemId)
  }

  items.set(event.data.itemId, {
    itemId: event.data.itemId,
    turnId: event.data.turnId,
    kind: event.data.kind,
    content: event.data.content,
    status: event.data.status ?? ItemStatus.InProgress,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.parentItemId === undefined
      ? {}
      : { parentItemId: event.data.parentItemId }),
    ...(event.data.providerMetadata === undefined
      ? {}
      : { providerMetadata: event.data.providerMetadata }),
  })
  turn.itemIds.push(event.data.itemId)
}

function applyItemUpdated(
  items: Map<string, MutableItemProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ItemUpdated }
  >,
): void {
  const item = requireActiveItem(items, event.data.turnId, event.data.itemId)
  if (event.data.content !== undefined) item.content = event.data.content
  if (event.data.status !== undefined) item.status = event.data.status
  if (event.data.metadata !== undefined) item.metadata = event.data.metadata
  item.updatedAt = event.createdAt
}

function applyItemCompleted(
  items: Map<string, MutableItemProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ItemCompleted }
  >,
): void {
  const item = requireActiveItem(items, event.data.turnId, event.data.itemId)
  item.status = event.data.status
  item.updatedAt = event.createdAt
  if (event.data.metadata !== undefined) item.metadata = event.data.metadata
}

function assertNextSessionEvent(
  session: MutableSessionProjection,
  event: EventEnvelope,
): void {
  if (event.sessionId !== session.id) {
    throw new Error(`Event ${event.id} belongs to another session.`)
  }
  if (event.seq !== session.seq + 1) {
    throw new Error(
      `Session projection expected sequence ${session.seq + 1}, got ${event.seq}.`,
    )
  }
}

function requireInput(
  inputs: Map<string, MutableInputProjection>,
  inputId: string,
): MutableInputProjection {
  const input = inputs.get(inputId)
  if (input) return input
  throw new Error(`Input ${inputId} has not been admitted.`)
}

function requireItem(
  items: Map<string, MutableItemProjection>,
  turnId: string,
  itemId: string,
): MutableItemProjection {
  const item = items.get(itemId)
  if (!item) throw new Error(`Item ${itemId} has not been appended.`)
  if (item.turnId === turnId) return item
  throw new Error(`Item ${itemId} does not belong to turn ${turnId}.`)
}

function requireActiveItem(
  items: Map<string, MutableItemProjection>,
  turnId: string,
  itemId: string,
): MutableItemProjection {
  const item = requireItem(items, turnId, itemId)
  if (item.status === ItemStatus.InProgress) return item
  throw new Error(`Item ${itemId} is already ${item.status}.`)
}

function requireActiveTurn(
  turns: Map<string, MutableTurnProjection>,
  turnId: string,
): MutableTurnProjection {
  const turn = turns.get(turnId)
  if (!turn) throw new Error(`Turn ${turnId} has not been started.`)
  if (turn.state === TurnState.Started) return turn
  throw new Error(`Turn ${turnId} is already ${turn.state}.`)
}
