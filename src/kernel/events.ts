import { createEventId } from "./ids.ts"

export const EventType = {
  SessionCreated: "session.created",
  SessionConfigured: "session.configured",
  InputAdmitted: "input.admitted",
  InputCancelled: "input.cancelled",
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  TurnCancelled: "turn.cancelled",
  TurnInterrupted: "turn.interrupted",
  AssistantMessage: "assistant.message",
  ToolCall: "tool.call",
  ToolResult: "tool.result",
  PermissionRequested: "permission.requested",
  PermissionResolved: "permission.resolved",
  WorldStateUpdated: "world_state.updated",
  ContextCompacted: "context.compacted",
} as const

export const ForkReason = {
  Undo: "undo",
  Edit: "edit",
} as const

export type ForkReason = (typeof ForkReason)[keyof typeof ForkReason]

export const InputRole = {
  Runtime: "runtime",
  System: "system",
  User: "user",
} as const

// A Runtime-role Input whose text equals this directive triggers a
// compaction-only Turn: the runner folds all uncovered completed Turns into a
// checkpoint instead of making a regular model call. Shared by the server
// (compact endpoint), the runner (dispatch), and the GUI (composer shortcut).
export const COMPACT_DIRECTIVE = "/compact"

// Items are a consumer-facing projection over coarse durable facts.
export const ItemKind = {
  AssistantMessage: "assistant_message",
  Reasoning: "reasoning",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
} as const

export const ItemStatus = {
  Completed: "completed",
  Failed: "failed",
} as const

export const PermissionBehavior = {
  Allow: "allow",
  Deny: "deny",
  Expire: "expire",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]
export type InputRole = (typeof InputRole)[keyof typeof InputRole]
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind]
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]
export type PermissionBehavior =
  (typeof PermissionBehavior)[keyof typeof PermissionBehavior]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }
export type EventMetadata = JsonObject

export type TextContent = {
  readonly kind: "text"
  readonly text: string
  readonly attachments?: readonly ImageAttachment[]
}

export type ImageAttachment = {
  readonly name: string
  readonly mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
  readonly data: string
  readonly sizeBytes: number
}

export type JsonContent = {
  readonly kind: "json"
  readonly value: JsonValue
}

export type ItemContent = TextContent | JsonContent

// Provider-neutral, model-visible history IR. The kernel owns this contract so
// durable checkpoints and forks do not depend on runtime request assembly.
export type ModelTextBlock = {
  readonly type: "text"
  readonly text: string
}

export type ModelImageBlock = {
  readonly type: "image"
  readonly mediaType: ImageAttachment["mediaType"]
  readonly data: string
}

export type ModelReasoningBlock = {
  readonly type: "reasoning"
  readonly text: string
  readonly providerMetadata?: JsonObject
}

export type ModelToolCallBlock = {
  readonly type: "tool_call"
  readonly id: string
  readonly name: string
  readonly input: JsonValue
}

export type ModelContentBlock =
  | ModelTextBlock
  | ModelReasoningBlock
  | ModelToolCallBlock

export type ModelHistoryContext = {
  readonly type: "world_state"
  readonly sectionId: string
  readonly revision: string
}

export type ModelUserMessage = {
  readonly role: "user"
  readonly content: readonly ModelTextBlock[]
  readonly images?: readonly ModelImageBlock[]
  readonly context?: ModelHistoryContext
}

export type ModelDeveloperMessage = {
  readonly role: "developer"
  readonly content: readonly ModelTextBlock[]
  readonly context?: ModelHistoryContext
}

export type ModelAssistantMessage = {
  readonly role: "assistant"
  readonly content: readonly ModelContentBlock[]
}

export type ModelToolResultMessage = {
  readonly role: "tool"
  readonly toolCallId: string
  readonly content: string
  readonly isError?: boolean
}

export type ModelMessage =
  | ModelUserMessage
  | ModelDeveloperMessage
  | ModelAssistantMessage
  | ModelToolResultMessage

