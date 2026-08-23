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

export type ModelToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

export type ModelTarget = {
  readonly provider: string
  readonly model: string
  readonly instructionProfileId: string
  readonly effort?: string
  readonly speed?: string
}

export type ModelSystemSection = {
  readonly id: string
  readonly revision: string
  readonly text: string
}

export type ModelRequest = {
  readonly target: ModelTarget
  readonly cacheKey?: string
  readonly system: readonly ModelSystemSection[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
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
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
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
