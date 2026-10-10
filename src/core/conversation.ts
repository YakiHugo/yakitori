import type {
  ModelDocumentBlock,
  ModelImageBlock,
  ModelTextBlock,
  ModelToolContentBlock,
} from "../protocol/conversation.ts"

export type {
  ModelDocumentBlock,
  ModelImageBlock,
  ModelTextBlock,
  ModelToolContentBlock,
} from "../protocol/conversation.ts"

import type { JsonObject, JsonValue } from "../kernel/events.ts"
import type { ContextExcerpt } from "./input-context.ts"
export type ModelReasoningBlock = Readonly<{
  type: "reasoning"
  text: string
  providerMetadata?: JsonObject
}>
// Opaque history owned by one provider/account. Convert it through that owner
// before a cross-provider handoff; dropping it would silently lose context.
export type ModelCompactionBlock = Readonly<{
  type: "compaction"
  provider: string
  model: string
  scope: string
  encryptedContent: string
  id?: string
  metadata?: JsonObject
}>
export type ModelToolInputFormat = Readonly<{
  type: "grammar"
  syntax: "lark" | "regex"
  definition: string
}>
export type ModelToolDefinition = Readonly<{
  name: string
  description: string
  inputSchema: JsonObject
  kind?: "function" | "custom" | "tool_search"
  inputFormat?: ModelToolInputFormat
  customInputFallbackKey?: string
  deferLoading?: boolean
  strict?: boolean
}>
export type ModelToolCallBlock = Readonly<{
  type: "tool_call"
  id: string
  name: string
  input: JsonValue
  toolKind?: "function" | "custom" | "tool_search"
  customInputFallbackKey?: string
  providerMetadata?: JsonObject
}>
export type ModelContentBlock =
  | ModelTextBlock
  | ModelReasoningBlock
  | ModelCompactionBlock
  | ModelToolCallBlock
export type ModelHistoryContext =
  | Readonly<{
      type: "skill_invocation"
      inputId: string
    }>
  | Readonly<{
      type: "goal"
      goalId: string
    }>
  | Readonly<{
      type: "world_state"
      sectionId: string
      revision: string
    }>
export type ModelUserContentBlock =
  | ModelTextBlock
  | ModelImageBlock
  | ModelDocumentBlock
export type ModelUserMessage = Readonly<{
  role: "user"
  content: readonly ModelUserContentBlock[]
  context?: ModelHistoryContext
  contextAttachments?: readonly ContextExcerpt[]
}>
export type ModelDeveloperMessage = Readonly<{
  role: "developer"
  content: readonly ModelTextBlock[]
  context?: ModelHistoryContext
}>
export type ModelAssistantMessage = Readonly<{
  role: "assistant"
  content: readonly ModelContentBlock[]
  // Native output is the owner's replay source; content is the execution and
  // display projection. Synthetic assistant messages need neither field.
  native?: readonly ModelNativeItem[]
  response?: ModelResponseOrigin
}>

export type ModelResponseOrigin = Readonly<{
  callId: string
  attemptId: string
  attempt: number
  provider: string
  model: string
}>

// Multi-provider support requires native state beyond Codex's ResponseItem.
// Each adapter validates and encodes only its own protocol and credential scope.
export type ModelNativeItem = Readonly<{
  provider: string
  scope?: string
  model: string
  wireApi:
    | "openai_responses"
    | "openai_chat_completions"
    | "anthropic_messages"
    | "gemini_generate_content"
  value: JsonObject
}>
export type FileObservation = Readonly<{
  path: string
  kind:
    | "delete"
    | "edit"
    | "invalidate"
    | "ranged_read"
    | "whole_file_read"
    | "write"
  complete: boolean
  sha256?: string
  ranges?: readonly Readonly<{
    startLine: number
    endLine: number
  }>[]
  created?: boolean
  optimisticRebase?: boolean
}>
export type ModelToolResultMessage = Readonly<{
  role: "tool"
  toolCallId: string
  content: readonly ModelToolContentBlock[]
  isError?: boolean
  // A structural discovery result. Provider adapters encode this as an
  // OpenAI tool_search_output or Anthropic tool_reference blocks instead of
  // degrading it to ordinary tool-result text.
  toolSearch?: Readonly<{
    tools: readonly ModelToolDefinition[]
  }>
  // Execution-only metadata. Providers receive content; the actor retains this
  // grant so later model-visible Turns can safely authorize file mutations.
  fileObservations?: readonly FileObservation[]
}>
export type ModelMessage =
  | ModelUserMessage
  | ModelDeveloperMessage
  | ModelAssistantMessage
  | ModelToolResultMessage
