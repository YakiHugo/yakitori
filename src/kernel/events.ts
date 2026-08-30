import { createEventId, isStorageKey } from "./ids.ts"
import { jsonValuesEqual } from "./json-equality.ts"

export const EVENT_SCHEMA_VERSION = 5

export const EventType = {
  SessionCreated: "session.created",
  InputAdmitted: "input.admitted",
  InputCancelled: "input.cancelled",
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  ItemStarted: "item.started",
  ItemCompleted: "item.completed",
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
  ContextCompaction: "context_compaction",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
} as const

export const ItemStatus = {
  InProgress: "in_progress",
  Completed: "completed",
  Failed: "failed",
} as const

// Recorded on tools left open at a terminal Turn so GUI and model context
// render one fact instead of synthesizing different missing-result text.
export const MISSING_TOOL_RESULT_TEXT =
  "No tool result was recorded. Execution status and side effects are unknown. Inspect the current state before retrying."

export type EventType = (typeof EventType)[keyof typeof EventType]
export type InputRole = (typeof InputRole)[keyof typeof InputRole]
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind]
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]

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

export type RolloutAssetReference = {
  readonly rolloutId: string
  readonly path: string
}

type ImageAttachmentMetadata = {
  readonly name: string
  readonly mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
  readonly sizeBytes: number
  readonly detail?: ImageDetail
}

export type ImageDetail = "high" | "original"

export type ImageAttachment = ImageAttachmentMetadata & {
  readonly file: RolloutAssetReference
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

export type ModelImageBlock =
  | {
      readonly type: "image"
      readonly mediaType: ImageAttachment["mediaType"]
      readonly detail?: ImageDetail
      readonly data: string
      readonly file?: never
      readonly sizeBytes?: never
    }
  | {
      readonly type: "image"
      readonly mediaType: ImageAttachment["mediaType"]
      readonly detail?: ImageDetail
      readonly file: RolloutAssetReference
      readonly sizeBytes: number
      readonly data?: never
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

export type FileObservation = {
  readonly path: string
  readonly kind: "edit" | "ranged_read" | "whole_file_read" | "write"
  readonly complete: boolean
  readonly sha256?: string
  readonly ranges?: readonly {
    readonly startLine: number
    readonly endLine: number
  }[]
  readonly created?: boolean
  readonly optimisticRebase?: boolean
}

export type ModelToolResultMessage = {
  readonly role: "tool"
  readonly toolCallId: string
  readonly content: string
  readonly isError?: boolean
  // Execution-only metadata. Providers receive content; the actor retains this
  // grant so later model-visible Turns can safely authorize file mutations.
  readonly fileObservation?: FileObservation
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
  readonly replacesInheritedContext?: boolean
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

// Provider-reported input usage is authoritative only for the exact request
// prefix that produced it. Persist the proof needed to reuse that calibration
// without making request-budget diagnostics part of the GUI event protocol.
export type ProviderUsageBaseline = {
  readonly provider: string
  readonly model: string
  readonly contextWindowId: string
  readonly systemRevisions: readonly string[]
  readonly toolContractDigest: string
  readonly messagePrefixDigests: readonly string[]
  readonly providerInputTokens: number
  readonly estimatedInputTokens: number
}

export type TurnMetrics = {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly modelDurationMs: number
  readonly toolDurationMs: number
  readonly averageTimeToFirstTokenMs?: number
}

export type TurnExecutionLimits = {
  readonly modelCallsPerTurn: number
  readonly toolCallsPerTurn: number
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  readonly compactionTriggerContextBytes: number
  readonly compactionRetainContextBytes: number
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
        readonly instructionProfileId: string
      }
    | { readonly type: "custom" }
}

export type SessionExecutionPolicyDefaultsSnapshot = {
  readonly modelCallsPerTurn: number
  readonly toolCallsPerTurn: number
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  readonly compactionTriggerRatio: number
  readonly compactionRetainRatio: number
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
  readonly compactionSummaryBytes: number
  readonly assistantResponseBytes: number
}

export type SessionConfigurationSnapshot = {
  readonly schemaVersion: 3
  readonly workspaceRoot: string
  readonly promptCacheKey: string
  readonly defaultTarget: ModelSelection
  readonly baseInstructions: BaseInstructionsSnapshot
  readonly enabledTools: readonly string[]
  readonly approvalPolicy: "auto_file_tools" | "never"
  readonly executionPolicyDefaults: SessionExecutionPolicyDefaultsSnapshot
  readonly modelContextWindowTokens?: number
}

export type TurnExecutionContext = {
  readonly mateId: string
  readonly mateRevisionId: string
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
  readonly instructionProfileId: string
  readonly baseInstructionsRevision: string
  readonly modelInstructionsRevision: string
  /** Selected window after applying the session configuration override. */
  readonly modelContextWindowTokens?: number
  /** Window available to the harness after the model's safety margin. */
  readonly effectiveModelContextWindowTokens?: number
  readonly workingDirectory: string
  readonly enabledTools: readonly string[]
  readonly approvalPolicy: string
  readonly executionPolicy: TurnExecutionLimits
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
    readonly metadata?: EventMetadata
  }
}

export type TurnCompletedEvent = {
  readonly type: typeof EventType.TurnCompleted
  readonly data: {
    readonly turnId: string
    readonly outcome: TurnOutcome
    readonly usage?: TokenUsage
    /** Cumulative Session usage at this durable Turn boundary. */
    readonly sessionUsage?: TokenUsage
    readonly metrics?: TurnMetrics
    readonly metadata?: EventMetadata
  }
}

export type TurnOutcome =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "failed"; error: KernelError }>
  | Readonly<{ status: "cancelled"; reason?: string }>
  | Readonly<{ status: "interrupted"; reason?: string }>