export type ContextWindowReplacement = {
  readonly windowId: string
  readonly firstWindowId: string
  readonly previousWindowId?: string
  readonly windowNumber: number
  /** Exact provider-neutral prefix that replaces history through throughSeq. */
  readonly history: readonly ModelMessage[]
  /** State against which later world-state changes must be diffed. */
  readonly worldStateBaseline: JsonObject
}

export type AssistantContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "reasoning"
      readonly text: string
      readonly providerMetadata?: EventMetadata
    }

export type KernelError = {
  readonly message: string
  readonly code?: string
  readonly details?: EventMetadata
}

export type TokenUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
}

export type TurnMetrics = {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly modelDurationMs: number
  readonly toolDurationMs: number
  readonly averageTimeToFirstTokenMs?: number
}

export type PermissionDecisionReason = {
  readonly kind: string
  readonly message?: string
  readonly metadata?: EventMetadata
}

export type TurnExecutionLimits = {
  readonly modelCallsPerTurn: number
  readonly toolCallsPerTurn: number
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  /** Missing on Turns recorded before proactive compaction thresholds existed. */
  readonly compactionTriggerContextBytes?: number
  /** Missing on Turns recorded before verbatim-tail retention was explicit. */
  readonly compactionRetainContextBytes?: number
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
  readonly assistantResponseBytes: number
}

export type ModelSelection = {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}

export type BaseInstructionsSnapshot = {
  readonly text: string
  readonly revision: string
  readonly provenance:
    | {
        readonly type: "model"
        readonly provider: string
        readonly model: string
        readonly promptId: string
      }
    | { readonly type: "custom" }
}

export type SessionConfigurationSnapshot = {
  readonly schemaVersion: 1
  readonly workspaceRoot: string
  readonly defaultTarget: ModelSelection
  readonly baseInstructions: BaseInstructionsSnapshot
  readonly enabledTools: readonly string[]
  readonly approvalPolicy: "auto_file_tools" | "never"
  readonly runtimeLimits: { readonly [key: string]: number }
  readonly modelContextWindowTokens?: number
}

export type TurnExecutionContext = {
  readonly mateId: string
  readonly mateRevisionId: string
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
  /** Missing only on events written before prompt attribution was introduced. */
  readonly promptId?: string
  /** Legacy combined revision written before base/model attribution split. */
  readonly promptRevision?: string
  /** Exact persisted Session base-instruction revision. */
  readonly baseInstructionsRevision?: string
  /** Selected model template revision for model-switch attribution. */
  readonly modelInstructionsRevision?: string
  /** Selected window after applying the session configuration override. */
  readonly modelContextWindowTokens?: number
  /** Window available to the harness after the model's safety margin. */
  readonly effectiveModelContextWindowTokens?: number
  readonly workingDirectory: string
  readonly enabledTools: readonly string[]
  readonly approvalPolicy: string
  readonly limits: TurnExecutionLimits
}

export type SessionCreatedEvent = {
  readonly type: typeof EventType.SessionCreated
  readonly data: {
    readonly title?: string
    readonly workingDirectory?: string
    readonly mateId?: string
    readonly mateRevisionId?: string
    readonly conversationId?: string
    readonly parentSessionId?: string
    readonly forkedFromInputId?: string
    readonly forkReason?: ForkReason
    readonly historyBase?: SessionHistoryPosition
    readonly metadata?: EventMetadata
  }
}

export type SessionConfiguredEvent = {
  readonly type: typeof EventType.SessionConfigured
  readonly data: {
    readonly configuration: SessionConfigurationSnapshot
  }
}

export type SessionHistoryPosition = {
  readonly sessionId: string
  readonly endSeqExclusive: number
  readonly endByteOffset: number
}

export type InputAdmittedEvent = {
  readonly type: typeof EventType.InputAdmitted
  readonly data: {
    readonly requestId: string
    readonly inputId: string
    readonly role: InputRole
    readonly content: TextContent
    readonly modelSelection?: ModelSelection
    readonly parentInputId?: string
    readonly metadata?: EventMetadata
  }
}

