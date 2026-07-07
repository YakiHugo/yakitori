import type { EventStore } from "./event-store.ts"
import {
  EventType,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type ItemKind,
  ItemStatus,
  type InputRole,
  type JsonValue,
  type KernelError,
  PermissionBehavior,
  type PermissionBehavior as PermissionBehaviorValue,
  type PermissionDecisionReason,
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

export const PermissionState = {
  Cancelled: "cancelled",
  Requested: "requested",
  Resolved: "resolved",
} as const

export const ToolState = {
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
  Requested: "requested",
  Started: "started",
} as const

export type InputState = (typeof InputState)[keyof typeof InputState]
export type TurnState = (typeof TurnState)[keyof typeof TurnState]
export type PermissionState =
  (typeof PermissionState)[keyof typeof PermissionState]
export type ToolState = (typeof ToolState)[keyof typeof ToolState]

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
  readonly permissions: readonly PermissionProjection[]
  readonly tools: readonly ToolProjection[]
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
  readonly permissionRequestIds: readonly string[]
  readonly toolCallIds: readonly string[]
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

export type PermissionProjection = {
  readonly permissionRequestId: string
  readonly turnId: string
  readonly action: string
  readonly state: PermissionState
  readonly requestedAt: string
  readonly updatedAt: string
  readonly subject?: string
  readonly toolCallId?: string
  readonly reason?: string
  readonly behavior?: PermissionBehaviorValue
  readonly decisionReason?: PermissionDecisionReason
  readonly cancelledReason?: string
  readonly metadata?: EventMetadata
}

export type ToolProgressProjection = {
  readonly createdAt: string
  readonly message?: string
  readonly data?: JsonValue
}

export type ToolProjection = {
  readonly toolCallId: string
  readonly turnId: string
  readonly name: string
  readonly input: JsonValue
  readonly state: ToolState
  readonly requestedAt: string
  readonly updatedAt: string
  readonly requestItemId?: string
  readonly resultItemId?: string
  readonly permissionRequestId?: string
  readonly providerMetadata?: EventMetadata
  readonly output?: JsonValue
  readonly error?: KernelError
  readonly cancelledReason?: string
  readonly progress: readonly ToolProgressProjection[]
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
  permissionRequestIds: string[]
  toolCallIds: string[]
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

type MutablePermissionProjection = {
  permissionRequestId: string
  turnId: string
  action: string
  state: PermissionState
  requestedAt: string
  updatedAt: string
  subject?: string
  toolCallId?: string
  reason?: string
  behavior?: PermissionBehaviorValue
  decisionReason?: PermissionDecisionReason
  cancelledReason?: string
  metadata?: EventMetadata
}

type MutableToolProgressProjection = {
  createdAt: string
  message?: string
  data?: JsonValue
}

type MutableToolProjection = {
  toolCallId: string
  turnId: string
  name: string
  input: JsonValue
  state: ToolState
  requestedAt: string
  updatedAt: string
  requestItemId?: string
  resultItemId?: string
  permissionRequestId?: string
  providerMetadata?: EventMetadata
  output?: JsonValue
  error?: KernelError
  cancelledReason?: string
  progress: MutableToolProgressProjection[]
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
  const permissions = new Map<string, MutablePermissionProjection>()
  const tools = new Map<string, MutableToolProjection>()
  const turns = new Map<string, MutableTurnProjection>()

  for (const event of events.slice(1)) {
    applyEvent(session, inputs, items, permissions, tools, turns, event)
  }

  return {
    ...session,
    inputs: Array.from(inputs.values()),
    items: Array.from(items.values()),
    permissions: Array.from(permissions.values()),
    tools: Array.from(tools.values()),
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
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
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
      applyTurnCompleted(items, permissions, tools, turns, event)
      return
    case EventType.TurnFailed:
      applyTurnFailed(items, permissions, tools, turns, event)
      return
    case EventType.TurnCancelled:
      applyTurnCancelled(items, permissions, tools, turns, event)
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
    case EventType.PermissionRequested:
      applyPermissionRequested(permissions, turns, event)
      return
    case EventType.PermissionResolved:
      applyPermissionResolved(permissions, turns, event)
      return
    case EventType.PermissionCancelled:
      applyPermissionCancelled(permissions, turns, event)
      return
    case EventType.ToolRequested:
      applyToolRequested(items, permissions, tools, turns, event)
      return
    case EventType.ToolStarted:
      applyToolStarted(permissions, tools, turns, event)
      return
    case EventType.ToolProgress:
      applyToolProgress(tools, turns, event)
      return
    case EventType.ToolCompleted:
      applyToolCompleted(items, tools, turns, event)
      return
    case EventType.ToolFailed:
      applyToolFailed(tools, turns, event)
      return
    case EventType.ToolCancelled:
      applyToolCancelled(tools, turns, event)
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
    permissionRequestIds: [],
    toolCallIds: [],
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
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.TurnCompleted }
  >,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  requireNoOpenTurnWork(items, permissions, tools, event.data.turnId)
  turn.state = TurnState.Completed
  turn.updatedAt = event.createdAt
  if (event.data.outputItemId !== undefined) {
    requireCompletedItem(items, event.data.turnId, event.data.outputItemId)
    turn.outputItemId = event.data.outputItemId
  }
  if (event.data.metadata !== undefined) turn.metadata = event.data.metadata
}

function applyTurnFailed(
  items: Map<string, MutableItemProjection>,
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<EventEnvelope, { readonly type: typeof EventType.TurnFailed }>,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  requireNoOpenTurnWork(items, permissions, tools, event.data.turnId)
  turn.state = TurnState.Failed
  turn.error = event.data.error
  turn.updatedAt = event.createdAt
}

function applyTurnCancelled(
  items: Map<string, MutableItemProjection>,
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.TurnCancelled }
  >,
): void {
  const turn = requireActiveTurn(turns, event.data.turnId)
  requireNoOpenTurnWork(items, permissions, tools, event.data.turnId)
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

function applyPermissionRequested(
  permissions: Map<string, MutablePermissionProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.PermissionRequested }
  >,
): void {
  if (permissions.has(event.data.permissionRequestId)) {
    throw new Error(
      `Permission ${event.data.permissionRequestId} has already been requested.`,
    )
  }

  const turn = requireActiveTurn(turns, event.data.turnId)
  permissions.set(event.data.permissionRequestId, {
    permissionRequestId: event.data.permissionRequestId,
    turnId: event.data.turnId,
    action: event.data.action,
    state: PermissionState.Requested,
    requestedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.subject === undefined
      ? {}
      : { subject: event.data.subject }),
    ...(event.data.toolCallId === undefined
      ? {}
      : { toolCallId: event.data.toolCallId }),
    ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
    ...(event.data.metadata === undefined
      ? {}
      : { metadata: event.data.metadata }),
  })
  turn.permissionRequestIds.push(event.data.permissionRequestId)
}

