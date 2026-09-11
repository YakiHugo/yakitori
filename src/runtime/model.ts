import type {
  JsonObject,
  ModelAssistantMessage,
  ModelContentBlock,
  ModelCompactionBlock,
  ModelDeveloperMessage,
  ModelImageBlock,
  ModelMessage,
  ModelReasoningBlock,
  ModelTextBlock,
  ModelToolCallBlock,
  ModelToolDefinition,
  ModelToolInputFormat,
  ModelToolResultMessage,
  ModelUserMessage,
} from "../kernel/index.ts"

export type {
  ModelCompactionBlock,
  ModelAssistantMessage,
  ModelContentBlock,
  ModelDeveloperMessage,
  ModelImageBlock,
  ModelMessage,
  ModelReasoningBlock,
  ModelTextBlock,
  ModelToolCallBlock,
  ModelToolDefinition,
  ModelToolInputFormat,
  ModelToolResultMessage,
  ModelUserMessage,
}

export const ModelStopReason = {
  EndTurn: "end_turn",
  Length: "length",
  ToolUse: "tool_use",
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

export type ModelRequest = {
  // Request-only control; the resulting native item enters normal history.
  readonly compaction?: "local" | "remote_v2"
  readonly target: ModelTarget
  // Runtime-only fence for opaque provider continuation state. The provider
  // owner adds it immediately before transport serialization; Session target
  // configuration never sets or persists it.
  readonly continuationScope?: string
  readonly cacheKey?: string
  readonly system: readonly ModelSystemSection[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly toolWireProtocol: ToolWireProtocol
  readonly maxOutputTokens?: number
  // Runtime-only physical attempt context. Provider adapters may use it to
  // rebuild transport resources; it is never serialized onto the wire.
  readonly attempt?: Readonly<{
    number: number
    maxAttempts: number
    previousFailure?: ModelFailure
  }>
  readonly signal?: AbortSignal
}

export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_192

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

export type ModelFailureKind =
  | "authentication"
  | "connection_failed"
  | "idle_timeout"
  | "invalid_request"
  | "protocol_error"
  | "provider_error"
  | "rate_limited"
  | "server_error"
  | "stream_disconnected"

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
  readonly message: string
  readonly status?: number
  readonly providerCode?: string
  readonly providerRequestId?: string
  readonly retryAfterMs?: number
  readonly serverShouldRetry?: boolean
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly outputObserved?: boolean
  readonly retryDecision?: "fail" | "retry"
  readonly details?: JsonObject
}>

export type ModelResponse = {
  readonly stopReason: ModelStopReason
  readonly content: readonly ModelContentBlock[]
  readonly usage?: ModelUsage
  readonly providerRequestId?: string
}

export type ModelStreamSnapshotEvent = {
  readonly type: "snapshot"
  readonly text: string
}

export type ModelStreamReasoningSnapshotEvent = {
  readonly type: "reasoning_snapshot"
  readonly text: string
}

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

export type ModelStreamCancelledEvent = {
  readonly type: "cancelled"
}

export type ModelStreamRetryEvent = {
  readonly type: "retry"
  readonly attempt: number
  readonly nextAttempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly failure: ModelFailure
  readonly usage?: ModelUsage
}

export type ModelStreamEvent =
  | ModelStreamSnapshotEvent
  | ModelStreamReasoningSnapshotEvent
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