export type ToolExecutionType =
  | "command_execution"
  | "file_change"
  | "file_read"
  | "file_search"
  | "web_fetch"
  | "web_search"
  | "collaboration_tool_call"
  | "mcp_tool_call"
  | "dynamic_tool_call"

export type CollaborationAction =
  | "spawn"
  | "send_message"
  | "follow_up"
  | "wait"
  | "interrupt"
  | "list"

export type CollaborationReceiver = Readonly<{
  sessionId: string
  path: string
}>

type FileChangeDiff = Readonly<{
  format: "unified"
  text: string
  truncated: boolean
}>

export type FileChange =
  | Readonly<{ path: string; kind: "add" | "delete"; diff?: FileChangeDiff }>
  | Readonly<{
      path: string
      kind: "update"
      movePath?: string
      diff?: FileChangeDiff
    }>

export type CommandExecutionResult = Readonly<{
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs?: number
  cwd?: string
  shell?: string
  warnings?: ReadonlyArray<string>
  blocked?: Readonly<{ rule: string }>
  binary?: Readonly<{
    stdout: boolean
    stderr: boolean
    stdoutBytes: number
    stderrBytes: number
  }>
}>

export type FileReadResult = Readonly<{
  path: string
  kind: "file" | "directory"
  count?: number
  entries?: ReadonlyArray<string>
  range?: Readonly<{ offset: number; limit: number }>
  empty: boolean
  truncated: boolean
}>

export type FileSearchResult = Readonly<{
  path: string
  outputMode: "content" | "files_with_matches" | "count"
  count: number
  truncated: boolean
  timedOut: boolean
  paths?: ReadonlyArray<string>
  matches?: ReadonlyArray<
    Readonly<{ path: string; line?: number; text?: string; count?: number }>
  >
}>

export type WebFetchResult = Readonly<{
  url: string
  status: number
  truncated: boolean
}>

export type WebSearchResult = Readonly<{
  links: ReadonlyArray<Readonly<{ title: string; url: string }>>
}>

export type McpToolCallResult = Readonly<{
  content: ReadonlyArray<JsonValue>
  structuredContent?: JsonValue
  isError?: boolean
  _meta?: JsonValue
}>

export type AgentMessageExecutionItem = Readonly<{
  type: "agent_message"
  itemId: string
  content: ReadonlyArray<ModelTextBlock>
  providerMetadata?: EventMetadata
}>