function applyPermissionResolved(
  permissions: Map<string, MutablePermissionProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.PermissionResolved }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const permission = requirePendingPermission(
    permissions,
    event.data.turnId,
    event.data.permissionRequestId,
  )
  permission.state = PermissionState.Resolved
  permission.behavior = event.data.behavior
  permission.updatedAt = event.createdAt
  if (event.data.reason !== undefined)
    permission.decisionReason = event.data.reason
  if (event.data.metadata !== undefined)
    permission.metadata = event.data.metadata
}

function applyPermissionCancelled(
  permissions: Map<string, MutablePermissionProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.PermissionCancelled }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const permission = requirePendingPermission(
    permissions,
    event.data.turnId,
    event.data.permissionRequestId,
  )
  permission.state = PermissionState.Cancelled
  permission.updatedAt = event.createdAt
  if (event.data.reason !== undefined) {
    permission.cancelledReason = event.data.reason
  }
}

function applyToolRequested(
  items: Map<string, MutableItemProjection>,
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ToolRequested }
  >,
): void {
  if (tools.has(event.data.toolCallId)) {
    throw new Error(`Tool ${event.data.toolCallId} has already been requested.`)
  }

  const turn = requireActiveTurn(turns, event.data.turnId)
  if (event.data.itemId !== undefined) {
    requireItem(items, event.data.turnId, event.data.itemId)
  }
  if (event.data.permissionRequestId !== undefined) {
    requirePermission(
      permissions,
      event.data.turnId,
      event.data.permissionRequestId,
    )
  }

  tools.set(event.data.toolCallId, {
    toolCallId: event.data.toolCallId,
    turnId: event.data.turnId,
    name: event.data.name,
    input: event.data.input,
    state: ToolState.Requested,
    requestedAt: event.createdAt,
    updatedAt: event.createdAt,
    progress: [],
    ...(event.data.itemId === undefined
      ? {}
      : { requestItemId: event.data.itemId }),
    ...(event.data.permissionRequestId === undefined
      ? {}
      : { permissionRequestId: event.data.permissionRequestId }),
    ...(event.data.providerMetadata === undefined
      ? {}
      : { providerMetadata: event.data.providerMetadata }),
  })
  turn.toolCallIds.push(event.data.toolCallId)
}

function applyToolStarted(
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ToolStarted }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const tool = requireRequestedTool(
    tools,
    event.data.turnId,
    event.data.toolCallId,
  )
  if (tool.permissionRequestId !== undefined) {
    requireAllowedPermission(
      permissions,
      event.data.turnId,
      tool.permissionRequestId,
    )
  }

  tool.state = ToolState.Started
  tool.updatedAt = event.createdAt
}

function applyToolProgress(
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ToolProgress }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const tool = requireStartedTool(
    tools,
    event.data.turnId,
    event.data.toolCallId,
  )
  tool.progress.push({
    createdAt: event.createdAt,
    ...(event.data.message === undefined
      ? {}
      : { message: event.data.message }),
    ...(event.data.data === undefined ? {} : { data: event.data.data }),
  })
  tool.updatedAt = event.createdAt
}

