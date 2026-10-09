import {
  isInputAdmittedData,
  isKernelError,
  isModelSelection,
  isTurnCompletedData,
} from "../protocol/event-validation.ts"

export {
  isModelSelection,
  isTokenUsage,
  isTurnCompletion,
  isTurnMetrics,
} from "../protocol/event-validation.ts"

import { isJsonObject, isJsonValue } from "../protocol/json.ts"

export { COMPACT_DIRECTIVE, GOAL_DIRECTIVE } from "../protocol/directives.ts"
export { isJsonObject, isJsonValue } from "../protocol/json.ts"

import {
  type AgentMessageExecutionItem,
  type CollaborationAction,
  type CollaborationReceiver,
  type EventEnvelope,
  type EventEnvelopeBase,
  EventType,
  type FileChange,
  ForkReason,
  type ItemCompletedEvent,
  type ItemContent,
  ItemStatus,
  type JsonObject,
  type KernelEvent,
  type ModelSelection,
  type ReasoningExecutionItem,
  type SessionHistoryPosition,
  type StartedExecutionItem,
  type TextContent,
  type ToolExecutionItem,
} from "../protocol/events.ts"

export {
  type AgentMessageExecutionItem,
  type CollaborationAction,
  type CollaborationReceiver,
  type CommandExecutionResult,
  type CompletedExecutionItem,
  type ContextCompactionCompletedItem,
  type ContextCompactionStartedItem,
  type ContextTokensEvent,
  type EventEnvelope,
  type EventEnvelopeBase,
  type EventMetadata,
  EventType,
  type FileChange,
  type FileChangeDiff,
  type FileReadResult,
  type FileSearchResult,
  ForkReason,
  type InputAdmittedEvent,
  InputRole,
  type ItemCompletedEvent,
  type ItemContent,
  type ItemStartedEvent,
  ItemStatus,
  type JsonContent,
  type JsonObject,
  type JsonValue,
  type KernelError,
  type KernelEvent,
  type McpToolCallResult,
  type ModelSelection,
  type ReasoningExecutionItem,
  type SessionCreatedEvent,
  type SessionHistoryPosition,
  type StartedExecutionItem,
  type StreamedStartedItem,
  type TextContent,
  type TokenUsage,
  type ToolExecutionDescriptor,
  type ToolExecutionItem,
  type ToolExecutionItemBase,
  type ToolResultContent,
  type TurnCompletedEvent,
  type TurnCompletion,
  type TurnLatency,
  type TurnMetrics,
  type TurnOutcome,
  type TurnStartedEvent,
  type WebFetchResult,
  type WebSearchResult,
} from "../protocol/events.ts"

import {
  type ImageAttachment,
  type ImageDetail,
  isAssetSource,
  isImageAttachment,
} from "../core/asset-types.ts"
import { isContextExcerpts } from "../core/input-context.ts"
import { createEventId, isStorageKey } from "./ids.ts"
import { jsonValuesEqual } from "./json-equality.ts"

export type {
  AssetSource,
  ImageAttachment,
  ImageDetail,
  PdfAttachment,
  RolloutAssetReference,
  UserAttachment,
} from "../core/asset-types.ts"
export { isImageAttachment, isPdfAttachment } from "../core/asset-types.ts"

export const EVENT_SCHEMA_VERSION = 7

// Recorded on tools left open at a terminal Turn so GUI and model context
// render one fact instead of synthesizing different missing-result text.
export const MISSING_TOOL_RESULT_TEXT =
  "No tool result was recorded. Execution status and side effects are unknown. Inspect the current state before retrying."

export { type InputContent, isInputContent } from "../core/user-input.ts"

import type {
  FileObservation,
  ModelDocumentBlock,
  ModelMessage,
  ModelToolContentBlock,
} from "../core/conversation.ts"

export type {
  FileObservation,
  ModelAssistantMessage,
  ModelCompactionBlock,
  ModelContentBlock,
  ModelDeveloperMessage,
  ModelDocumentBlock,
  ModelHistoryContext,
  ModelImageBlock,
  ModelMessage,
  ModelReasoningBlock,
  ModelTextBlock,
  ModelToolCallBlock,
  ModelToolContentBlock,
  ModelToolDefinition,
  ModelToolInputFormat,
  ModelToolResultMessage,
  ModelUserContentBlock,
  ModelUserMessage,
} from "../core/conversation.ts"

