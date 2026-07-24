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

export type ModelToolCallBlock = {
  readonly type: "tool_call"
  readonly id: string
  readonly name: string
  readonly input: JsonValue
}

export type ModelContentBlock = ModelTextBlock | ModelToolCallBlock

export type ModelUserMessage = {
  readonly role: "user"
  readonly content: readonly ModelTextBlock[]
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
  | ModelAssistantMessage
  | ModelToolResultMessage

export type ModelToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

export type ModelRequest = {
  readonly system: string
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly provider: string
  readonly model: string
  readonly signal?: AbortSignal
  readonly metadata?: JsonObject
}

export type ModelUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
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
  readonly metadata?: JsonObject
}

export type ModelStreamSnapshotEvent = {
  readonly type: "snapshot"
  readonly text: string
}

export type ModelStreamResponseEvent = {
  readonly type: "response"
  readonly response: ModelResponse
}

export type ModelStreamEvent =
  | ModelStreamSnapshotEvent
  | ModelStreamResponseEvent

export type StreamFn = (
  request: ModelRequest,
) => AsyncIterable<ModelStreamEvent>
