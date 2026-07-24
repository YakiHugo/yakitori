import OpenAI from "openai"
import type {
  FunctionTool,
  Response,
  ResponseInput,
} from "openai/resources/responses/responses"
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

export type OpenAIProviderOptions = {
  readonly apiKey: string
  readonly model: string
  readonly client?: OpenAI
}

export function createOpenAIProvider(options: OpenAIProviderOptions): StreamFn {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey })
  return (request) => streamOpenAI(client, options.model, request)
}

async function* streamOpenAI(
  client: OpenAI,
  defaultModel: string,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield abortedResponse()
    return
  }

  try {
    const stream = await client.responses.create(
      {
        model: request.model || defaultModel,
        instructions: request.system,
        input: toOpenAIInput(request.messages),
        tools: toOpenAITools(request.tools),
        parallel_tool_calls: false,
        max_output_tokens: 8_192,
        store: false,
        stream: true,
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    )
    let text = ""
    for await (const event of stream) {
      if (request.signal?.aborted) {
        yield abortedResponse()
        return
      }
      if (event.type === "response.output_text.delta") {
        text += event.delta
        yield { type: "snapshot", text }
        continue
      }
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        yield { type: "response", response: fromOpenAIResponse(event.response) }
        return
      }
      if (event.type === "error") {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.Error,
            content: [],
            error: {
              code: event.code ?? "openai_error",
              message: event.message,
            },
          },
        }
        return
      }
    }
  } catch (error) {
    if (request.signal?.aborted || isAbortError(error)) {
      yield abortedResponse()
      return
    }
    yield {
      type: "response",
      response: terminalError(error),
    }
  }
}

export function toOpenAIInput(
  messages: readonly ModelMessage[],
): ResponseInput {
  const input: ResponseInput = []
  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content.map((block) => block.text).join(""),
      })
      continue
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.isError
          ? `[tool_error]\n${message.content}`
          : message.content,
      })
      continue
    }

    let text = ""
    const flushText = () => {
      if (text.length === 0) return
      input.push({ role: "assistant", content: text })
      text = ""
    }
    for (const block of message.content) {
      if (block.type === "text") {
        text += block.text
        continue
      }
      flushText()
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      })
    }
    flushText()
  }
  return input
}

export function toOpenAITools(tools: ModelRequest["tools"]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }))
}

export function fromOpenAIResponse(response: Response): ModelResponse {
  if (response.status === "cancelled") {
    return { stopReason: ModelStopReason.Aborted, content: [] }
  }
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") {
      return responseResult(response, ModelStopReason.Length, [])
    }
    return responseError(
      response,
      "openai_incomplete",
      `OpenAI response was incomplete: ${response.incomplete_details?.reason ?? "unknown"}.`,
    )
  }
  if (response.status === "failed" || response.error) {
    return responseError(
      response,
      response.error?.code ?? "openai_error",
      response.error?.message ?? "OpenAI response failed.",
    )
  }

  const content: ModelContentBlock[] = []
  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text })
          continue
        }
        if (part.type === "refusal") {
          return responseError(response, "openai_refusal", part.refusal)
        }
      }
      continue
    }
    if (item.type !== "function_call") continue

    let parsed: unknown
    try {
      parsed = JSON.parse(item.arguments)
    } catch {
      return responseError(
        response,
        "openai_invalid_tool_arguments",
        `OpenAI returned invalid JSON arguments for tool ${item.name}.`,
      )
    }
    if (!isJsonValue(parsed)) {
      return responseError(
        response,
        "openai_invalid_tool_arguments",
        `OpenAI returned non-JSON arguments for tool ${item.name}.`,
      )
    }
    content.push({
      type: "tool_call",
      id: item.call_id,
      name: item.name,
      input: parsed,
    })
  }

  return responseResult(
    response,
    content.some((block) => block.type === "tool_call")
      ? ModelStopReason.ToolUse
      : ModelStopReason.EndTurn,
    content,
  )
}

function responseResult(
  response: Response,
  stopReason: ModelResponse["stopReason"],
  content: readonly ModelContentBlock[],
): ModelResponse {
  return {
    stopReason,
    content,
    ...(response.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        }),
    providerRequestId: response.id,
  }
}

function responseError(
  response: Response,
  code: string,
  message: string,
): ModelResponse {
  return {
    ...responseResult(response, ModelStopReason.Error, []),
    error: { code, message },
  }
}

function terminalError(error: unknown): ModelResponse {
  return {
    stopReason: ModelStopReason.Error,
    content: [],
    error: {
      code: "openai_error",
      message:
        error instanceof Error ? error.message : "OpenAI request failed.",
    },
  }
}

function abortedResponse(): ModelStreamEvent {
  return {
    type: "response",
    response: { stopReason: ModelStopReason.Aborted, content: [] },
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === "object") return Object.values(value).every(isJsonValue)
  return false
}