export type TurnExecutionLimits = {
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
  readonly assistantResponseBytes: number
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
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
  readonly assistantResponseBytes: number
}

export type ApprovalPolicy = "always_approve" | "auto_file_tools"
export type AutoCompactTokenLimitScope = "body_after_prefix" | "total"

export type ModelRequestPolicy = Readonly<{
  maxAttempts?: number
  rateLimitMaxAttempts?: number
  streamIdleTimeoutMs?: number
}>

export type ModelTransportPolicy = ModelRequestPolicy &
  Readonly<{
    providers?: Readonly<Record<string, ModelRequestPolicy>>
  }>

export type SessionConfigurationSnapshot = {
  readonly schemaVersion: 5
  readonly workspaceRoot: string
  readonly promptCacheKey: string
  readonly defaultTarget: ModelSelection
  readonly baseInstructions: BaseInstructionsSnapshot
  readonly enabledTools: readonly string[]
  readonly approvalPolicy: ApprovalPolicy
  readonly executionPolicyDefaults: SessionExecutionPolicyDefaultsSnapshot
  readonly modelContextWindowTokens?: number
  readonly modelAutoCompactTokenLimit?: number
  readonly modelAutoCompactTokenLimitScope: AutoCompactTokenLimitScope
  readonly modelTransport?: ModelTransportPolicy
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
  readonly approvalPolicy: ApprovalPolicy
  readonly executionPolicy: TurnExecutionLimits
}

export type WorldStateFragment = {
  readonly id: string
  readonly revision: string
  readonly role: "user" | "developer"
  readonly text: string
}

export type KernelFact = KernelEvent
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
): Fact extends KernelEvent
  ? EventEnvelopeBase & Omit<Fact, keyof EventEnvelopeBase>
  : never
