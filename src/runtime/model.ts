import type {
  JsonObject,
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
} from "../kernel/index.ts"

export type {
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
  Aborted: "aborted",
  EndTurn: "end_turn",
  Error: "error",
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
  readonly signal?: AbortSignal
}

export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_192

export function flattenModelSystem(
  sections: readonly ModelSystemSection[],
): string {
  return sections.map((section) => section.text).join("\n\n")
}

export type ModelUsage = {
  // Billing counters accumulate across physical requests.
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  // Provider-reported size of the model-visible prefix for this response.
  // Unlike billing counters, callers keep the latest value rather than sum it.
  readonly activeContextTokens?: number
}

export type ModelError = {
  readonly code: string
  readonly message: string
  readonly details?: JsonObject
}

export type ModelResponse = {
  readonly stopReason: ModelStopReason
  readonly content: readonly ModelContentBlock[]
  readonly usage?: ModelUsage
  readonly error?: ModelError
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

export type ModelStreamEvent =
  | ModelStreamSnapshotEvent
  | ModelStreamReasoningSnapshotEvent
  | ModelStreamResponseEvent

export type StreamFn = (
  request: ModelRequest,
) => AsyncIterable<ModelStreamEvent>

export function requireModelImageData(image: ModelImageBlock): string {
  if ("data" in image && image.data !== undefined) return image.data
  throw new Error("Model request contains an unresolved Session image.")
}
