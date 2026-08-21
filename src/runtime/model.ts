import type { JsonObject, JsonValue } from "../kernel/index.ts"

export const ModelStopReason = {
  Aborted: "aborted",
  EndTurn: "end_turn",
  Error: "error",
  Length: "length",
  ToolUse: "tool_use",
} as const

export type ModelStopReason =
  (typeof ModelStopReason)[keyof typeof ModelStopReason]

export type ModelTextBlock = {
  readonly type: "text"
  readonly text: string
}

export type ModelImageBlock = {
  readonly type: "image"
  readonly mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
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

export type ModelUserMessage = {
  readonly role: "user"
  readonly content: readonly ModelTextBlock[]
  readonly images?: readonly ModelImageBlock[]
  readonly context?: {
    readonly type: "world_state"
    readonly sectionId: string
    readonly revision: string
  }
}

export type ModelDeveloperMessage = {
  readonly role: "developer"
  readonly content: readonly ModelTextBlock[]
  readonly context?: {
    readonly type: "world_state"
    readonly sectionId: string
    readonly revision: string
  }
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

export type ModelToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

export type ModelTarget = {
  readonly provider: string
  readonly model: string
  readonly promptId: string
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
  readonly signal?: AbortSignal
}

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