export type InputCancelledEvent = {
  readonly type: typeof EventType.InputCancelled
  readonly data: {
    readonly inputId: string
    readonly reason?: string
  }
}

export type TurnStartedEvent = {
  readonly type: typeof EventType.TurnStarted
  readonly data: {
    readonly turnId: string
    readonly inputId: string
    readonly parentTurnId?: string
    readonly executionContext?: TurnExecutionContext
    readonly metadata?: EventMetadata
  }
}

export type TurnCompletedEvent = {
  readonly type: typeof EventType.TurnCompleted
  readonly data: {
    readonly turnId: string
    readonly outputMessageId?: string
    readonly usage?: TokenUsage
    readonly metrics?: TurnMetrics
    readonly metadata?: EventMetadata
  }
}

export type TurnFailedEvent = {
  readonly type: typeof EventType.TurnFailed
  readonly data: {
    readonly turnId: string
    readonly error: KernelError
    readonly usage?: TokenUsage
    readonly metrics?: TurnMetrics
  }
}

export type TurnCancelledEvent = {
  readonly type: typeof EventType.TurnCancelled
  readonly data: {
    readonly turnId: string
    readonly reason?: string
    readonly usage?: TokenUsage
    readonly metrics?: TurnMetrics
  }
}

export type TurnInterruptedEvent = {
  readonly type: typeof EventType.TurnInterrupted
  readonly data: {
    readonly turnId: string
    readonly reason?: string
    readonly usage?: TokenUsage
    readonly metrics?: TurnMetrics
  }
}

export type AssistantMessageEvent = {
  readonly type: typeof EventType.AssistantMessage
  readonly data: {
    readonly messageId: string
    readonly turnId: string
    readonly content: readonly AssistantContentBlock[]
    readonly providerMetadata?: EventMetadata
  }
}

export type ToolCallEvent = {
  readonly type: typeof EventType.ToolCall
  readonly data: {
    readonly toolCallId: string
    readonly itemId: string
    readonly turnId: string
    readonly name: string
    readonly input: JsonValue
    readonly requiresPermission: boolean
    readonly providerMetadata?: EventMetadata
  }
}

export type ToolResultEvent = {
  readonly type: typeof EventType.ToolResult
  readonly data: {
    readonly toolResultId: string
    readonly toolCallId: string
    readonly turnId: string
    readonly content: ItemContent
    readonly output?: JsonValue
    readonly error?: KernelError
  }
}

export type PermissionRequestedEvent = {
  readonly type: typeof EventType.PermissionRequested
  readonly data: {
    readonly permissionRequestId: string
    readonly turnId: string
    readonly toolCallId: string
    readonly action: string
    readonly subject?: string
    readonly reason?: string
    readonly metadata?: EventMetadata
  }
}

export type PermissionResolvedEvent = {
  readonly type: typeof EventType.PermissionResolved
  readonly data: {
    readonly permissionRequestId: string
    readonly turnId: string
    readonly behavior: PermissionBehavior
    readonly reason?: PermissionDecisionReason
    readonly metadata?: EventMetadata
  }
}

export type WorldStateFragment = {
  readonly id: string
  readonly revision: string
  readonly role: "user" | "developer"
  readonly text: string
}

export type WorldStateUpdatedEvent = {
  readonly type: typeof EventType.WorldStateUpdated
  readonly data: {
    readonly turnId: string
    readonly afterItemId?: string
    readonly full: boolean
    /** Complete state when full, otherwise an RFC 7386 merge patch. */
    readonly state: JsonObject
    /** Exact model-visible text is durable even if renderers later change. */
    readonly fragments: readonly WorldStateFragment[]
  }
}

export type ContextCompactedEvent = {
  readonly type: typeof EventType.ContextCompacted
  readonly data: {
    readonly compactionId: string
    readonly turnId: string
    readonly throughSeq: number
    readonly coveredTurnIds: readonly string[]
    readonly summary: string
    readonly usage?: TokenUsage
    /** Missing on checkpoints written before exact window replacement existed. */
    readonly replacement?: ContextWindowReplacement
  }
}