function applyToolCompleted(
  items: Map<string, MutableItemProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ToolCompleted }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const tool = requireStartedTool(
    tools,
    event.data.turnId,
    event.data.toolCallId,
  )
  if (event.data.itemId !== undefined) {
    requireItem(items, event.data.turnId, event.data.itemId)
    tool.resultItemId = event.data.itemId
  }

  tool.state = ToolState.Completed
  tool.output = event.data.output
  tool.updatedAt = event.createdAt
  if (event.data.metadata !== undefined) tool.metadata = event.data.metadata
}

function applyToolFailed(
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<EventEnvelope, { readonly type: typeof EventType.ToolFailed }>,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const tool = requireStartedTool(
    tools,
    event.data.turnId,
    event.data.toolCallId,
  )
  tool.state = ToolState.Failed
  tool.error = event.data.error
  tool.updatedAt = event.createdAt
}

function applyToolCancelled(
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ToolCancelled }
  >,
): void {
  requireActiveTurn(turns, event.data.turnId)
  const tool = requireOpenTool(tools, event.data.turnId, event.data.toolCallId)
  tool.state = ToolState.Cancelled
  tool.updatedAt = event.createdAt
  if (event.data.reason !== undefined) tool.cancelledReason = event.data.reason
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

function requireCompletedItem(
  items: Map<string, MutableItemProjection>,
  turnId: string,
  itemId: string,
): MutableItemProjection {
  const item = requireItem(items, turnId, itemId)
  if (item.status === ItemStatus.Completed) return item
  throw new Error(`Item ${itemId} is ${item.status}.`)
}

function requirePermission(
  permissions: Map<string, MutablePermissionProjection>,
  turnId: string,
  permissionRequestId: string,
): MutablePermissionProjection {
  const permission = permissions.get(permissionRequestId)
  if (!permission) {
    throw new Error(`Permission ${permissionRequestId} has not been requested.`)
  }
  if (permission.turnId === turnId) return permission
  throw new Error(
    `Permission ${permissionRequestId} does not belong to turn ${turnId}.`,
  )
}

function requirePendingPermission(
  permissions: Map<string, MutablePermissionProjection>,
  turnId: string,
  permissionRequestId: string,
): MutablePermissionProjection {
  const permission = requirePermission(permissions, turnId, permissionRequestId)
  if (permission.state === PermissionState.Requested) return permission
  throw new Error(
    `Permission ${permissionRequestId} is already ${permission.state}.`,
  )
}

function requireAllowedPermission(
  permissions: Map<string, MutablePermissionProjection>,
  turnId: string,
  permissionRequestId: string,
): MutablePermissionProjection {
  const permission = requirePermission(permissions, turnId, permissionRequestId)
  if (
    permission.state === PermissionState.Resolved &&
    permission.behavior === PermissionBehavior.Allow
  ) {
    return permission
  }
  if (permission.state === PermissionState.Resolved) {
    throw new Error(
      `Permission ${permissionRequestId} resolved with ${permission.behavior}.`,
    )
  }
  throw new Error(`Permission ${permissionRequestId} has not been allowed.`)
}

function requireTool(
  tools: Map<string, MutableToolProjection>,
  turnId: string,
  toolCallId: string,
): MutableToolProjection {
  const tool = tools.get(toolCallId)
  if (!tool) throw new Error(`Tool ${toolCallId} has not been requested.`)
  if (tool.turnId === turnId) return tool
  throw new Error(`Tool ${toolCallId} does not belong to turn ${turnId}.`)
}

function requireRequestedTool(
  tools: Map<string, MutableToolProjection>,
  turnId: string,
  toolCallId: string,
): MutableToolProjection {
  const tool = requireTool(tools, turnId, toolCallId)
  if (tool.state === ToolState.Requested) return tool
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
}

function requireStartedTool(
  tools: Map<string, MutableToolProjection>,
  turnId: string,
  toolCallId: string,
): MutableToolProjection {
  const tool = requireTool(tools, turnId, toolCallId)
  if (tool.state === ToolState.Started) return tool
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
}

function requireOpenTool(
  tools: Map<string, MutableToolProjection>,
  turnId: string,
  toolCallId: string,
): MutableToolProjection {
  const tool = requireTool(tools, turnId, toolCallId)
  if (tool.state === ToolState.Requested || tool.state === ToolState.Started) {
    return tool
  }
  throw new Error(`Tool ${toolCallId} is already ${tool.state}.`)
}

function requireNoOpenTurnWork(
  items: Map<string, MutableItemProjection>,
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turnId: string,
): void {
  const item = Array.from(items.values()).find(
    (candidate) =>
      candidate.turnId === turnId && candidate.status === ItemStatus.InProgress,
  )
  if (item) throw new Error(`Turn ${turnId} has open item ${item.itemId}.`)

  const permission = Array.from(permissions.values()).find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.state === PermissionState.Requested,
  )
  if (permission) {
    throw new Error(
      `Turn ${turnId} has pending permission ${permission.permissionRequestId}.`,
    )
  }

  const tool = Array.from(tools.values()).find(
    (candidate) =>
      candidate.turnId === turnId &&
      (candidate.state === ToolState.Requested ||
        candidate.state === ToolState.Started),
  )
  if (tool) throw new Error(`Turn ${turnId} has open tool ${tool.toolCallId}.`)
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
