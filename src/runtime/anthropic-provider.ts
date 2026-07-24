import Anthropic from "@anthropic-ai/sdk"
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages"
import type { JsonValue } from "../kernel/index.ts"
import {
  ModelStopReason,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type StreamFn,
} from "./model.ts"

export type AnthropicProviderOptions = {
  readonly apiKey: string
  readonly model: string
  readonly client?: Anthropic
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): StreamFn {
  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
    })

  return (request) => streamAnthropic(client, options.model, request)
}

async function* streamAnthropic(
  client: Anthropic,
  defaultModel: string,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield {
      type: "response",
      response: { stopReason: ModelStopReason.Aborted, content: [] },
    }
    return
  }

  let stream: Awaited<ReturnType<typeof client.messages.stream>>
  try {
    const tools = toAnthropicTools(request.tools)
    stream = client.messages.stream(
      {
        model: request.model || defaultModel,
        max_tokens: 8_192,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...(tools === undefined ? {} : { tools }),
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    )
  } catch (error) {
    yield {
      type: "response",
      response: terminalError(error),
    }
    return
  }

  let text = ""
  try {
    for await (const event of stream) {
      if (request.signal?.aborted) {
        yield {
          type: "response",
          response: { stopReason: ModelStopReason.Aborted, content: [] },
        }
        return
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text
        yield { type: "snapshot", text }
      }
    }

    const final = await stream.finalMessage()
    yield {
      type: "response",
      response: fromAnthropicMessage(final),
    }
  } catch (error) {
    if (request.signal?.aborted || isAbortError(error)) {
      yield {
        type: "response",
        response: { stopReason: ModelStopReason.Aborted, content: [] },
      }
      return
    }
    yield {
      type: "response",
      response: terminalError(error),
    }
  }
}

export function toAnthropicMessages(
  messages: readonly ModelMessage[],
): MessageParam[] {
  const converted: MessageParam[] = []
  for (const message of messages) {
    if (message.role === "user") {
      converted.push({
        role: "user",
        content: message.content.map((block) => ({
          type: "text",
          text: block.text,
        })),
      })
      continue
    }
    if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: message.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text }
          }
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input:
              typeof block.input === "object" && block.input !== null
                ? block.input
                : {},
          }
        }),
      })
      continue
    }

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      ...(message.isError ? { is_error: true } : {}),
    }
    const last = converted.at(-1)
    if (last?.role === "user" && Array.isArray(last.content)) {
      converted[converted.length - 1] = {
        role: "user",
        content: [...last.content, toolResult],
      }
    } else {
      converted.push({
        role: "user",
        content: [toolResult],
      })
    }
  }
  return converted
}

export function toAnthropicTools(
  tools: ModelRequest["tools"],
): Tool[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool["input_schema"],
  }))
}

export function fromAnthropicMessage(message: {
  readonly content: readonly unknown[]
  readonly stop_reason: string | null
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
  }
  readonly id?: string
}): ModelResponse {
  const content: ModelContentBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text })
      continue
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: (isJsonValue(block.input) ? block.input : {}) as JsonValue,
      })
    }
  }

  const stopReason = mapStopReason(message.stop_reason, content)
  return {
    stopReason,
    content,
    ...(message.usage === undefined
      ? {}
      : {
          usage: {
            ...(message.usage.input_tokens === undefined
              ? {}
              : { inputTokens: message.usage.input_tokens }),
            ...(message.usage.output_tokens === undefined
              ? {}
              : { outputTokens: message.usage.output_tokens }),
          },
        }),
    ...(message.id === undefined ? {} : { providerRequestId: message.id }),
  }
}

function mapStopReason(
  stopReason: string | null,
  content: ModelResponse["content"],
): ModelResponse["stopReason"] {
  if (stopReason === "max_tokens") return ModelStopReason.Length
  if (stopReason === "tool_use") return ModelStopReason.ToolUse
  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    return content.some((block) => block.type === "tool_call")
      ? ModelStopReason.ToolUse
      : ModelStopReason.EndTurn
  }
  if (stopReason === null) return ModelStopReason.EndTurn
  return ModelStopReason.Error
}

function terminalError(error: unknown): ModelResponse {
  return {
    stopReason: ModelStopReason.Error,
    content: [],
    error: {
      code: "anthropic_error",
      message:
        error instanceof Error ? error.message : "Anthropic request failed.",
    },
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue)
  }
  return false
}