export type KernelEvent =
  | SessionCreatedEvent
  | SessionConfiguredEvent
  | InputAdmittedEvent
  | InputCancelledEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | TurnInterruptedEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | WorldStateUpdatedEvent
  | ContextCompactedEvent

export type EventEnvelopeBase = {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly version: number
  readonly createdAt: string
}

export type EventEnvelope = EventEnvelopeBase & KernelEvent

export type OpaqueEventEnvelope = EventEnvelopeBase & {
  readonly type: string
  readonly data: JsonObject
}

export type StoredEventEnvelope = EventEnvelope | OpaqueEventEnvelope

export type EventEnvelopeInput = {
  readonly sessionId: string
  readonly seq: number
  readonly event: KernelEvent
  readonly version?: number
  readonly id?: string
  readonly createdAt?: string
}

export function createEventEnvelope(input: EventEnvelopeInput): EventEnvelope {
  if (!Number.isInteger(input.seq) || input.seq <= 0) {
    throw new RangeError("Event sequence must be a positive integer.")
  }
  const version = input.version ?? 1
  if (!Number.isInteger(version) || version <= 0) {
    throw new RangeError("Event version must be a positive integer.")
  }
  requireKernelEvent(input.event)
  return {
    id: input.id ?? createEventId(),
    sessionId: input.sessionId,
    seq: input.seq,
    version,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...input.event,
  }
}

export function isKnownEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypes.has(value)
}

export function isKernelEvent(value: unknown): value is KernelEvent {
  try {
    requireKernelEvent(value)
    return true
  } catch {
    return false
  }
}

