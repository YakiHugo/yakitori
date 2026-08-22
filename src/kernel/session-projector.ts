import {
  type EventEnvelope,
  type EventMetadata,
  EventType,
  type ForkReason,
  type InputRole,
  type ItemContent,
  type ContextWindowReplacement,
  ItemKind,
  type ItemKind as ItemKindType,
  ItemStatus,
  type ItemStatus as ItemStatusType,
  isKernelEvent,
  type JsonValue,
  type JsonObject,
  type KernelError,
  type ModelMessage,
  type ModelSelection,
  type PermissionBehavior,
  type PermissionDecisionReason,
  type SessionConfigurationSnapshot,
  type StoredEventEnvelope,
  type TextContent,
  type TokenUsage,
  type TurnMetrics,
  type TurnExecutionContext,
  type WorldStateFragment,
} from "./events.ts"
import {
  InputState,
  type InputState as InputStateType,
  PermissionState,
  type PermissionState as PermissionStateType,
  ToolState,
  type ToolState as ToolStateType,
  TurnState,
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
  readonly conversationId: string
  readonly parentSessionId?: string
  readonly forkedFromInputId?: string
  readonly forkReason?: ForkReason
  readonly metadata?: EventMetadata
  readonly configuration?: SessionConfigurationSnapshot
  readonly usage?: TokenUsage
  readonly compaction?: CompactionProjection
  readonly inheritedContext?: InheritedContextProjection
  readonly worldState?: WorldStateProjection
  readonly worldStateUpdates: readonly WorldStateUpdateProjection[]
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

// The latest checkpoint replaces the previous one; coverage is cumulative by
// construction, so one field is enough.
export type CompactionProjection = {
  readonly compactionId: string
  readonly turnId: string
  readonly throughSeq: number
  readonly coveredTurnIds: readonly string[]
  readonly summary: string
  readonly usage?: TokenUsage
  readonly replacement?: ContextWindowReplacement
  readonly createdAt: string
}

export type InheritedContextProjection = {
  readonly windowId: string
  readonly sourceSessionId: string
  readonly history: readonly ModelMessage[]
  readonly worldStateBaseline?: JsonObject
  readonly createdAt: string
}

export type WorldStateProjection = {
  readonly state: JsonObject
  readonly updatedSeq: number
  readonly updatedAt: string
}

export type WorldStateUpdateProjection = {
  readonly turnId: string
  readonly afterItemId?: string
  readonly full: boolean
  readonly state: JsonObject
  readonly fragments: readonly WorldStateFragment[]
  readonly seq: number
  readonly createdAt: string
}

export type InputProjection = {
  readonly requestId: string
  readonly inputId: string
  readonly role: InputRole
  readonly content: TextContent
  readonly modelSelection?: ModelSelection
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
  readonly usage?: TokenUsage
  readonly metrics?: TurnMetrics
  readonly itemIds: readonly string[]
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
  let worldState = current?.worldState
  const worldStateUpdates = [...(current?.worldStateUpdates ?? [])]

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
    if (stored.createdAt > session.updatedAt)
      session.updatedAt = stored.createdAt
    if (!isKernelEvent(stored)) continue
    if (stored.type === EventType.SessionConfigured) {
      session.configuration = stored.data.configuration
      continue
    }
    if (stored.type === EventType.ContextCompacted) {
      session.compaction = compactionProjection(stored)
      if (stored.data.replacement !== undefined) {
        worldState = {
          state: stored.data.replacement.worldStateBaseline,
          updatedSeq: stored.seq,
          updatedAt: stored.createdAt,
        }
      }
      continue
    }
    if (stored.type === EventType.ContextWindowSeeded) {
      session.inheritedContext = {
        windowId: stored.data.windowId,
        sourceSessionId: stored.data.sourceSessionId,
        history: stored.data.history,
        ...(stored.data.worldStateBaseline === undefined
          ? {}
          : { worldStateBaseline: stored.data.worldStateBaseline }),
        createdAt: stored.createdAt,
      }
      if (stored.data.worldStateBaseline !== undefined) {
        worldState = {
          state: stored.data.worldStateBaseline,
          updatedSeq: stored.seq,
          updatedAt: stored.createdAt,
        }
      }
      continue
    }
    if (stored.type === EventType.WorldStateUpdated) {
      const event = stored as Extract<
        EventEnvelope,
        { type: typeof EventType.WorldStateUpdated }
      >
      const state = event.data.full
        ? event.data.state
        : applyMergePatch(worldState?.state ?? {}, event.data.state)
      worldState = {
        state,
        updatedSeq: event.seq,
        updatedAt: event.createdAt,
      }
      worldStateUpdates.push({
        turnId: event.data.turnId,
        ...(event.data.afterItemId === undefined
          ? {}
          : { afterItemId: event.data.afterItemId }),
        full: event.data.full,
        state: event.data.state,
        fragments: [...event.data.fragments],
        seq: event.seq,
        createdAt: event.createdAt,
      })
      continue
    }
    applyKnownEvent(inputs, turns, items, tools, permissions, stored)
  }

  if (!session) return undefined

  const projectedInputs = Array.from(inputs.values())
  const projectedTurns = Array.from(turns.values())
  const activeTurn = projectedTurns.find(
    (turn) => turn.state === TurnState.Started,
  )
  const usage = aggregateTokenUsage(projectedTurns)
  return {
    ...session,
    ...(usage === undefined ? {} : { usage }),
    ...(worldState === undefined ? {} : { worldState }),
    worldStateUpdates,
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
    conversationId: created.data.conversationId ?? created.sessionId,
    ...(created.data.parentSessionId === undefined
      ? {}
      : { parentSessionId: created.data.parentSessionId }),
    ...(created.data.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: created.data.forkedFromInputId }),
    ...(created.data.forkReason === undefined
      ? {}
      : { forkReason: created.data.forkReason }),
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
    conversationId: current.conversationId,
    ...(current.parentSessionId === undefined
      ? {}
      : { parentSessionId: current.parentSessionId }),
    ...(current.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: current.forkedFromInputId }),
    ...(current.forkReason === undefined
      ? {}
      : { forkReason: current.forkReason }),
    ...(current.metadata === undefined ? {} : { metadata: current.metadata }),
    ...(current.configuration === undefined
      ? {}
      : { configuration: current.configuration }),
    ...(current.compaction === undefined
      ? {}
      : { compaction: current.compaction }),
    ...(current.inheritedContext === undefined
      ? {}
      : { inheritedContext: current.inheritedContext }),
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
  conversationId: string
  parentSessionId?: string
  forkedFromInputId?: string
  forkReason?: ForkReason
  metadata?: EventMetadata
  configuration?: SessionConfigurationSnapshot
  compaction?: CompactionProjection
  inheritedContext?: InheritedContextProjection
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type MutableInput = Mutable<InputProjection>
type MutableTurn = Mutable<Omit<TurnProjection, "state" | "itemIds">> & {
  state: TurnStateType
  itemIds: string[]
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
    case EventType.SessionConfigured:
      return
    case EventType.InputAdmitted:
      inputs.set(event.data.inputId, {
        requestId: event.data.requestId,
        inputId: event.data.inputId,
        role: event.data.role,
        content: event.data.content,
        ...(event.data.modelSelection === undefined
          ? {}
          : { modelSelection: event.data.modelSelection }),
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
      if (event.data.usage !== undefined) turn.usage = event.data.usage
      if (event.data.metrics !== undefined) turn.metrics = event.data.metrics
      return
    }
    case EventType.TurnFailed: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Failed
      turn.error = event.data.error
      turn.updatedAt = event.createdAt
      if (event.data.usage !== undefined) turn.usage = event.data.usage
      if (event.data.metrics !== undefined) turn.metrics = event.data.metrics
      return
    }
    case EventType.TurnCancelled: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Cancelled
      turn.updatedAt = event.createdAt
      if (event.data.usage !== undefined) turn.usage = event.data.usage
      if (event.data.metrics !== undefined) turn.metrics = event.data.metrics
      if (event.data.reason !== undefined)
        turn.cancelledReason = event.data.reason
      return
    }
    case EventType.TurnInterrupted: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.state = TurnState.Interrupted
      turn.updatedAt = event.createdAt
      if (event.data.usage !== undefined) turn.usage = event.data.usage
      if (event.data.metrics !== undefined) turn.metrics = event.data.metrics
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
      applyPermissionRequested(tools, permissions, event)
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
    case EventType.WorldStateUpdated:
    case EventType.ContextWindowSeeded:
    case EventType.ContextCompacted:
      return
  }
}

