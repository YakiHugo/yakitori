import type { JsonObject, JsonValue } from "../kernel/events.ts"
import type {
  AssetSource,
  ImageAttachment,
  ImageDetail,
} from "./asset-types.ts"
import type { ContextExcerpt } from "./input-context.ts"
// Portable conversation records belong to Session persistence. Providers adapt
// them at the wire boundary without replacing stored sources with native IDs.
export type ModelTextBlock = Readonly<{
  type: "text"
  text: string
  providerMetadata?: JsonObject
}>
export type ModelImageBlock =
  | Readonly<{
      type: "image"
      mediaType: ImageAttachment["mediaType"]
      detail?: ImageDetail
      data: string
      file?: never
      sizeBytes?: never
    }>
  | Readonly<{
      type: "image"
      mediaType: ImageAttachment["mediaType"]
      detail?: ImageDetail
      file: AssetSource
      sizeBytes: number
      name?: string
      data?: never
    }>
export type ModelDocumentBlock = Readonly<{
  type: "document"
  name: string
  mediaType: "application/pdf"
  sizeBytes: number
  file: AssetSource
  // Request-only; durable history retains the asset reference.
  data?: string
}>
export type ModelReasoningBlock = Readonly<{
  type: "reasoning"
  text: string
  providerMetadata?: JsonObject
}>
// Opaque history owned by one provider/account. Convert it through that owner
// before a cross-provider handoff; dropping it would silently lose context.
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
  syntax: "lark"
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
// Tool content is data, not an assistant continuation or a host/UI metadata channel.
// Tool content is data, not an assistant continuation or a host/UI metadata channel.
export type ModelToolContentBlock =
  | Readonly<{
      type: "text"
      text: string
    }>
  | ModelImageBlock
  | ModelDocumentBlock
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