export type ReasoningExecutionItem = Readonly<{
  type: "reasoning"
  itemId: string
  text: string
  providerMetadata?: EventMetadata
}>

// Compaction is housekeeping inside a Turn: its start is live-only, while the
// durable checkpoint and completed item let clients recover the final state.
export type ContextCompactionStartedItem = Readonly<{
  type: "context_compaction"
  itemId: string
}>

export type ContextCompactionCompletedItem = Readonly<{
  type: "context_compaction"
  itemId: string
  status: typeof ItemStatus.Completed | typeof ItemStatus.Failed
  error?: KernelError
}>

type ToolExecutionItemBase = Readonly<{
  itemId: string
  toolCallId: string
  name: string
  input: JsonValue
  requiresPermission: boolean
}>

export type ToolExecutionDescriptor =
  | Readonly<{
      type: "command_execution"
      command: string
      description?: string
      result?: CommandExecutionResult
    }>
  | Readonly<{
      type: "file_change"
      request: Readonly<{
        operation: "edit" | "write" | "apply_patch"
        paths: ReadonlyArray<string>
      }>
      changes: ReadonlyArray<FileChange>
    }>
  | Readonly<{
      type: "file_read"
      path: string
      offset?: number
      limit?: number
      result?: FileReadResult
    }>
  | Readonly<{
      type: "file_search"
      operation: "grep" | "glob"
      pattern: string
      path?: string
      outputMode?: "content" | "files_with_matches" | "count"
      lineNumbers: boolean
      result?: FileSearchResult
    }>
  | Readonly<{
      type: "web_fetch"
      url: string
      result?: WebFetchResult
    }>
  | Readonly<{
      type: "web_search"
      query: string
      result?: WebSearchResult
    }>
  | Readonly<{
      type: "collaboration_tool_call"
      action: CollaborationAction
      description: string
      receivers: ReadonlyArray<CollaborationReceiver>
    }>
  | Readonly<{
      type: "mcp_tool_call"
      server: string
      tool: string
      arguments: JsonValue
      // Server-provided display hint only. Permission decisions use the
      // runtime tool policy and must never trust this value.
      readOnlyHint?: boolean
      result?: McpToolCallResult
    }>
  | Readonly<{ type: "dynamic_tool_call" }>

export type ToolExecutionItem = ToolExecutionItemBase & ToolExecutionDescriptor

// All item starts belong to live delivery. Their durable final items are
// self-contained ItemCompleted facts.
export type StreamedStartedItem = ContextCompactionStartedItem

export type StartedExecutionItem = StreamedStartedItem | ToolExecutionItem

export type ItemStartedEvent = Readonly<{
  type: typeof EventType.ItemStarted
  data: Readonly<{ turnId: string; item: StartedExecutionItem }>
}>

export type CompletedExecutionItem =
  | AgentMessageExecutionItem
  | ReasoningExecutionItem
  | ContextCompactionCompletedItem
  | (ToolExecutionItem &
      Readonly<{
        resultItemId: string
        content: ItemContent
        output?: JsonValue
        error?: KernelError
      }>)

export type ItemCompletedEvent = Readonly<{
  type: typeof EventType.ItemCompleted
  data: Readonly<{
    turnId: string
    item: CompletedExecutionItem
  }>
}>

export type WorldStateFragment = {
  readonly id: string
  readonly revision: string
  readonly role: "user" | "developer"
  readonly text: string
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
    readonly replacement: ContextWindowReplacement
  }
}

export type KernelEvent =
  | SessionCreatedEvent
  | InputAdmittedEvent
  | InputCancelledEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ItemStartedEvent
  | ItemCompletedEvent
  | ContextCompactedEvent

export type KernelFact = KernelEvent

export type EventEnvelopeBase = {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly version: number
  readonly createdAt: string
}

export type EventEnvelope = EventEnvelopeBase & KernelEvent
export type RuntimeEventEnvelope = EventEnvelopeBase & KernelEvent

export type OpaqueEventEnvelope = EventEnvelopeBase & {
  readonly type: string
  readonly data: JsonObject
}

export type StoredEventEnvelope = EventEnvelope | OpaqueEventEnvelope