function requireKernelEvent(value: unknown): asserts value is KernelEvent {
  if (
    !isRecord(value) ||
    !isKnownEventType(value.type) ||
    !isRecord(value.data)
  ) {
    throw new TypeError("Invalid kernel event.")
  }
  const data = value.data
  const valid = (() => {
    switch (value.type) {
      case EventType.SessionCreated:
        return (
          onlyKeys(data, [
            "title",
            "workingDirectory",
            "mateId",
            "mateRevisionId",
            "conversationId",
            "parentSessionId",
            "forkedFromInputId",
            "forkReason",
            "historyBase",
            "metadata",
          ]) &&
          (data.forkReason === undefined || isForkReason(data.forkReason)) &&
          (data.historyBase === undefined ||
            isSessionHistoryPosition(data.historyBase))
        )
      case EventType.SessionConfigured:
        return (
          onlyKeys(data, ["configuration"]) &&
          isSessionConfigurationSnapshot(data.configuration)
        )
      case EventType.InputAdmitted:
        return (
          onlyKeys(data, [
            "requestId",
            "inputId",
            "role",
            "content",
            "modelSelection",
            "parentInputId",
            "metadata",
          ]) &&
          isString(data.requestId) &&
          isString(data.inputId) &&
          isInputRole(data.role) &&
          isTextContent(data.content) &&
          (data.modelSelection === undefined ||
            isModelSelection(data.modelSelection))
        )
      case EventType.InputCancelled:
        return onlyKeys(data, ["inputId", "reason"]) && isString(data.inputId)
      case EventType.TurnStarted:
        return (
          onlyKeys(data, [
            "turnId",
            "inputId",
            "parentTurnId",
            "executionContext",
            "metadata",
          ]) &&
          isString(data.turnId) &&
          isString(data.inputId) &&
          (data.executionContext === undefined ||
            isTurnExecutionContext(data.executionContext))
        )
      case EventType.TurnCompleted:
        return (
          onlyKeys(data, [
            "turnId",
            "outputMessageId",
            "usage",
            "metrics",
            "metadata",
          ]) &&
          isString(data.turnId) &&
          (data.usage === undefined || isTokenUsage(data.usage)) &&
          (data.metrics === undefined || isTurnMetrics(data.metrics))
        )
      case EventType.TurnFailed:
        return (
          onlyKeys(data, ["turnId", "error", "usage", "metrics"]) &&
          isString(data.turnId) &&
          isKernelError(data.error) &&
          (data.usage === undefined || isTokenUsage(data.usage)) &&
          (data.metrics === undefined || isTurnMetrics(data.metrics))
        )
      case EventType.TurnCancelled:
      case EventType.TurnInterrupted:
        return (
          onlyKeys(data, ["turnId", "reason", "usage", "metrics"]) &&
          isString(data.turnId) &&
          (data.usage === undefined || isTokenUsage(data.usage)) &&
          (data.metrics === undefined || isTurnMetrics(data.metrics))
        )
      case EventType.AssistantMessage:
        return (
          onlyKeys(data, [
            "messageId",
            "turnId",
            "content",
            "providerMetadata",
          ]) &&
          isString(data.messageId) &&
          isString(data.turnId) &&
          Array.isArray(data.content) &&
          data.content.every(isAssistantContentBlock)
        )
      case EventType.ToolCall:
        return (
          onlyKeys(data, [
            "toolCallId",
            "itemId",
            "turnId",
            "name",
            "input",
            "requiresPermission",
            "providerMetadata",
          ]) &&
          isString(data.toolCallId) &&
          isString(data.itemId) &&
          isString(data.turnId) &&
          isString(data.name) &&
          isJsonValue(data.input) &&
          typeof data.requiresPermission === "boolean"
        )
      case EventType.ToolResult:
        return (
          onlyKeys(data, [
            "toolResultId",
            "toolCallId",
            "turnId",
            "content",
            "output",
            "error",
          ]) &&
          isString(data.toolResultId) &&
          isString(data.toolCallId) &&
          isString(data.turnId) &&
          isItemContent(data.content) &&
          (data.output === undefined || isJsonValue(data.output)) &&
          (data.error === undefined || isKernelError(data.error))
        )
      case EventType.PermissionRequested:
        return (
          onlyKeys(data, [
            "permissionRequestId",
            "turnId",
            "toolCallId",
            "action",
            "subject",
            "reason",
            "metadata",
          ]) &&
          isString(data.permissionRequestId) &&
          isString(data.turnId) &&
          isString(data.toolCallId) &&
          isString(data.action)
        )
      case EventType.PermissionResolved:
        return (
          onlyKeys(data, [
            "permissionRequestId",
            "turnId",
            "behavior",
            "reason",
            "metadata",
          ]) &&
          isString(data.permissionRequestId) &&
          isString(data.turnId) &&
          isPermissionBehavior(data.behavior)
        )
      case EventType.WorldStateUpdated:
        return (
          onlyKeys(data, [
            "turnId",
            "afterItemId",
            "full",
            "state",
            "fragments",
          ]) &&
          isString(data.turnId) &&
          (data.afterItemId === undefined || isString(data.afterItemId)) &&
          typeof data.full === "boolean" &&
          isJsonObject(data.state) &&
          Array.isArray(data.fragments) &&
          data.fragments.every(isWorldStateFragment)
        )
      case EventType.ContextCompacted:
        return (
          onlyKeys(data, [
            "compactionId",
            "turnId",
            "throughSeq",
            "coveredTurnIds",
            "summary",
            "usage",
            "replacement",
          ]) &&
          isString(data.compactionId) &&
          isString(data.turnId) &&
          isPositiveInteger(data.throughSeq) &&
          Array.isArray(data.coveredTurnIds) &&
          data.coveredTurnIds.every(isString) &&
          isString(data.summary) &&
          (data.usage === undefined || isTokenUsage(data.usage)) &&
          (data.replacement === undefined ||
            isContextWindowReplacement(data.replacement))
        )
    }
  })()
  if (!valid || !optionalFieldsAreValid(value.type, data)) {
    throw new TypeError(`Invalid event data for ${value.type}.`)
  }
}

function isWorldStateFragment(value: unknown): value is WorldStateFragment {
  return (
    isRecord(value) &&
    onlyKeys(value, ["id", "revision", "role", "text"]) &&
    isString(value.id) &&
    isString(value.revision) &&
    (value.role === "user" || value.role === "developer") &&
    isString(value.text)
  )
}

