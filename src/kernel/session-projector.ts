import type { EventStore } from "./event-store.ts"
import {
  EventType,
  ItemKind,
  ItemStatus,
  isKernelEvent,
  type EventEnvelope,
  type EventMetadata,
  type ItemContent,
  type ItemKind as ItemKindType,
  type ItemStatus as ItemStatusType,
  type JsonValue,
  type KernelError,
  type PermissionBehavior,
  type PermissionDecisionReason,
  type StoredEventEnvelope,
  type TextContent,
  type TurnExecutionContext,
  type InputRole,
} from "./events.ts"
import {
  InputState,
  PermissionState,
  ToolState,
  TurnState,
  type InputState as InputStateType,
  type PermissionState as PermissionStateType,
  type ToolState as ToolStateType,
  type TurnState as TurnStateType,
} from "./session-states.ts"

export { InputState, PermissionState, ToolState, TurnState }

export type SessionProjection = {
  readonly id: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
  readonly inputs: readonly InputProjection[]
  readonly pendingInputs: readonly InputProjection[]
  readonly activeTurn?: TurnProjection
  readonly completedTurns: readonly TurnProjection[]
  readonly failedTurns: readonly TurnProjection[]
  readonly cancelledTurns: readonly TurnProjection[]
  readonly interruptedTurns: readonly TurnProjection[]
  readonly items: readonly ItemProjection[]
  readonly permissions: readonly PermissionProjection[]
  readonly tools: readonly ToolProjection[]
  readonly turns: readonly TurnProjection[]
}

export type InputProjection = {
  readonly requestId: string
  readonly inputId: string
  readonly role: InputRole
  readonly content: TextContent
  readonly state: InputStateType
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
  readonly state: TurnStateType
  readonly startedAt: string
  readonly updatedAt: string
  readonly parentTurnId?: string
  readonly executionContext?: TurnExecutionContext
  readonly outputMessageId?: string
  readonly error?: KernelError
  readonly cancelledReason?: string
  readonly interruptedReason?: string
  readonly metadata?: EventMetadata
  readonly itemIds: readonly string[]
  readonly permissionRequestIds: readonly string[]
  readonly toolCallIds: readonly string[]
}

export type ItemProjection = {
  readonly itemId: string
  readonly turnId: string
  readonly kind: ItemKindType
  readonly content: ItemContent
  readonly status: ItemStatusType
  readonly appendedAt: string
  readonly updatedAt: string
  readonly providerMetadata?: EventMetadata
  readonly metadata?: EventMetadata
}

export type PermissionProjection = {
  readonly permissionRequestId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly action: string
  readonly state: PermissionStateType
  readonly requestedAt: string
  readonly updatedAt: string
  readonly subject?: string
  readonly reason?: string
  readonly behavior?: PermissionBehavior
  readonly decisionReason?: PermissionDecisionReason
  readonly metadata?: EventMetadata
}

export type ToolProjection = {
  readonly toolCallId: string
  readonly turnId: string
  readonly name: string
  readonly input: JsonValue
  readonly state: ToolStateType
  readonly requestedAt: string
  readonly updatedAt: string
  readonly requestItemId: string
  readonly resultItemId?: string
  readonly permissionRequestId?: string
  readonly requiresPermission: boolean
  readonly providerMetadata?: EventMetadata
  readonly output?: JsonValue
  readonly error?: KernelError
}

export type SessionProjector = {
  project(sessionId: string): Promise<SessionProjection | undefined>
}

export function createSessionProjector(
  eventStore: EventStore,
): SessionProjector {
  return {
    project(sessionId) {
      return eventStore.readProjection(sessionId)
    },
  }
}

export function projectSession(
  events: readonly StoredEventEnvelope[],
): SessionProjection | undefined {
  return applySessionFacts(undefined, events)
}

export function applySessionFacts(
  current: SessionProjection | undefined,
  events: readonly StoredEventEnvelope[],
): SessionProjection | undefined {
  const inputs = new Map(
    current?.inputs.map((input) => [input.inputId, { ...input }]) ?? [],
  )
  const turns = new Map(
    current?.turns.map((turn) => [
      turn.turnId,
      {
        ...turn,
        itemIds: [...turn.itemIds],
        permissionRequestIds: [...turn.permissionRequestIds],
        toolCallIds: [...turn.toolCallIds],
      },
    ]) ?? [],
  )
  const items = new Map(
    current?.items.map((item) => [item.itemId, { ...item }]) ?? [],
  )
  const tools = new Map(
    current?.tools.map((tool) => [tool.toolCallId, { ...tool }]) ?? [],
  )
  const permissions = new Map(
    current?.permissions.map((permission) => [
      permission.permissionRequestId,
      { ...permission },
    ]) ?? [],
  )
  let session = current === undefined ? undefined : mutableSession(current)

  for (const stored of events) {
    if (!session && stored.type === EventType.SessionCreated) {
      session = createMutableSession(
        stored as Extract<
          EventEnvelope,
          { type: typeof EventType.SessionCreated }
        >,
      )
    }
    if (!session) continue
    session.seq = Math.max(session.seq, stored.seq)
    session.updatedAt = stored.createdAt
    if (!isKernelEvent(stored)) continue
    applyKnownEvent(inputs, turns, items, tools, permissions, stored)
  }

  if (!session) return undefined

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
    interruptedTurns: projectedTurns.filter(
      (turn) => turn.state === TurnState.Interrupted,
    ),
    items: Array.from(items.values()),
    tools: Array.from(tools.values()),
    permissions: Array.from(permissions.values()),
    turns: projectedTurns,
  }
}