export type EventEnvelopeInput<Fact extends KernelEvent = KernelEvent> = {
  readonly sessionId: string
  readonly seq: number
  readonly event: Fact
  readonly version?: number
  readonly id?: string
  readonly createdAt?: string
}

export function createEventEnvelope<const Fact extends KernelEvent>(
  input: EventEnvelopeInput<Fact>,
): EventEnvelopeBase & Fact {
  if (!Number.isInteger(input.seq) || input.seq <= 0) {
    throw new RangeError("Event sequence must be a positive integer.")
  }
  const version = input.version ?? EVENT_SCHEMA_VERSION
  if (version !== EVENT_SCHEMA_VERSION) {
    throw new RangeError(
      `Event version must be ${String(EVENT_SCHEMA_VERSION)}.`,
    )
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
  if (!isRecord(value) || !isKnownEventType(value.type)) return false
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
          onlyKeys(data, ["turnId", "inputId", "parentTurnId", "metadata"]) &&
          isString(data.turnId) &&
          isString(data.inputId) &&
          (data.parentTurnId === undefined || isString(data.parentTurnId))
        )
      case EventType.TurnCompleted:
        return (
          onlyKeys(data, [
            "turnId",
            "outcome",
            "usage",
            "sessionUsage",
            "metrics",
            "metadata",
          ]) &&
          isString(data.turnId) &&
          isTurnOutcome(data.outcome) &&
          (data.usage === undefined || isTokenUsage(data.usage)) &&
          (data.sessionUsage === undefined ||
            isTokenUsage(data.sessionUsage)) &&
          (data.metrics === undefined || isTurnMetrics(data.metrics))
        )
      case EventType.ItemStarted:
        return (
          onlyKeys(data, ["turnId", "item"]) &&
          isString(data.turnId) &&
          isStartedExecutionItem(data.item)
        )
      case EventType.ItemCompleted:
        return (
          onlyKeys(data, ["turnId", "item"]) &&
          isString(data.turnId) &&
          isCompletedExecutionItem(data.item)
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
          isContextWindowReplacement(data.replacement)
        )
    }
  })()
  if (!valid || !optionalFieldsAreValid(data)) {
    throw new TypeError(`Invalid event data for ${value.type}.`)
  }
}

function isToolExecutionItem(value: unknown): value is ToolExecutionItem {
  return isRecord(value) && isToolExecutionItemWithLifecycle(value, false)
}

function isAgentMessageItem(
  value: Record<string, unknown>,
): value is AgentMessageExecutionItem {
  return (
    onlyKeys(value, ["type", "itemId", "content", "providerMetadata"]) &&
    isString(value.itemId) &&
    Array.isArray(value.content) &&
    value.content.every(
      (block) =>
        isRecord(block) &&
        onlyKeys(block, ["type", "text"]) &&
        block.type === "text" &&
        isString(block.text),
    ) &&
    (value.providerMetadata === undefined ||
      isJsonObject(value.providerMetadata))
  )
}

function isReasoningItem(
  value: Record<string, unknown>,
): value is ReasoningExecutionItem {
  return (
    onlyKeys(value, ["type", "itemId", "text", "providerMetadata"]) &&
    isString(value.itemId) &&
    isString(value.text) &&
    (value.providerMetadata === undefined ||
      isJsonObject(value.providerMetadata))
  )
}

function isStartedExecutionItem(value: unknown): value is StartedExecutionItem {
  if (!isRecord(value)) return false
  if (value.type === "agent_message") return isAgentMessageItem(value)
  if (value.type === "reasoning") return isReasoningItem(value)
  if (value.type === "context_compaction") {
    return onlyKeys(value, ["type", "itemId"]) && isString(value.itemId)
  }
  return isToolExecutionItem(value)
}