function isContextWindowReplacement(
  value: unknown,
): value is ContextWindowReplacement {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "windowId",
      "firstWindowId",
      "previousWindowId",
      "windowNumber",
      "history",
      "worldStateBaseline",
    ]) &&
    isString(value.windowId) &&
    isString(value.firstWindowId) &&
    (value.previousWindowId === undefined ||
      isString(value.previousWindowId)) &&
    isPositiveInteger(value.windowNumber) &&
    Array.isArray(value.history) &&
    value.history.every(isModelMessage) &&
    isJsonObject(value.worldStateBaseline)
  )
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value) || !isString(value.role)) return false
  if (value.role === "tool") {
    return (
      onlyKeys(value, ["role", "toolCallId", "content", "isError"]) &&
      isString(value.toolCallId) &&
      isString(value.content) &&
      (value.isError === undefined || typeof value.isError === "boolean")
    )
  }
  if (value.role === "assistant") {
    return (
      onlyKeys(value, ["role", "content"]) &&
      Array.isArray(value.content) &&
      value.content.every(isModelContentBlock)
    )
  }
  if (value.role !== "user" && value.role !== "developer") return false
  return (
    onlyKeys(value, ["role", "content", "images", "context"]) &&
    Array.isArray(value.content) &&
    value.content.every(
      (block) =>
        isRecord(block) &&
        onlyKeys(block, ["type", "text"]) &&
        block.type === "text" &&
        isString(block.text),
    ) &&
    (value.images === undefined ||
      (value.role === "user" &&
        Array.isArray(value.images) &&
        value.images.every(isModelImageBlock))) &&
    (value.context === undefined || isModelHistoryContext(value.context))
  )
}

function isModelContentBlock(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.type)) return false
  if (value.type === "text") {
    return onlyKeys(value, ["type", "text"]) && isString(value.text)
  }
  if (value.type === "reasoning") {
    return (
      onlyKeys(value, ["type", "text", "providerMetadata"]) &&
      isString(value.text) &&
      (value.providerMetadata === undefined ||
        isJsonObject(value.providerMetadata))
    )
  }
  return (
    value.type === "tool_call" &&
    onlyKeys(value, ["type", "id", "name", "input"]) &&
    isString(value.id) &&
    isString(value.name) &&
    isJsonValue(value.input)
  )
}

function isModelImageBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["type", "mediaType", "data"]) &&
    value.type === "image" &&
    isSupportedImageMediaType(value.mediaType) &&
    isString(value.data)
  )
}

function isModelHistoryContext(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["type", "sectionId", "revision"]) &&
    value.type === "world_state" &&
    isString(value.sectionId) &&
    isString(value.revision)
  )
}

function isSessionConfigurationSnapshot(
  value: unknown,
): value is SessionConfigurationSnapshot {
  if (!isRecord(value)) return false
  if (
    !onlyKeys(value, [
      "schemaVersion",
      "workspaceRoot",
      "defaultTarget",
      "baseInstructions",
      "enabledTools",
      "approvalPolicy",
      "runtimeLimits",
      "modelContextWindowTokens",
    ]) ||
    value.schemaVersion !== 1 ||
    !isString(value.workspaceRoot) ||
    !isModelSelection(value.defaultTarget) ||
    !isBaseInstructionsSnapshot(value.baseInstructions) ||
    !Array.isArray(value.enabledTools) ||
    !value.enabledTools.every(isString) ||
    (value.approvalPolicy !== "auto_file_tools" &&
      value.approvalPolicy !== "never") ||
    !isNumericConfiguration(value.runtimeLimits) ||
    (value.modelContextWindowTokens !== undefined &&
      !isPositiveInteger(value.modelContextWindowTokens))
  ) {
    return false
  }
  return true
}