function createMutableSession(
  created: Extract<EventEnvelope, { type: typeof EventType.SessionCreated }>,
): MutableSession {
  return {
    id: created.sessionId,
    seq: created.seq,
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    ...(created.data.title === undefined ? {} : { title: created.data.title }),
    ...(created.data.workingDirectory === undefined
      ? {}
      : { workingDirectory: created.data.workingDirectory }),
    ...(created.data.mateId === undefined
      ? {}
      : { mateId: created.data.mateId }),
    ...(created.data.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: created.data.mateRevisionId }),
    ...(created.data.parentSessionId === undefined
      ? {}
      : { parentSessionId: created.data.parentSessionId }),
    ...(created.data.metadata === undefined
      ? {}
      : { metadata: created.data.metadata }),
  }
}

function mutableSession(current: SessionProjection): MutableSession {
  return {
    id: current.id,
    seq: current.seq,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    ...(current.title === undefined ? {} : { title: current.title }),
    ...(current.workingDirectory === undefined
      ? {}
      : { workingDirectory: current.workingDirectory }),
    ...(current.mateId === undefined ? {} : { mateId: current.mateId }),
    ...(current.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: current.mateRevisionId }),
    ...(current.parentSessionId === undefined
      ? {}
      : { parentSessionId: current.parentSessionId }),
    ...(current.metadata === undefined ? {} : { metadata: current.metadata }),
  }
}

type MutableSession = {
  id: string
  seq: number
  createdAt: string
  updatedAt: string
  title?: string
  workingDirectory?: string
  mateId?: string
  mateRevisionId?: string
  parentSessionId?: string
  metadata?: EventMetadata
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type MutableInput = Mutable<InputProjection>
type MutableTurn = Mutable<
  Omit<
    TurnProjection,
    "state" | "itemIds" | "permissionRequestIds" | "toolCallIds"
  >
> & {
  state: TurnStateType
  itemIds: string[]
  permissionRequestIds: string[]
  toolCallIds: string[]
}
type MutableTool = Mutable<Omit<ToolProjection, "state">> & {
  state: ToolStateType
}

function applyKnownEvent(
  inputs: Map<string, MutableInput>,
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  tools: Map<string, MutableTool>,
  permissions: Map<string, PermissionProjection>,
  event: EventEnvelope,
): void {
  switch (event.type) {
    case EventType.SessionCreated:
      return
    case EventType.InputAdmitted:
      inputs.set(event.data.inputId, {
        requestId: event.data.requestId,
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
      return
    case EventType.InputCancelled: {
      const input = inputs.get(event.data.inputId)
      if (!input) return
      input.state = InputState.Cancelled
      input.updatedAt = event.createdAt
      if (event.data.reason !== undefined)
        input.cancelledReason = event.data.reason
      return
    }
    case EventType.TurnStarted: {
      const input = inputs.get(event.data.inputId)
      if (input) {
        input.state = InputState.Promoted
        input.turnId = event.data.turnId
        input.updatedAt = event.createdAt
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
        ...(event.data.executionContext === undefined
          ? {}
          : { executionContext: event.data.executionContext }),
        ...(event.data.metadata === undefined
          ? {}
          : { metadata: event.data.metadata }),
      })
      return
    }
    case EventType.TurnCompleted: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Completed
      turn.updatedAt = event.createdAt
      if (event.data.outputMessageId !== undefined) {
        turn.outputMessageId = event.data.outputMessageId
      }
      return
    }
    case EventType.TurnFailed: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Failed
      turn.error = event.data.error
      turn.updatedAt = event.createdAt
      return
    }
    case EventType.TurnCancelled: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Cancelled
      turn.updatedAt = event.createdAt
      if (event.data.reason !== undefined)
        turn.cancelledReason = event.data.reason
      return
    }
    case EventType.TurnInterrupted: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Interrupted
      turn.updatedAt = event.createdAt
      if (event.data.reason !== undefined)
        turn.interruptedReason = event.data.reason
      return
    }
    case EventType.AssistantMessage:
      applyAssistantMessage(turns, items, event)
      return
    case EventType.ToolCall:
      applyToolCall(turns, items, tools, event)
      return
    case EventType.ToolResult:
      applyToolResult(turns, items, tools, event)
      return
    case EventType.PermissionRequested:
      applyPermissionRequested(turns, tools, permissions, event)
      return
    case EventType.PermissionResolved: {
      const permission = permissions.get(event.data.permissionRequestId)
      if (!permission) return
      permissions.set(event.data.permissionRequestId, {
        ...permission,
        state: PermissionState.Resolved,
        updatedAt: event.createdAt,
        behavior: event.data.behavior,
        ...(event.data.reason === undefined
          ? {}
          : { decisionReason: event.data.reason }),
        ...(event.data.metadata === undefined
          ? {}
          : { metadata: event.data.metadata }),
      })
      return
    }
  }
}

