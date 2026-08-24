import {
  type ContextWindowReplacement,
  type EventEnvelope,
  type EventMetadata,
  EventType,
  HistoryRecordType,
  type ForkReason,
  type InputRole,
  type ItemContent,
  ItemKind,
  type ItemKind as ItemKindType,
  ItemStatus,
  type ItemStatus as ItemStatusType,
  isKernelFact,
  type JsonObject,
  type JsonValue,
  type KernelError,
  type ModelMessage,
  type ModelSelection,
  type PermissionBehavior,
  type PermissionDecisionReason,
  type SessionConfigurationSnapshot,
  type StoredEventEnvelope,
  type TextContent,
  type TokenUsage,
  type ToolExecutionItem,
  type TurnExecutionContext,
  type TurnMetrics,
  type WorldStateFragment,
} from "./events.ts"
import { jsonValuesEqual } from "./json-equality.ts"
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
import {
  executionDescriptor,
  toolExecutionDescriptorsCompatible,
} from "./tool-execution.ts"

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

export type SessionSummary = {
  readonly sessionId: string
  readonly conversationId: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly forkedFromInputId?: string
  readonly forkReason?: ForkReason
  readonly metadata?: EventMetadata
}

export function summarizeSessionProjection(
  projection: SessionProjection,
): SessionSummary {
  return {
    sessionId: projection.id,
    conversationId: projection.conversationId,
    seq: projection.seq,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    ...(projection.title === undefined ? {} : { title: projection.title }),
    ...(projection.workingDirectory === undefined
      ? {}
      : { workingDirectory: projection.workingDirectory }),
    ...(projection.mateId === undefined ? {} : { mateId: projection.mateId }),
    ...(projection.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: projection.mateRevisionId }),
    ...(projection.parentSessionId === undefined
      ? {}
      : { parentSessionId: projection.parentSessionId }),
    ...(projection.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: projection.forkedFromInputId }),
    ...(projection.forkReason === undefined
      ? {}
      : { forkReason: projection.forkReason }),
    ...(projection.metadata === undefined
      ? {}
      : { metadata: projection.metadata }),
  }
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
  readonly execution: ToolExecutionItem
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
  const turnContexts = new Map(
    current?.turns.flatMap((turn) =>
      turn.executionContext === undefined
        ? []
        : [[turn.turnId, turn.executionContext] as const],
    ) ?? [],
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
    if (!isKernelFact(stored)) continue
    if (stored.type === HistoryRecordType.TurnContext) {
      turnContexts.set(stored.data.turnId, stored.data.context)
      const turn = turns.get(stored.data.turnId)
      if (turn !== undefined) turn.executionContext = stored.data.context
      continue
    }
    if (stored.type === HistoryRecordType.SessionMetadata) {
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
    if (stored.type === HistoryRecordType.InitialContext) {
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
    if (stored.type === HistoryRecordType.WorldState) {
      const event = stored as Extract<
        EventEnvelope,
        { type: typeof HistoryRecordType.WorldState }
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
    applyKnownEvent(
      inputs,
      turns,
      items,
      tools,
      permissions,
      turnContexts,
      stored,
    )
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
  turnContexts: ReadonlyMap<string, TurnExecutionContext>,
  event: EventEnvelope,
): void {
  switch (event.type) {
    case EventType.SessionCreated:
    case HistoryRecordType.SessionMetadata:
    case HistoryRecordType.TurnContext:
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
      const executionContext = turnContexts.get(event.data.turnId)
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
        ...(executionContext === undefined ? {} : { executionContext }),
        ...(event.data.metadata === undefined
          ? {}
          : { metadata: event.data.metadata }),
      })
      return
    }
    case EventType.TurnCompleted: {
      const turn = turns.get(event.data.turnId)
      if (!turn) return
      turn.updatedAt = event.createdAt
      if (event.data.usage !== undefined) turn.usage = event.data.usage
      if (event.data.metrics !== undefined) turn.metrics = event.data.metrics
      const outcome = event.data.outcome
      switch (outcome.status) {
        case "completed":
          turn.state = TurnState.Completed
          break
        case "failed":
          turn.state = TurnState.Failed
          turn.error = outcome.error
          break
        case "cancelled":
          turn.state = TurnState.Cancelled
          if (outcome.reason !== undefined)
            turn.cancelledReason = outcome.reason
          break
        case "interrupted":
          turn.state = TurnState.Interrupted
          if (outcome.reason !== undefined) {
            turn.interruptedReason = outcome.reason
          }
          break
      }
      return
    }
    case EventType.ItemStarted:
      applyToolStarted(turns, items, tools, event)
      return
    case EventType.ItemCompleted:
      if (
        event.data.item.type === "agent_message" ||
        event.data.item.type === "reasoning"
      ) {
        applyAssistantItem(turns, items, event)
      } else {
        applyToolCompleted(turns, items, tools, event)
      }
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
    case HistoryRecordType.WorldState:
    case HistoryRecordType.InitialContext:
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

function applyAssistantItem(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  event: Extract<EventEnvelope, { type: typeof EventType.ItemCompleted }>,
): void {
  const execution = event.data.item
  if (execution.type !== "agent_message" && execution.type !== "reasoning") {
    return
  }
  const turn = turns.get(event.data.turnId)
  if (!turn) {
    invalidReplay(`Item ${execution.itemId} has no matching Turn.`)
  }
  requireNewItemId(items, execution.itemId)
  const text =
    execution.type === "reasoning"
      ? execution.text
      : execution.content.map((block) => block.text).join("")
  const item: ItemProjection = {
    itemId: execution.itemId,
    turnId: event.data.turnId,
    kind:
      execution.type === "reasoning"
        ? ItemKind.Reasoning
        : ItemKind.AssistantMessage,
    content: { kind: "text", text },
    status: ItemStatus.Completed,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(execution.providerMetadata === undefined
      ? {}
      : { providerMetadata: execution.providerMetadata }),
  }
  items.set(item.itemId, item)
  turn.itemIds.push(item.itemId)
}

function applyToolStarted(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  tools: Map<string, MutableTool>,
  event: Extract<EventEnvelope, { type: typeof EventType.ItemStarted }>,
): void {
  const execution = event.data.item
  const turn = turns.get(event.data.turnId)
  if (!turn) {
    invalidReplay(`Tool start ${execution.toolCallId} has no matching Turn.`)
  }
  requireNewItemId(items, execution.itemId)
  if (tools.has(execution.toolCallId)) {
    invalidReplay(`Tool call ID ${execution.toolCallId} is not unique.`)
  }
  items.set(execution.itemId, {
    itemId: execution.itemId,
    turnId: event.data.turnId,
    kind: ItemKind.ToolCall,
    content: {
      kind: "json",
      value: {
        id: execution.toolCallId,
        name: execution.name,
        input: execution.input,
      },
    },
    status: ItemStatus.Completed,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
  })
  tools.set(execution.toolCallId, {
    toolCallId: execution.toolCallId,
    turnId: event.data.turnId,
    name: execution.name,
    input: execution.input,
    execution,
    state: ToolState.Requested,
    requestedAt: event.createdAt,
    updatedAt: event.createdAt,
    requestItemId: execution.itemId,
    requiresPermission: execution.requiresPermission,
  })
  turn.itemIds.push(execution.itemId)
}

function applyToolCompleted(
  turns: Map<string, MutableTurn>,
  items: Map<string, ItemProjection>,
  tools: Map<string, MutableTool>,
  event: Extract<EventEnvelope, { type: typeof EventType.ItemCompleted }>,
): void {
  const execution = event.data.item
  if (execution.type === "agent_message" || execution.type === "reasoning") {
    return
  }
  const tool = tools.get(execution.toolCallId)
  if (!tool) {
    invalidReplay(
      `Tool completion ${execution.toolCallId} has no matching start.`,
    )
  }
  if (tool.turnId !== event.data.turnId) {
    invalidReplay(
      `Tool completion ${execution.toolCallId} belongs to a different turn.`,
    )
  }
  if (tool.state !== ToolState.Requested || tool.resultItemId !== undefined) {
    invalidReplay(`Tool ${execution.toolCallId} completed more than once.`)
  }
  if (
    tool.requestItemId !== execution.itemId ||
    tool.name !== execution.name ||
    !jsonValuesEqual(tool.input, execution.input) ||
    tool.requiresPermission !== execution.requiresPermission
  ) {
    invalidReplay(
      `Tool completion ${execution.toolCallId} does not match its start.`,
    )
  }
  const startedDescriptor = executionDescriptor(tool.execution)
  const completedDescriptor = executionDescriptor(execution)
  if (
    !toolExecutionDescriptorsCompatible(startedDescriptor, completedDescriptor)
  ) {
    invalidReplay(
      `Tool completion ${execution.toolCallId} changed execution semantics.`,
    )
  }
  requireNewItemId(items, execution.resultItemId)
  const status =
    execution.error === undefined ? ItemStatus.Completed : ItemStatus.Failed
  items.set(execution.resultItemId, {
    itemId: execution.resultItemId,
    turnId: event.data.turnId,
    kind: ItemKind.ToolResult,
    content: execution.content,
    status,
    appendedAt: event.createdAt,
    updatedAt: event.createdAt,
  })
  tool.state =
    execution.error === undefined ? ToolState.Completed : ToolState.Failed
  tool.updatedAt = event.createdAt
  tool.resultItemId = execution.resultItemId
  tool.execution = execution
  if (execution.output !== undefined) tool.output = execution.output
  if (execution.error !== undefined) tool.error = execution.error
  const turn = turns.get(event.data.turnId)
  turn?.itemIds.push(execution.resultItemId)
}

function invalidReplay(message: string): never {
  throw new Error(`Invalid Session replay: ${message}`)
}

function requireNewItemId(
  items: ReadonlyMap<string, ItemProjection>,
  itemId: string,
): void {
  if (items.has(itemId)) {
    invalidReplay(`Item ID ${itemId} is not unique.`)
  }
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