function applyMergePatch(target: JsonObject, patch: JsonObject): JsonObject {
  const merged: Record<string, JsonValue> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key]
      continue
    }
    const current = merged[key]
    merged[key] =
      isJsonRecord(current) && isJsonRecord(value)
        ? applyMergePatch(current, value)
        : value
  }
  return merged
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function aggregateTokenUsage(
  turns: readonly TurnProjection[],
): TokenUsage | undefined {
  const recorded = turns.filter(
    (turn): turn is TurnProjection & { readonly usage: TokenUsage } =>
      turn.usage !== undefined,
  )
  if (recorded.length === 0) return undefined
  const totals = recorded.reduce(
    (total, turn) => ({
      inputTokens: total.inputTokens + turn.usage.inputTokens,
      outputTokens: total.outputTokens + turn.usage.outputTokens,
      cacheReadInputTokens:
        total.cacheReadInputTokens + (turn.usage.cacheReadInputTokens ?? 0),
      cacheWriteInputTokens:
        total.cacheWriteInputTokens + (turn.usage.cacheWriteInputTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  )
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.cacheReadInputTokens === 0
      ? {}
      : { cacheReadInputTokens: totals.cacheReadInputTokens }),
    ...(totals.cacheWriteInputTokens === 0
      ? {}
      : { cacheWriteInputTokens: totals.cacheWriteInputTokens }),
  }
}

function compactionProjection(
  event: Extract<EventEnvelope, { type: typeof EventType.ContextCompacted }>,
): CompactionProjection {
  return {
    compactionId: event.data.compactionId,
    turnId: event.data.turnId,
    throughSeq: event.data.throughSeq,
    coveredTurnIds: [...event.data.coveredTurnIds],
    summary: event.data.summary,
    ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
    ...(event.data.replacement === undefined
      ? {}
      : { replacement: event.data.replacement }),
    createdAt: event.createdAt,
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
      ...(block.providerMetadata === undefined
        ? {}
        : { providerMetadata: block.providerMetadata }),
    }
    items.set(reasoning.itemId, reasoning)
    turn.itemIds.push(reasoning.itemId)
  }
  items.set(item.itemId, item)
  turn.itemIds.push(item.itemId)
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
}