function applyAssistantMessage(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  event: Extract<EventEnvelope, { type: typeof EventType.AssistantMessage }>,
): void {
  const turn = turns.get(event.data.turnId)
  if (!turn) return
  const text = event.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
  const item: ItemProjection = {
    itemId: event.data.messageId,
    turnId: event.data.turnId,
    kind: ItemKind.AssistantMessage,
    content: { kind: "text", text },
    status: ItemStatus.Completed,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.providerMetadata === undefined
      ? {}
      : { providerMetadata: event.data.providerMetadata }),
  }
  items.set(item.itemId, item)
  turn.itemIds.push(item.itemId)
  for (const [index, block] of event.data.content.entries()) {
    if (block.type !== "reasoning") continue
    const reasoning: ItemProjection = {
      itemId: `${event.data.messageId}:reasoning:${index}`,
      turnId: event.data.turnId,
      kind: ItemKind.Reasoning,
      content: { kind: "text", text: block.text },
      status: ItemStatus.Completed,
      appendedAt: event.createdAt,
      updatedAt: event.createdAt,
    }
    items.set(reasoning.itemId, reasoning)
    turn.itemIds.push(reasoning.itemId)
  }
}

function applyToolCall(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  tools: Map<string, MutableTool>,
  event: Extract<EventEnvelope, { type: typeof EventType.ToolCall }>,
): void {
  const turn = turns.get(event.data.turnId)
  if (!turn) return
  items.set(event.data.itemId, {
    itemId: event.data.itemId,
    turnId: event.data.turnId,
    kind: ItemKind.ToolCall,
    content: {
      kind: "json",
      value: {
        id: event.data.toolCallId,
        name: event.data.name,
        input: event.data.input,
      },
    },
    status: ItemStatus.Completed,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.providerMetadata === undefined
      ? {}
      : { providerMetadata: event.data.providerMetadata }),
  })
  tools.set(event.data.toolCallId, {
    toolCallId: event.data.toolCallId,
    turnId: event.data.turnId,
    name: event.data.name,
    input: event.data.input,
    state: ToolState.Requested,
    requestedAt: event.createdAt,
    updatedAt: event.createdAt,
    requestItemId: event.data.itemId,
    requiresPermission: event.data.requiresPermission,
    ...(event.data.providerMetadata === undefined
      ? {}
      : { providerMetadata: event.data.providerMetadata }),
  })
  turn.itemIds.push(event.data.itemId)
  turn.toolCallIds.push(event.data.toolCallId)
}

function applyToolResult(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  tools: Map<string, MutableTool>,
  event: Extract<EventEnvelope, { type: typeof EventType.ToolResult }>,
): void {
  const tool = tools.get(event.data.toolCallId)
  if (!tool) return
  const status =
    event.data.error === undefined ? ItemStatus.Completed : ItemStatus.Failed
  items.set(event.data.toolResultId, {
    itemId: event.data.toolResultId,
    turnId: event.data.turnId,
    kind: ItemKind.ToolResult,
    content: event.data.content,
    status,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
  })
  tool.state =
    event.data.error === undefined ? ToolState.Completed : ToolState.Failed
  tool.updatedAt = event.createdAt
  tool.resultItemId = event.data.toolResultId
  if (event.data.output !== undefined) tool.output = event.data.output
  if (event.data.error !== undefined) tool.error = event.data.error
  const turn = turns.get(event.data.turnId)
  turn?.itemIds.push(event.data.toolResultId)
}

function applyPermissionRequested(
  turns: Map<string, MutableTurn>,
  tools: Map<string, MutableTool>,
  permissions: Map<string, PermissionProjection>,
  event: Extract<EventEnvelope, { type: typeof EventType.PermissionRequested }>,
): void {
  permissions.set(event.data.permissionRequestId, {
    permissionRequestId: event.data.permissionRequestId,
    turnId: event.data.turnId,
    toolCallId: event.data.toolCallId,
    action: event.data.action,
    state: PermissionState.Pending,
    requestedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.data.subject === undefined
      ? {}
      : { subject: event.data.subject }),
    ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
    ...(event.data.metadata === undefined
      ? {}
      : { metadata: event.data.metadata }),
  })
  const tool = tools.get(event.data.toolCallId)
  if (tool) tool.permissionRequestId = event.data.permissionRequestId
  const turn = turns.get(event.data.turnId)
  turn?.permissionRequestIds.push(event.data.permissionRequestId)
}