function isBaseInstructionsSnapshot(
  value: unknown,
): value is BaseInstructionsSnapshot {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["text", "revision", "provenance"]) ||
    !isString(value.text) ||
    !isString(value.revision) ||
    !isRecord(value.provenance)
  ) {
    return false
  }
  if (value.provenance.type === "custom") {
    return onlyKeys(value.provenance, ["type"])
  }
  return (
    value.provenance.type === "model" &&
    onlyKeys(value.provenance, ["type", "provider", "model", "promptId"]) &&
    isString(value.provenance.provider) &&
    isString(value.provenance.model) &&
    isString(value.provenance.promptId)
  )
}

function isNumericConfiguration(
  value: unknown,
): value is { readonly [key: string]: number } {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )
  )
}

function optionalFieldsAreValid(
  type: EventType,
  data: Record<string, unknown>,
): boolean {
  if ("reason" in data && data.reason !== undefined) {
    if (type === EventType.PermissionResolved) {
      if (!isPermissionDecisionReason(data.reason)) return false
    } else if (!isString(data.reason)) return false
  }
  if (
    "metadata" in data &&
    data.metadata !== undefined &&
    !isJsonObject(data.metadata)
  )
    return false
  if (
    "providerMetadata" in data &&
    data.providerMetadata !== undefined &&
    !isJsonObject(data.providerMetadata)
  )
    return false
  for (const key of [
    "title",
    "workingDirectory",
    "mateId",
    "mateRevisionId",
    "conversationId",
    "parentSessionId",
    "forkedFromInputId",
    "parentInputId",
    "parentTurnId",
    "outputMessageId",
    "subject",
  ] as const) {
    if (key in data && data[key] !== undefined && !isString(data[key]))
      return false
  }
  return true
}

function isSessionHistoryPosition(
  value: unknown,
): value is SessionHistoryPosition {
  return (
    isRecord(value) &&
    onlyKeys(value, ["sessionId", "endSeqExclusive", "endByteOffset"]) &&
    isString(value.sessionId) &&
    typeof value.endSeqExclusive === "number" &&
    Number.isSafeInteger(value.endSeqExclusive) &&
    value.endSeqExclusive > 1 &&
    typeof value.endByteOffset === "number" &&
    Number.isSafeInteger(value.endByteOffset) &&
    value.endByteOffset > 0
  )
}

function isForkReason(value: unknown): value is ForkReason {
  return value === ForkReason.Undo || value === ForkReason.Edit
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isAssistantContentBlock(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.text)) return false
  if (value.type === "text") return onlyKeys(value, ["type", "text"])
  return (
    value.type === "reasoning" &&
    onlyKeys(value, ["type", "text", "providerMetadata"]) &&
    (value.providerMetadata === undefined ||
      isJsonObject(value.providerMetadata))
  )
}

function isInputRole(value: unknown): value is InputRole {
  return typeof value === "string" && inputRoles.has(value)
}

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return typeof value === "string" && permissionBehaviors.has(value)
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ]) &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    (value.cacheReadInputTokens === undefined ||
      isNonNegativeInteger(value.cacheReadInputTokens)) &&
    (value.cacheWriteInputTokens === undefined ||
      isNonNegativeInteger(value.cacheWriteInputTokens))
  )
}

function isTurnMetrics(value: unknown): value is TurnMetrics {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "modelCalls",
      "toolCalls",
      "modelDurationMs",
      "toolDurationMs",
      "averageTimeToFirstTokenMs",
    ]) &&
    isNonNegativeInteger(value.modelCalls) &&
    isNonNegativeInteger(value.toolCalls) &&
    isNonNegativeInteger(value.modelDurationMs) &&
    isNonNegativeInteger(value.toolDurationMs) &&
    (value.averageTimeToFirstTokenMs === undefined ||
      isNonNegativeInteger(value.averageTimeToFirstTokenMs))
  )
}

function isTextContent(value: unknown): value is TextContent {
  return (
    isRecord(value) &&
    value.kind === "text" &&
    isString(value.text) &&
    onlyKeys(value, ["kind", "text", "attachments"]) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.every(isImageAttachment)))
  )
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  return (
    isRecord(value) &&
    onlyKeys(value, ["name", "mediaType", "data", "sizeBytes"]) &&
    isString(value.name) &&
    isSupportedImageMediaType(value.mediaType) &&
    isString(value.data) &&
    isNonNegativeInteger(value.sizeBytes)
  )
}

