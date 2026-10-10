import type { ModelFailureKind } from "../protocol/model-failure.ts"

export type { ModelFailureKind } from "../protocol/model-failure.ts"

import type { AssetSource, RolloutAssetReference } from "../core/asset-types.ts"
import type {
  JsonObject,
  ModelAssistantMessage,
  ModelCompactionBlock,
  ModelContentBlock,
  ModelDeveloperMessage,
  ModelDocumentBlock,
  ModelImageBlock,
  ModelMessage,
  ModelNativeItem,
  ModelReasoningBlock,
  ModelResponseOrigin,
  ModelTextBlock,
  ModelToolCallBlock,
  ModelToolContentBlock,
  ModelToolDefinition,
  ModelToolInputFormat,
  ModelToolResultMessage,
  ModelUserContentBlock,
  ModelUserMessage,
} from "../kernel/index.ts"

export type {
  ModelAssistantMessage,
  ModelCompactionBlock,
  ModelContentBlock,
  ModelDeveloperMessage,
  ModelDocumentBlock,
  ModelImageBlock,
  ModelMessage,
  ModelNativeItem,
  ModelReasoningBlock,
  ModelResponseOrigin,
  ModelTextBlock,
  ModelToolCallBlock,
  ModelToolContentBlock,
  ModelToolDefinition,
  ModelToolInputFormat,
  ModelToolResultMessage,
  ModelUserContentBlock,
  ModelUserMessage,
}

export const ModelStopReason = {
  EndTurn: "end_turn",
  Length: "length",
  ToolUse: "tool_use",
  ContentFilter: "content_filter",
  // Server tools paused their work; the harness resubmits native history.
  PauseTurn: "pause_turn",
} as const

export type ModelStopReason =
  (typeof ModelStopReason)[keyof typeof ModelStopReason]

export type ModelTarget = {
  readonly provider: string
  readonly model: string
  readonly instructionProfileId: string
  readonly effort?: string
  readonly speed?: string
}

export type ModelWireApi =
  | "anthropic_messages"
  | "faux"
  | "gemini_generate_content"
  | "openai_chat_completions"
  | "openai_responses"
  | "unknown"

export type ToolWireProtocol =
  | "anthropic_deferred"
  | "eager"
  | "meta_dispatch"
  | "openai_deferred"

export type ModelSystemSection = {
  readonly id: string
  readonly revision: string
  readonly text: string
}

export type ModelRequest = Readonly<{
  // Request-only access; neither HTTP deployment addresses nor provider file
  // handles are written into the durable conversation.
  assets?: Readonly<{
    read(source: AssetSource, signal?: AbortSignal): Promise<Buffer>
    url?(source: RolloutAssetReference): string | undefined
  }>
  // Commit completed provider items while the response is still streaming.
  streamOutputItems?: boolean
  // After committed output, retry only from the consumer's updated history.
  rebuildMessagesAfterOutput?: () => Promise<readonly ModelMessage[]>
  // Request-only control; the resulting native item enters normal history.
  compaction?: "local" | "codex_remote" | "responses_compact"
  target: ModelTarget
  // Runtime-only fence for opaque provider continuation state. The provider
  // owner adds it immediately before transport serialization; Session target
  // configuration never sets or persists it.
  continuationScope?: string
  cacheKey?: string
  system: readonly ModelSystemSection[]
  messages: readonly ModelMessage[]
  tools: readonly ModelToolDefinition[]
  toolWireProtocol: ToolWireProtocol
  maxOutputTokens?: number
  toolChoice?: "auto" | "none" | "required" | Readonly<{ name: string }>
  parallelToolCalls?: boolean
  outputFormat?: Readonly<{
    type: "json_schema"
    name: string
    schema: JsonObject
    strict?: boolean
  }>
  // Provider-owned API controls (thinking, cache, hosted tools, response format,
  // etc.) cannot be translated by guessing from an OpenAI-compatible URL.
  // The adapter keeps the harness-owned input, model and streaming contract.
  providerOptions?: Readonly<{
    provider: string
    wireApi: ModelNativeItem["wireApi"]
    body: JsonObject
    // Anthropic feature opt-ins are HTTP headers rather than body fields.
    betas?: readonly string[]
  }>
  // Runtime-only physical attempt context. Provider adapters may use it to
  // rebuild transport resources; it is never serialized onto the wire.
  attempt?: Readonly<{
    number: number
    maxAttempts: number
    previousFailure?: ModelFailure
  }>
  // Runtime-only observation of cumulative usage for this physical attempt.
  // Providers report synchronously before awaiting more data, so cancellation
  // cannot discard already received usage. This is not an accounting event.
  onUsageSnapshot?: (usage: ModelUsage) => void
  signal?: AbortSignal
}>