function isCompletedExecutionItem(
  value: unknown,
): value is ItemCompletedEvent["data"]["item"] {
  if (!isRecord(value)) return false
  if (value.type === "agent_message") return isAgentMessageItem(value)
  if (value.type === "reasoning") return isReasoningItem(value)
  if (value.type === "context_compaction") {
    return (
      onlyKeys(value, ["type", "itemId", "status", "error"]) &&
      isString(value.itemId) &&
      isItemStatus(value.status) &&
      (value.error === undefined || isKernelError(value.error))
    )
  }
  return (
    isToolExecutionItemWithLifecycle(value, true) &&
    isString(value.resultItemId) &&
    isItemContent(value.content) &&
    (value.output === undefined || isJsonValue(value.output)) &&
    (value.error === undefined || isKernelError(value.error))
  )
}

function isItemStatus(value: unknown): value is ItemStatus {
  return value === ItemStatus.Completed || value === ItemStatus.Failed
}

function isToolExecutionItemWithLifecycle(
  value: Record<string, unknown>,
  completed: boolean,
): value is ToolExecutionItem & Record<string, unknown> {
  const lifecycleKeys = completed
    ? ["resultItemId", "content", "output", "error"]
    : []
  const commonKeys = [
    "type",
    "itemId",
    "toolCallId",
    "name",
    "input",
    "requiresPermission",
    ...lifecycleKeys,
  ]
  if (
    !isString(value.itemId) ||
    !isString(value.toolCallId) ||
    !isString(value.name) ||
    !isJsonValue(value.input) ||
    typeof value.requiresPermission !== "boolean"
  ) {
    return false
  }
  switch (value.type) {
    case "command_execution":
      return (
        onlyKeys(value, [...commonKeys, "command", "description", "result"]) &&
        isString(value.command) &&
        (value.description === undefined || isString(value.description)) &&
        (value.result === undefined || isCommandExecutionResult(value.result))
      )
    case "file_change":
      return (
        onlyKeys(value, [...commonKeys, "request", "changes"]) &&
        isFileChangeRequest(value.request) &&
        isFileChanges(value.changes)
      )
    case "file_read":
      return (
        onlyKeys(value, [...commonKeys, "path", "offset", "limit", "result"]) &&
        isString(value.path) &&
        (value.offset === undefined || isPositiveInteger(value.offset)) &&
        (value.limit === undefined || isPositiveInteger(value.limit)) &&
        (value.result === undefined || isFileReadResult(value.result))
      )
    case "file_search":
      return (
        onlyKeys(value, [
          ...commonKeys,
          "operation",
          "pattern",
          "path",
          "outputMode",
          "lineNumbers",
          "result",
        ]) &&
        (value.operation === "grep" || value.operation === "glob") &&
        isString(value.pattern) &&
        (value.path === undefined || isString(value.path)) &&
        (value.outputMode === undefined ||
          value.outputMode === "content" ||
          value.outputMode === "files_with_matches" ||
          value.outputMode === "count") &&
        typeof value.lineNumbers === "boolean" &&
        (value.result === undefined || isFileSearchResult(value.result))
      )
    case "web_fetch":
      return (
        onlyKeys(value, [...commonKeys, "url", "result"]) &&
        isString(value.url) &&
        (value.result === undefined || isWebFetchResult(value.result))
      )
    case "web_search":
      return (
        onlyKeys(value, [...commonKeys, "query", "result"]) &&
        isString(value.query) &&
        (value.result === undefined || isWebSearchResult(value.result))
      )
    case "collaboration_tool_call":
      return (
        onlyKeys(value, [
          ...commonKeys,
          "action",
          "description",
          "receivers",
        ]) &&
        isCollaborationAction(value.action) &&
        isString(value.description) &&
        isCollaborationReceivers(value.receivers)
      )
    case "mcp_tool_call":
      return (
        onlyKeys(value, [
          ...commonKeys,
          "server",
          "tool",
          "arguments",
          "readOnlyHint",
          "result",
        ]) &&
        isString(value.server) &&
        isString(value.tool) &&
        isJsonValue(value.arguments) &&
        jsonValuesEqual(value.input, value.arguments) &&
        (value.readOnlyHint === undefined ||
          typeof value.readOnlyHint === "boolean") &&
        (value.result === undefined || isMcpToolCallResult(value.result))
      )
    case "dynamic_tool_call":
      return onlyKeys(value, commonKeys)
    default:
      return false
  }
}

function isFileChangeRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["operation", "paths"]) &&
    (value.operation === "edit" ||
      value.operation === "write" ||
      value.operation === "apply_patch") &&
    Array.isArray(value.paths) &&
    value.paths.every(isString)
  )
}

function isFileChanges(value: unknown): value is readonly FileChange[] {
  return (
    Array.isArray(value) &&
    value.every((change) => {
      if (!isRecord(change) || !isString(change.path)) return false
      if (change.kind === "add" || change.kind === "delete") {
        return (
          onlyKeys(change, ["path", "kind", "diff"]) &&
          (change.diff === undefined || isUnifiedDiff(change.diff))
        )
      }
      return (
        change.kind === "update" &&
        onlyKeys(change, ["path", "kind", "movePath", "diff"]) &&
        (change.movePath === undefined || isString(change.movePath)) &&
        (change.diff === undefined || isUnifiedDiff(change.diff))
      )
    })
  )
}

function isMcpToolCallResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["content", "structuredContent", "isError", "_meta"]) &&
    Array.isArray(value.content) &&
    value.content.every(isJsonValue) &&
    (value.structuredContent === undefined ||
      isJsonValue(value.structuredContent)) &&
    (value.isError === undefined || typeof value.isError === "boolean") &&
    (value._meta === undefined || isJsonValue(value._meta))
  )
}

function isUnifiedDiff(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["format", "text", "truncated"]) &&
    value.format === "unified" &&
    isString(value.text) &&
    typeof value.truncated === "boolean"
  )
}

function isCommandExecutionResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const binary = value.binary
  const blocked = value.blocked
  return (
    onlyKeys(value, [
      "exitCode",
      "signal",
      "stdout",
      "stderr",
      "truncated",
      "timedOut",
      "durationMs",
      "cwd",
      "shell",
      "warnings",
      "blocked",
      "binary",
    ]) &&
    (value.exitCode === null || typeof value.exitCode === "number") &&
    (value.signal === null || isString(value.signal)) &&
    isString(value.stdout) &&
    isString(value.stderr) &&
    typeof value.truncated === "boolean" &&
    typeof value.timedOut === "boolean" &&
    (value.durationMs === undefined || typeof value.durationMs === "number") &&
    (value.cwd === undefined || isString(value.cwd)) &&
    (value.shell === undefined || isString(value.shell)) &&
    (value.warnings === undefined ||
      (Array.isArray(value.warnings) && value.warnings.every(isString))) &&
    (blocked === undefined ||
      (isRecord(blocked) &&
        onlyKeys(blocked, ["rule"]) &&
        isString(blocked.rule))) &&
    (binary === undefined ||
      (isRecord(binary) &&
        onlyKeys(binary, ["stdout", "stderr", "stdoutBytes", "stderrBytes"]) &&
        typeof binary.stdout === "boolean" &&
        typeof binary.stderr === "boolean" &&
        typeof binary.stdoutBytes === "number" &&
        typeof binary.stderrBytes === "number"))
  )
}

function isFileReadResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "path",
      "kind",
      "count",
      "entries",
      "range",
      "empty",
      "truncated",
    ]) &&
    isString(value.path) &&
    (value.kind === "file" || value.kind === "directory") &&
    (value.count === undefined || typeof value.count === "number") &&
    (value.entries === undefined ||
      (Array.isArray(value.entries) && value.entries.every(isString))) &&
    (value.range === undefined || isResultRange(value.range)) &&
    typeof value.empty === "boolean" &&
    typeof value.truncated === "boolean"
  )
}

function isResultRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["offset", "limit"]) &&
    isPositiveInteger(value.offset) &&
    Number.isInteger(value.limit) &&
    typeof value.limit === "number" &&
    value.limit >= 0
  )
}

function isFileSearchResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "path",
      "outputMode",
      "count",
      "truncated",
      "timedOut",
      "paths",
      "matches",
    ]) &&
    isString(value.path) &&
    (value.outputMode === "content" ||
      value.outputMode === "files_with_matches" ||
      value.outputMode === "count") &&
    typeof value.count === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.timedOut === "boolean" &&
    (value.paths === undefined ||
      (Array.isArray(value.paths) && value.paths.every(isString))) &&
    (value.matches === undefined || isFileSearchMatches(value.matches))
  )
}