export function createEventEnvelope(input: EventEnvelopeInput): EventEnvelope {
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
    ...input.event,
    id: input.id ?? createEventId(),
    sessionId: input.sessionId,
    seq: input.seq,
    version,
    createdAt: input.createdAt ?? new Date().toISOString(),
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
            "projectId",
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
        return isInputAdmittedData(data)
      case EventType.TurnStarted:
        return (
          onlyKeys(data, ["turnId", "inputId", "parentTurnId", "metadata"]) &&
          isString(data.turnId) &&
          isString(data.inputId) &&
          (data.parentTurnId === undefined || isString(data.parentTurnId))
        )
      case EventType.TurnCompleted:
        return isTurnCompletedData(data)
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
      case EventType.ContextTokens:
        return (
          onlyKeys(data, [
            "turnId",
            "activeContextTokens",
            "capacityTokens",
            "provider",
            "model",
          ]) &&
          isString(data.turnId) &&
          isNonNegativeInteger(data.activeContextTokens) &&
          (data.capacityTokens === undefined ||
            isNonNegativeInteger(data.capacityTokens)) &&
          (data.provider === undefined || isString(data.provider)) &&
          (data.model === undefined || isString(data.model))
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
        onlyKeys(block, ["type", "text", "providerMetadata"]) &&
        block.type === "text" &&
        isString(block.text) &&
        (block.providerMetadata === undefined ||
          isJsonObject(block.providerMetadata)),
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
        onlyKeys(value, [...commonKeys, "request", "changes", "exact"]) &&
        isFileChangeRequest(value.request) &&
        isFileChanges(value.changes) &&
        (value.exact === undefined || typeof value.exact === "boolean")
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

function isModelToolContentBlock(
  value: unknown,
): value is ModelToolContentBlock {
  return (
    (isRecord(value) &&
      onlyKeys(value, ["type", "text"]) &&
      value.type === "text" &&
      isString(value.text)) ||
    isModelImageBlock(value) ||
    isModelDocumentBlock(value)
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
        "toolSearch",
        "fileObservations",
      ]) &&
      isString(value.toolCallId) &&
      Array.isArray(value.content) &&
      value.content.every(isModelToolContentBlock) &&
      (value.isError === undefined || typeof value.isError === "boolean") &&
      (value.toolSearch === undefined ||
        (isRecord(value.toolSearch) &&
          onlyKeys(value.toolSearch, ["tools"]) &&
          Array.isArray(value.toolSearch.tools) &&
          value.toolSearch.tools.every(isModelToolDefinition))) &&
      (value.fileObservations === undefined ||
        (Array.isArray(value.fileObservations) &&
          value.fileObservations.every(isFileObservation)))
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
    onlyKeys(value, ["role", "content", "context", "contextAttachments"]) &&
    (value.contextAttachments === undefined ||
      (value.role === "user" && isContextExcerpts(value.contextAttachments))) &&
    Array.isArray(value.content) &&
    value.content.every(
      (block) =>
        (isRecord(block) &&
          onlyKeys(block, ["type", "text", "providerMetadata"]) &&
          block.type === "text" &&
          isString(block.text) &&
          (block.providerMetadata === undefined ||
            isJsonObject(block.providerMetadata))) ||
        (value.role === "user" &&
          (isModelImageBlock(block) ||
            (isModelDocumentBlock(block) && block.data === undefined))),
    ) &&
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
    (value.kind !== "delete" &&
      value.kind !== "edit" &&
      value.kind !== "invalidate" &&
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
    return (
      onlyKeys(value, ["type", "text", "providerMetadata"]) &&
      isString(value.text) &&
      (value.providerMetadata === undefined ||
        isJsonObject(value.providerMetadata))
    )
  }
  if (value.type === "reasoning") {
    return (
      onlyKeys(value, ["type", "text", "providerMetadata"]) &&
      isString(value.text) &&
      (value.providerMetadata === undefined ||
        isJsonObject(value.providerMetadata))
    )
  }
  if (value.type === "compaction") {
    return (
      onlyKeys(value, [
        "type",
        "provider",
        "model",
        "scope",
        "encryptedContent",
        "id",
        "metadata",
      ]) &&
      [value.provider, value.model, value.scope, value.encryptedContent].every(
        (field) => typeof field === "string" && field.length > 0,
      ) &&
      (value.id === undefined || isString(value.id)) &&
      (value.metadata === undefined || isJsonObject(value.metadata))
    )
  }
  return (
    value.type === "tool_call" &&
    onlyKeys(value, [
      "type",
      "id",
      "name",
      "input",
      "toolKind",
      "customInputFallbackKey",
      "providerMetadata",
    ]) &&
    isString(value.id) &&
    isString(value.name) &&
    isJsonValue(value.input) &&
    (value.providerMetadata === undefined ||
      isJsonObject(value.providerMetadata)) &&
    (value.toolKind === "custom"
      ? isString(value.input) &&
        isString(value.customInputFallbackKey) &&
        value.customInputFallbackKey.trim().length > 0 &&
        value.customInputFallbackKey === value.customInputFallbackKey.trim()
      : (value.toolKind === undefined ||
          value.toolKind === "function" ||
          value.toolKind === "tool_search") &&
        value.customInputFallbackKey === undefined)
  )
}

function isModelToolDefinition(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "name",
      "description",
      "inputSchema",
      "kind",
      "inputFormat",
      "customInputFallbackKey",
      "deferLoading",
    ]) &&
    isString(value.name) &&
    isString(value.description) &&
    isJsonObject(value.inputSchema) &&
    (value.deferLoading === undefined ||
      typeof value.deferLoading === "boolean") &&
    (value.kind === "custom"
      ? isModelToolInputFormat(value.inputFormat) &&
        isString(value.customInputFallbackKey) &&
        value.customInputFallbackKey.trim().length > 0 &&
        value.customInputFallbackKey === value.customInputFallbackKey.trim()
      : (value.kind === undefined ||
          value.kind === "function" ||
          value.kind === "tool_search") &&
        value.inputFormat === undefined &&
        value.customInputFallbackKey === undefined)
  )
}

function isModelToolInputFormat(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["type", "syntax", "definition"]) &&
    value.type === "grammar" &&
    value.syntax === "lark" &&
    isString(value.definition)
  )
}

function isModelImageBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "image" &&
    onlyKeys(value, [
      "type",
      "mediaType",
      "detail",
      "file",
      "sizeBytes",
      "name",
    ]) &&
    isSupportedImageMediaType(value.mediaType) &&
    (value.detail === undefined || isImageDetail(value.detail)) &&
    isAssetSource(value.file) &&
    isNonNegativeInteger(value.sizeBytes) &&
    (value.name === undefined || isString(value.name))
  )
}

