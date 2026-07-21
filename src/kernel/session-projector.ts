import type { EventStore } from "./event-store.ts"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
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
  type PermissionBehavior,
  type PermissionDecisionReason,
  type TextContent,
} from "./events.ts"
import {
  InputState,
  PermissionState,
  ToolState,
  TurnState,
  replayGuardErrors,
  requireActiveItem,
  requireActiveTurn,
  requireAllowedToolPermissions,
  requireBindablePermission,
  requireCompletedItem,
  requireInput,
  requireItem,
  requireNoActiveTurn,
  requireNoOpenTurnWork,
  requireOpenTool,
  requirePendingPermission,
  requireRequestedTool,
  requireStartedTool,
  requireTurn,
} from "./session-guards.ts"

export { InputState, PermissionState, ToolState, TurnState }

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
  readonly pendingInputs: readonly InputProjection[]
  readonly activeTurn?: TurnProjection
  readonly completedTurns: readonly TurnProjection[]
  readonly failedTurns: readonly TurnProjection[]
  readonly cancelledTurns: readonly TurnProjection[]
  readonly items: readonly ItemProjection[]
  readonly permissions: readonly PermissionProjection[]
  readonly tools: readonly ToolProjection[]
  readonly turns: readonly TurnProjection[]
}

export type InputProjection = {
  readonly requestId?: string
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
  readonly behavior?: PermissionBehavior
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
  requestId?: string
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
  behavior?: PermissionBehavior
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
    throw invalidReplay("Session projection must start with session.created.", {
      actualType: firstEvent.type,
    })
  }
  if (firstEvent.seq !== 1) {
    throw invalidReplay("Session projection must start at sequence 1.", {
      actualSeq: firstEvent.seq,
    })
  }

  const eventIds = new Set<string>()
  assertUniqueEventId(eventIds, firstEvent)
  const session = createInitialSessionProjection(firstEvent)
  const inputs = new Map<string, MutableInputProjection>()
  const items = new Map<string, MutableItemProjection>()
  const permissions = new Map<string, MutablePermissionProjection>()
  const tools = new Map<string, MutableToolProjection>()
  const turns = new Map<string, MutableTurnProjection>()

  for (const event of events.slice(1)) {
    assertUniqueEventId(eventIds, event)
    applyEvent(session, inputs, items, permissions, tools, turns, event)
  }

  const projectedInputs = Array.from(inputs.values())
  const projectedTurns = Array.from(turns.values())
  const activeTurn = projectedTurns.find(
    (turn) => turn.state === TurnState.Started,
  )

  return {
    ...session,
    inputs: projectedInputs,
    pendingInputs: projectedInputs.filter(
      (input) => input.state === InputState.Admitted,
    ),
    ...(activeTurn === undefined ? {} : { activeTurn }),
    completedTurns: projectedTurns.filter(
      (turn) => turn.state === TurnState.Completed,
    ),
    failedTurns: projectedTurns.filter(
      (turn) => turn.state === TurnState.Failed,
    ),
    cancelledTurns: projectedTurns.filter(
      (turn) => turn.state === TurnState.Cancelled,
    ),
    items: Array.from(items.values()),
    permissions: Array.from(permissions.values()),
    tools: Array.from(tools.values()),
    turns: projectedTurns,
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
      throw invalidReplay(
        "Session projection cannot contain multiple sessions.",
        {
          seq: event.seq,
        },
      )
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
      applyItemUpdated(items, turns, event)
      return
    case EventType.ItemCompleted:
      applyItemCompleted(items, turns, event)
      return
    case EventType.PermissionRequested:
      applyPermissionRequested(permissions, tools, turns, event)
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
    default: {
      const unknownEvent: { readonly type: string } = event
      throw invalidReplay(`Unknown event type ${unknownEvent.type}.`, {
        type: unknownEvent.type,
      })
    }
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
    throw invalidReplay(
      `Input ${event.data.inputId} has already been admitted.`,
      {
        inputId: event.data.inputId,
      },
    )
  }
  if (event.data.parentInputId === event.data.inputId) {
    throw invalidReplay(`Input ${event.data.inputId} cannot parent itself.`, {
      inputId: event.data.inputId,
    })
  }
  if (event.data.parentInputId !== undefined) {
    requireInput(inputs.get(event.data.parentInputId), event.data.parentInputId, replayGuardErrors)
  }

  inputs.set(event.data.inputId, {
    ...(event.data.requestId === undefined
      ? {}
      : { requestId: event.data.requestId }),
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
  const input = requireInput(inputs.get(event.data.inputId), event.data.inputId, replayGuardErrors)
  if (input.state === InputState.Cancelled) {
    throw invalidReplay(`Input ${event.data.inputId} has been cancelled.`, {
      inputId: event.data.inputId,
      state: input.state,
    })
  }
  if (input.turnId !== undefined) {
    throw invalidReplay(
      `Input ${event.data.inputId} has already been promoted.`,
      {
        inputId: event.data.inputId,
        turnId: input.turnId,
      },
    )
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
  const input = requireInput(inputs.get(event.data.inputId), event.data.inputId, replayGuardErrors)
  if (input.state !== InputState.Admitted) {
    throw invalidReplay(
      `Input ${event.data.inputId} is already ${input.state}.`,
      {
        inputId: event.data.inputId,
        state: input.state,
      },
    )
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
    throw invalidReplay(`Turn ${event.data.turnId} has already been started.`, {
      turnId: event.data.turnId,
    })
  }

  requireNoActiveTurn(turns.values(), replayGuardErrors)
  const input = requireInput(inputs.get(event.data.inputId), event.data.inputId, replayGuardErrors)
  if (
    input.state !== InputState.Promoted ||
    input.turnId !== event.data.turnId
  ) {
    throw invalidReplay(
      `Turn ${event.data.turnId} must start from promoted input ${event.data.inputId}.`,
      {
        turnId: event.data.turnId,
        inputId: event.data.inputId,
        inputState: input.state,
        promotedTurnId: input.turnId ?? null,
      },
    )
  }
  if (event.data.parentTurnId !== undefined) {
    requireTurn(turns.get(event.data.parentTurnId), event.data.parentTurnId, replayGuardErrors)
  }

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
  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  requireNoOpenTurnWork(items.values(), permissions.values(), tools.values(), event.data.turnId, replayGuardErrors)
  turn.state = TurnState.Completed
  turn.updatedAt = event.createdAt
  if (event.data.outputItemId !== undefined) {
    requireCompletedItem(items.get(event.data.outputItemId), event.data.turnId, event.data.outputItemId, replayGuardErrors)
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
  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  requireNoOpenTurnWork(items.values(), permissions.values(), tools.values(), event.data.turnId, replayGuardErrors)
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
  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  requireNoOpenTurnWork(items.values(), permissions.values(), tools.values(), event.data.turnId, replayGuardErrors)
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
    throw invalidReplay(
      `Item ${event.data.itemId} has already been appended.`,
      {
        itemId: event.data.itemId,
      },
    )
  }

  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  if (event.data.parentItemId !== undefined) {
    requireItem(items.get(event.data.parentItemId), event.data.turnId, event.data.parentItemId, replayGuardErrors)
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
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ItemUpdated }
  >,
): void {
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const item = requireActiveItem(items.get(event.data.itemId), event.data.turnId, event.data.itemId, replayGuardErrors)
  if (event.data.content !== undefined) item.content = event.data.content
  if (event.data.metadata !== undefined) item.metadata = event.data.metadata
  item.updatedAt = event.createdAt
}

function applyItemCompleted(
  items: Map<string, MutableItemProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.ItemCompleted }
  >,
): void {
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const item = requireActiveItem(items.get(event.data.itemId), event.data.turnId, event.data.itemId, replayGuardErrors)
  item.status = event.data.status
  item.updatedAt = event.createdAt
  if (event.data.metadata !== undefined) item.metadata = event.data.metadata
}

function applyPermissionRequested(
  permissions: Map<string, MutablePermissionProjection>,
  tools: Map<string, MutableToolProjection>,
  turns: Map<string, MutableTurnProjection>,
  event: Extract<
    EventEnvelope,
    { readonly type: typeof EventType.PermissionRequested }
  >,
): void {
  if (permissions.has(event.data.permissionRequestId)) {
    throw invalidReplay(
      `Permission ${event.data.permissionRequestId} has already been requested.`,
      {
        permissionRequestId: event.data.permissionRequestId,
      },
    )
  }

  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  if (event.data.toolCallId !== undefined) {
    requireRequestedTool(tools.get(event.data.toolCallId), event.data.turnId, event.data.toolCallId, replayGuardErrors)
  }
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const permission = requirePendingPermission(
    permissions.get(event.data.permissionRequestId),
    event.data.turnId,
    event.data.permissionRequestId,
    replayGuardErrors,
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const permission = requirePendingPermission(
    permissions.get(event.data.permissionRequestId),
    event.data.turnId,
    event.data.permissionRequestId,
    replayGuardErrors,
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
    throw invalidReplay(
      `Tool ${event.data.toolCallId} has already been requested.`,
      {
        toolCallId: event.data.toolCallId,
      },
    )
  }

  const turn = requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  if (event.data.itemId !== undefined) {
    requireItem(items.get(event.data.itemId), event.data.turnId, event.data.itemId, replayGuardErrors)
  }
  if (event.data.permissionRequestId !== undefined) {
    const permission = requireBindablePermission(
      permissions.get(event.data.permissionRequestId),
      event.data.turnId,
      event.data.permissionRequestId,
      replayGuardErrors,
    )
    permission.toolCallId = event.data.toolCallId
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const tool = requireRequestedTool(
    tools.get(event.data.toolCallId),
    event.data.turnId,
    event.data.toolCallId,
    replayGuardErrors,
  )
  requireAllowedToolPermissions(
    permissions.values(),
    event.data.turnId,
    tool,
    replayGuardErrors,
  )

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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const tool = requireStartedTool(
    tools.get(event.data.toolCallId),
    event.data.turnId,
    event.data.toolCallId,
    replayGuardErrors,
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const tool = requireStartedTool(
    tools.get(event.data.toolCallId),
    event.data.turnId,
    event.data.toolCallId,
    replayGuardErrors,
  )
  if (event.data.itemId !== undefined) {
    requireItem(items.get(event.data.itemId), event.data.turnId, event.data.itemId, replayGuardErrors)
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const tool = requireStartedTool(
    tools.get(event.data.toolCallId),
    event.data.turnId,
    event.data.toolCallId,
    replayGuardErrors,
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
  requireActiveTurn(turns.get(event.data.turnId), event.data.turnId, replayGuardErrors)
  const tool = requireOpenTool(tools.get(event.data.toolCallId), event.data.turnId, event.data.toolCallId, replayGuardErrors)
  tool.state = ToolState.Cancelled
  tool.updatedAt = event.createdAt
  if (event.data.reason !== undefined) tool.cancelledReason = event.data.reason
}

function assertNextSessionEvent(
  session: MutableSessionProjection,
  event: EventEnvelope,
): void {
  if (event.sessionId !== session.id) {
    throw invalidReplay(`Event ${event.id} belongs to another session.`, {
      eventId: event.id,
      expectedSessionId: session.id,
      actualSessionId: event.sessionId,
    })
  }
  if (event.seq !== session.seq + 1) {
    throw invalidReplay(
      `Session projection expected sequence ${session.seq + 1}, got ${event.seq}.`,
      {
        expectedSeq: session.seq + 1,
        actualSeq: event.seq,
      },
    )
  }
}

function assertUniqueEventId(
  eventIds: Set<string>,
  event: EventEnvelope,
): void {
  if (!eventIds.has(event.id)) {
    eventIds.add(event.id)
    return
  }
  throw invalidReplay(`Event ${event.id} has already been replayed.`, {
    eventId: event.id,
  })
}

function invalidReplay(message: string, details?: EventMetadata): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidReplay,
    message,
    ...(details === undefined ? {} : { details }),
  })
}