function isFileSearchMatches(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (match) =>
        isRecord(match) &&
        onlyKeys(match, ["path", "line", "text", "count"]) &&
        isString(match.path) &&
        (match.line === undefined || typeof match.line === "number") &&
        (match.text === undefined || isString(match.text)) &&
        (match.count === undefined || typeof match.count === "number"),
    )
  )
}

function isWebFetchResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["url", "status", "truncated"]) &&
    isString(value.url) &&
    typeof value.status === "number" &&
    typeof value.truncated === "boolean"
  )
}

function isWebSearchResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["links"]) &&
    Array.isArray(value.links) &&
    value.links.every(
      (link) =>
        isRecord(link) &&
        onlyKeys(link, ["title", "url"]) &&
        isString(link.title) &&
        isString(link.url),
    )
  )
}

function isCollaborationReceivers(
  value: unknown,
): value is readonly CollaborationReceiver[] {
  return (
    Array.isArray(value) &&
    value.every(
      (receiver) =>
        isRecord(receiver) &&
        onlyKeys(receiver, ["sessionId", "path"]) &&
        isString(receiver.sessionId) &&
        isString(receiver.path),
    )
  )
}

function isCollaborationAction(value: unknown): value is CollaborationAction {
  return (
    value === "spawn" ||
    value === "send_message" ||
    value === "follow_up" ||
    value === "wait" ||
    value === "interrupt" ||
    value === "list"
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
      "replacesInheritedContext",
      "history",
      "worldStateBaseline",
    ]) &&
    isString(value.windowId) &&
    isString(value.firstWindowId) &&
    (value.previousWindowId === undefined ||
      isString(value.previousWindowId)) &&
    isPositiveInteger(value.windowNumber) &&
    (value.replacesInheritedContext === undefined ||
      typeof value.replacesInheritedContext === "boolean") &&
    Array.isArray(value.history) &&
    value.history.every(isModelMessage) &&
    isJsonObject(value.worldStateBaseline)
  )
}

export function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value) || !isString(value.role)) return false
  if (value.role === "tool") {
    return (
      onlyKeys(value, [
        "role",
        "toolCallId",
        "content",
        "isError",
        "fileObservation",
      ]) &&
      isString(value.toolCallId) &&
      isString(value.content) &&
      (value.isError === undefined || typeof value.isError === "boolean") &&
      (value.fileObservation === undefined ||
        isFileObservation(value.fileObservation))
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

function isFileObservation(value: unknown): value is FileObservation {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "path",
      "kind",
      "complete",
      "sha256",
      "ranges",
      "created",
      "optimisticRebase",
    ]) ||
    !isString(value.path) ||
    (value.kind !== "edit" &&
      value.kind !== "ranged_read" &&
      value.kind !== "whole_file_read" &&
      value.kind !== "write") ||
    typeof value.complete !== "boolean" ||
    (value.sha256 !== undefined &&
      (!isString(value.sha256) || !/^[a-f0-9]{64}$/iu.test(value.sha256))) ||
    (value.created !== undefined && typeof value.created !== "boolean") ||
    (value.optimisticRebase !== undefined &&
      typeof value.optimisticRebase !== "boolean")
  ) {
    return false
  }
  return (
    value.ranges === undefined ||
    (Array.isArray(value.ranges) && value.ranges.every(isFileObservationRange))
  )
}

function isFileObservationRange(
  value: unknown,
): value is { readonly startLine: number; readonly endLine: number } {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["startLine", "endLine"]) ||
    typeof value.startLine !== "number" ||
    typeof value.endLine !== "number" ||
    !isPositiveInteger(value.startLine) ||
    !isPositiveInteger(value.endLine)
  ) {
    return false
  }
  return value.endLine >= value.startLine
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
    value.type === "image" &&
    onlyKeys(value, ["type", "mediaType", "detail", "file", "sizeBytes"]) &&
    isSupportedImageMediaType(value.mediaType) &&
    (value.detail === undefined || isImageDetail(value.detail)) &&
    isRolloutAssetReference(value.file) &&
    isNonNegativeInteger(value.sizeBytes)
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