function isModelHistoryContext(value: unknown): boolean {
  if (isRecord(value) && value.type === "goal")
    return onlyKeys(value, ["type", "goalId"]) && isStorageKey(value.goalId)
  if (isRecord(value) && value.type === "skill_invocation")
    return onlyKeys(value, ["type", "inputId"]) && isString(value.inputId)
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
      "modelAutoCompactTokenLimit",
      "modelAutoCompactTokenLimitScope",
      "modelTransport",
    ]) ||
    value.schemaVersion !== 5 ||
    !isString(value.workspaceRoot) ||
    !isString(value.promptCacheKey) ||
    value.promptCacheKey.trim().length === 0 ||
    !isModelSelection(value.defaultTarget) ||
    !isBaseInstructionsSnapshot(value.baseInstructions) ||
    !Array.isArray(value.enabledTools) ||
    !value.enabledTools.every(isString) ||
    (value.approvalPolicy !== "always_approve" &&
      value.approvalPolicy !== "auto_file_tools") ||
    !isSessionExecutionPolicyDefaults(value.executionPolicyDefaults) ||
    (value.modelContextWindowTokens !== undefined &&
      !isPositiveInteger(value.modelContextWindowTokens)) ||
    (value.modelAutoCompactTokenLimit !== undefined &&
      !isPositiveInteger(value.modelAutoCompactTokenLimit)) ||
    (value.modelAutoCompactTokenLimitScope !== "total" &&
      value.modelAutoCompactTokenLimitScope !== "body_after_prefix") ||
    (value.modelTransport !== undefined &&
      !isModelTransportPolicy(value.modelTransport))
  ) {
    return false
  }
  return true
}

function isModelTransportPolicy(value: unknown): value is ModelTransportPolicy {
  if (!isRecord(value)) return false
  if (
    !onlyKeys(value, [
      "maxAttempts",
      "rateLimitMaxAttempts",
      "streamIdleTimeoutMs",
      "providers",
    ]) ||
    !hasValidModelRequestPolicyValues(value)
  ) {
    return false
  }
  return (
    value.providers === undefined ||
    (isRecord(value.providers) &&
      Object.values(value.providers).every(isModelRequestPolicy))
  )
}

function isModelRequestPolicy(value: unknown): value is ModelRequestPolicy {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "maxAttempts",
      "rateLimitMaxAttempts",
      "streamIdleTimeoutMs",
    ]) &&
    hasValidModelRequestPolicyValues(value)
  )
}

function hasValidModelRequestPolicyValues(
  value: Record<string, unknown>,
): boolean {
  return (
    (value.maxAttempts === undefined || isPositiveInteger(value.maxAttempts)) &&
    (value.rateLimitMaxAttempts === undefined ||
      isPositiveInteger(value.rateLimitMaxAttempts)) &&
    (value.streamIdleTimeoutMs === undefined ||
      isPositiveInteger(value.streamIdleTimeoutMs))
  )
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
    )
  )
}

const sessionExecutionPolicyKeys = [
  "modelVisibleToolResultBytes",
  "modelVisibleToolResultLines",
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
    "projectId",
    "mateId",
    "mateRevisionId",
    "conversationId",
    "parentSessionId",
    "forkedFromInputId",
    "parentInputId",
    "parentTurnId",
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

function isTextContent(value: unknown): value is TextContent {
  return (
    isRecord(value) &&
    value.kind === "text" &&
    isString(value.text) &&
    onlyKeys(value, ["kind", "text", "attachments", "contextAttachments"]) &&
    (value.contextAttachments === undefined ||
      isContextExcerpts(value.contextAttachments)) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.every(isImageAttachment)))
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

function isItemContent(value: unknown): value is ItemContent {
  if (!isRecord(value)) return false
  if (value.kind === "text") return isTextContent(value)
  if (value.kind === "tool_result")
    return (
      onlyKeys(value, ["kind", "parts"]) &&
      Array.isArray(value.parts) &&
      value.parts.every(
        (part) =>
          isModelToolContentBlock(part) &&
          // Completion facts retain asset ownership, never request-time PDF bytes.
          (part.type !== "document" || part.data === undefined),
      )
    )
  if (value.kind === "json")
    return isJsonValue(value.value) && onlyKeys(value, ["kind", "value"])
  return false
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

function isModelDocumentBlock(value: unknown): value is ModelDocumentBlock {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "type",
      "name",
      "mediaType",
      "sizeBytes",
      "file",
      "data",
    ]) &&
    value.type === "document" &&
    isString(value.name) &&
    value.mediaType === "application/pdf" &&
    typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    isAssetSource(value.file) &&
    (value.data === undefined || isString(value.data))
  )
}