// Yakitori's requested budget for the required Messages max_tokens field,
// not a provider capability or API default. Optional output limits stay unset.
export const DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS = 32_000

export function resolveModelRequestMaxOutputTokens(
  provider: string,
  maxOutputTokens?: number,
): number | undefined {
  if (provider === "codex") return undefined
  return provider === "anthropic" || provider === "kimi"
    ? (maxOutputTokens ?? DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS)
    : maxOutputTokens
}

export function flattenModelSystem(
  sections: readonly ModelSystemSection[],
): string {
  return sections.map((section) => section.text).join("\n\n")
}

export type ModelUsage = Readonly<{
  rolloutBudgetUnits?: number
  // Billing counters accumulate across physical requests.
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  // Provider-reported size of the model-visible prefix for this response.
  // Unlike billing counters, callers keep the latest value rather than sum it.
  activeContextTokens?: number
}>

export type ModelFailureStage =
  | "connect"
  | "model_event"
  | "request_build"
  | "response_body"
  | "response_headers"
  | "sse_decode"

export type ModelFailure = Readonly<{
  kind: ModelFailureKind
  stage: ModelFailureStage
  provider: string
  wireApi: ModelWireApi
  message: string
  status?: number
  providerCode?: string
  providerRequestId?: string
  providerResponseId?: string
  retryAfterMs?: number
  serverShouldRetry?: boolean
  attempt?: number
  maxAttempts?: number
  outputObserved?: boolean
  retryDecision?: "fail" | "retry"
  details?: JsonObject
}>

export type ModelResponse = Readonly<{
  stopReason: ModelStopReason
  origin?: ModelResponseOrigin
  rawStopReason?: string
  lengthReason?: "output" | "context" | "unknown"
  // Tool calls in content are complete; an unusable tail is never executable.
  incompleteToolCalls?: boolean
  content: readonly ModelContentBlock[]
  native?: readonly ModelNativeItem[]
  nativeMetadata?: ModelNativeItem
  providerResponseId?: string
  usage?: ModelUsage
  providerRequestId?: string
}>

export type ModelStreamDeltaEvent = Readonly<{
  type: "delta"
  text: string
  itemId?: string
}>

export type ModelStreamReasoningDeltaEvent = Readonly<{
  type: "reasoning_delta"
  text: string
  itemId?: string
}>

export type ModelStreamOutputItemEvent = Readonly<{
  type: "output_item"
  itemId: string
  content: readonly ModelContentBlock[]
  native?: readonly ModelNativeItem[]
}>

export type ModelStreamResponseEvent = {
  readonly type: "response"
  readonly response: ModelResponse
}

export type ModelStreamFailureEvent = {
  readonly type: "failure"
  readonly failure: ModelFailure
  readonly usage?: ModelUsage
  // Runtime-only diagnostic. It must never be copied into rollout or RPC data.
  readonly cause?: unknown
}

export type ModelStreamCancelledEvent = Readonly<{
  type: "cancelled"
  usage?: ModelUsage
}>

export type ModelStreamRetryEvent = Readonly<{
  type: "retry"
  committedOutput?: boolean
  attempt: number
  nextAttempt: number
  maxAttempts: number
  delayMs: number
  failure: ModelFailure
  usage?: ModelUsage
}>

export type ModelStreamEvent =
  | ModelStreamDeltaEvent
  | ModelStreamReasoningDeltaEvent
  | ModelStreamOutputItemEvent
  | ModelStreamResponseEvent
  | ModelStreamFailureEvent
  | ModelStreamCancelledEvent
  | ModelStreamRetryEvent

export type StreamFn = (
  request: ModelRequest,
) => AsyncIterable<ModelStreamEvent>

export function requireModelImageData(image: ModelImageBlock): string {
  if ("data" in image && image.data !== undefined) return image.data
  throw new Error("Model request contains an unresolved Session image.")
}

export function requireModelDocumentData(document: ModelDocumentBlock): string {
  if (document.data !== undefined) return document.data
  throw new Error("Model request contains an unresolved Session PDF.")
}