export function isSessionConfigurationSnapshot(
  value: unknown,
): value is SessionConfigurationSnapshot {
  if (!isRecord(value)) return false
  if (
    !onlyKeys(value, [
      "schemaVersion",
      "workspaceRoot",
      "promptCacheKey",
      "defaultTarget",
      "baseInstructions",
      "enabledTools",
      "approvalPolicy",
      "executionPolicyDefaults",
      "modelContextWindowTokens",
    ]) ||
    value.schemaVersion !== 3 ||
    !isString(value.workspaceRoot) ||
    !isString(value.promptCacheKey) ||
    value.promptCacheKey.trim().length === 0 ||
    !isModelSelection(value.defaultTarget) ||
    !isBaseInstructionsSnapshot(value.baseInstructions) ||
    !Array.isArray(value.enabledTools) ||
    !value.enabledTools.every(isString) ||
    (value.approvalPolicy !== "auto_file_tools" &&
      value.approvalPolicy !== "never") ||
    !isSessionExecutionPolicyDefaults(value.executionPolicyDefaults) ||
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
    onlyKeys(value.provenance, [
      "type",
      "provider",
      "model",
      "instructionProfileId",
    ]) &&
    isString(value.provenance.provider) &&
    isString(value.provenance.model) &&
    isString(value.provenance.instructionProfileId)
  )
}

function isSessionExecutionPolicyDefaults(
  value: unknown,
): value is SessionExecutionPolicyDefaultsSnapshot {
  return (
    isRecord(value) &&
    onlyKeys(value, sessionExecutionPolicyKeys) &&
    Object.keys(value).length === sessionExecutionPolicyKeys.length &&
    Object.values(value).every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
    ) &&
    typeof value.compactionTriggerRatio === "number" &&
    value.compactionTriggerRatio > 0 &&
    value.compactionTriggerRatio <= 1 &&
    typeof value.compactionRetainRatio === "number" &&
    value.compactionRetainRatio < value.compactionTriggerRatio
  )
}

const sessionExecutionPolicyKeys = [
  "modelCallsPerTurn",
  "toolCallsPerTurn",
  "modelVisibleMessageBlocks",
  "modelVisibleContextBytes",
  "compactionTriggerRatio",
  "compactionRetainRatio",
  "modelVisibleToolResultBytes",
  "modelVisibleToolResultLines",
  "compactionSummaryBytes",
  "assistantResponseBytes",
] as const

function optionalFieldsAreValid(data: Record<string, unknown>): boolean {
  if ("reason" in data && data.reason !== undefined && !isString(data.reason))
    return false
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

function isInputRole(value: unknown): value is InputRole {
  return typeof value === "string" && inputRoles.has(value)
}

export function isTokenUsage(value: unknown): value is TokenUsage {
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
    onlyKeys(value, ["name", "mediaType", "detail", "file", "sizeBytes"]) &&
    isString(value.name) &&
    isSupportedImageMediaType(value.mediaType) &&
    (value.detail === undefined || isImageDetail(value.detail)) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isRolloutAssetReference(value.file)
  )
}

function isRolloutAssetReference(
  value: unknown,
): value is RolloutAssetReference {
  return (
    isRecord(value) &&
    onlyKeys(value, ["rolloutId", "path"]) &&
    isStorageKey(value.rolloutId) &&
    isString(value.path)
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

function isImageDetail(value: unknown): value is ImageDetail {
  return value === "high" || value === "original"
}

export function isModelSelection(value: unknown): value is ModelSelection {
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

function isTurnOutcome(value: unknown): value is TurnOutcome {
  if (!isRecord(value)) return false
  switch (value.status) {
    case "completed":
      return onlyKeys(value, ["status"])
    case "failed":
      return onlyKeys(value, ["status", "error"]) && isKernelError(value.error)
    case "cancelled":
    case "interrupted":
      return (
        onlyKeys(value, ["status", "reason"]) &&
        (value.reason === undefined || isString(value.reason))
      )
    default:
      return false
  }
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