function isSupportedImageMediaType(
  value: unknown,
): value is ImageAttachment["mediaType"] {
  return (
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  )
}

function isModelSelection(value: unknown): value is ModelSelection {
  return (
    isRecord(value) &&
    onlyKeys(value, ["provider", "model", "effort", "speed"]) &&
    isString(value.provider) &&
    value.provider.length > 0 &&
    isString(value.model) &&
    value.model.length > 0 &&
    (value.effort === undefined ||
      (isString(value.effort) && value.effort.length > 0)) &&
    (value.speed === undefined ||
      (isString(value.speed) && value.speed.length > 0))
  )
}

function isItemContent(value: unknown): value is ItemContent {
  if (!isRecord(value)) return false
  if (value.kind === "text") return isTextContent(value)
  if (value.kind === "json")
    return isJsonValue(value.value) && onlyKeys(value, ["kind", "value"])
  return false
}

function isKernelError(value: unknown): value is KernelError {
  return (
    isRecord(value) &&
    isString(value.message) &&
    (value.code === undefined || isString(value.code)) &&
    (value.details === undefined || isJsonObject(value.details))
  )
}

function isPermissionDecisionReason(
  value: unknown,
): value is PermissionDecisionReason {
  return (
    isRecord(value) &&
    isString(value.kind) &&
    (value.message === undefined || isString(value.message)) &&
    (value.metadata === undefined || isJsonObject(value.metadata))
  )
}

function isTurnExecutionContext(value: unknown): value is TurnExecutionContext {
  if (!isRecord(value) || !isRecord(value.limits)) return false
  const limits = value.limits
  return (
    isString(value.mateId) &&
    isString(value.mateRevisionId) &&
    isString(value.provider) &&
    isString(value.model) &&
    (value.effort === undefined || isString(value.effort)) &&
    (value.speed === undefined || isString(value.speed)) &&
    (value.promptId === undefined || isString(value.promptId)) &&
    (value.promptRevision === undefined || isString(value.promptRevision)) &&
    (value.baseInstructionsRevision === undefined ||
      isString(value.baseInstructionsRevision)) &&
    (value.modelInstructionsRevision === undefined ||
      isString(value.modelInstructionsRevision)) &&
    (value.modelContextWindowTokens === undefined ||
      isPositiveInteger(value.modelContextWindowTokens)) &&
    (value.effectiveModelContextWindowTokens === undefined ||
      isPositiveInteger(value.effectiveModelContextWindowTokens)) &&
    (typeof value.modelContextWindowTokens !== "number" ||
      typeof value.effectiveModelContextWindowTokens !== "number" ||
      value.effectiveModelContextWindowTokens <=
        value.modelContextWindowTokens) &&
    isString(value.workingDirectory) &&
    isString(value.approvalPolicy) &&
    Array.isArray(value.enabledTools) &&
    value.enabledTools.every(isString) &&
    (limits.compactionTriggerContextBytes === undefined ||
      isNonNegativeInteger(limits.compactionTriggerContextBytes)) &&
    (limits.compactionRetainContextBytes === undefined ||
      isNonNegativeInteger(limits.compactionRetainContextBytes)) &&
    (typeof limits.compactionTriggerContextBytes !== "number" ||
      typeof limits.compactionRetainContextBytes !== "number" ||
      limits.compactionRetainContextBytes <
        limits.compactionTriggerContextBytes) &&
    [
      "modelCallsPerTurn",
      "toolCallsPerTurn",
      "modelVisibleMessageBlocks",
      "modelVisibleContextBytes",
      "modelVisibleToolResultBytes",
      "modelVisibleToolResultLines",
      "assistantResponseBytes",
    ].every((key) => isNonNegativeInteger(limits[key]))
  )
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const eventTypes = new Set<string>(Object.values(EventType))
const inputRoles = new Set<string>(Object.values(InputRole))
const permissionBehaviors = new Set<string>(Object.values(PermissionBehavior))
