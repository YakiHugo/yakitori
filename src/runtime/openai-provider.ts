import OpenAI from "openai"
import type {
  FunctionTool,
  Response,
  ResponseInput,
} from "openai/resources/responses/responses"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue, type JsonObject } from "../kernel/index.ts"
import { isAbortError } from "./errors.ts"
import {
  flattenModelSystem,
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
  // Compatible endpoints (e.g. xAI at https://api.x.ai/v1) override the default.
  readonly baseURL?: string
  // Extra per-endpoint identity headers (e.g. chatgpt-account-id for the
  // codex ChatGPT backend).
  readonly defaultHeaders?: Record<string, string>
}

export function createOpenAIProvider(options: OpenAIProviderOptions): StreamFn {
  // SDK-internal retries stay disabled: withRetries owns the retry policy.
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      maxRetries: 0,
    })
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
        model: request.target.model || defaultModel,
        instructions: flattenModelSystem(request.system),
        input: toOpenAIInput(request.messages),
        tools: toOpenAITools(request.tools),
        parallel_tool_calls: false,
        max_output_tokens: 8_192,
        store: false,
        stream: true,
        ...(request.cacheKey === undefined
          ? {}
          : { prompt_cache_key: request.cacheKey }),
        ...(request.target.effort === undefined &&
        !REASONING_SUMMARY_PROVIDERS.has(request.target.provider)
          ? {}
          : {
              reasoning: {
                ...(request.target.effort === undefined
                  ? {}
                  : { effort: request.target.effort as ReasoningEffort }),
                ...(REASONING_SUMMARY_PROVIDERS.has(request.target.provider)
                  ? { summary: "auto" as const }
                  : {}),
              },
            }),
        // Speed tiers: only "fast" maps onto the wire ("priority"); anything
        // else falls through to the server default.
        ...(request.target.speed === "fast"
          ? { service_tier: "priority" as const }
          : {}),
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    )
    let text = ""
    let reasoning = ""
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
      if (event.type === "response.reasoning_summary_text.delta") {
        reasoning += event.delta
        yield { type: "reasoning_snapshot", text: reasoning }
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
              ...(event.code !== null && TRANSIENT_ERROR_CODES.has(event.code)
                ? { details: { retryable: true } }
                : {}),
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
    if (message.role === "developer") {
      input.push({
        role: "developer",
        content: message.content.map((block) => block.text).join(""),
      })
      continue
    }
    if (message.role === "user") {
      if ((message.images?.length ?? 0) === 0) {
        input.push({
          role: "user",
          content: message.content.map((block) => block.text).join(""),
        })
        continue
      }
      input.push({
        role: "user",
        content: [
          ...message.content.map((block) => ({
            type: "input_text" as const,
            text: block.text,
          })),
          ...(message.images ?? []).map((block) => ({
            type: "input_image" as const,
            detail: "auto" as const,
            image_url: `data:${block.mediaType};base64,${block.data}`,
          })),
        ],
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
      if (block.type === "reasoning") {
        flushText()
        const reasoning = toOpenAIReasoningItem(block)
        if (reasoning !== undefined) input.push(reasoning)
        continue
      }
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
    const code = response.error?.code ?? "openai_error"
    return responseError(
      response,
      code,
      response.error?.message ?? "OpenAI response failed.",
      TRANSIENT_ERROR_CODES.has(code) ? { retryable: true } : undefined,
    )
  }

  const content: ModelContentBlock[] = []
  for (const item of response.output) {
    if (item.type === "reasoning") {
      const text = item.summary.map((summary) => summary.text).join("\n\n")
      content.push({
        type: "reasoning",
        text,
        providerMetadata: {
          openai: {
            id: item.id,
            ...(item.encrypted_content === undefined
              ? {}
              : { encryptedContent: item.encrypted_content }),
            ...(item.status === undefined ? {} : { status: item.status }),
          },
        },
      })
      continue
    }
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

function toOpenAIReasoningItem(
  block: Extract<ModelContentBlock, { readonly type: "reasoning" }>,
): ResponseInput[number] | undefined {
  const metadata = block.providerMetadata?.openai
  if (!isJsonObject(metadata) || typeof metadata.id !== "string") {
    return undefined
  }
  const encryptedContent = metadata.encryptedContent
  const status = metadata.status
  return {
    type: "reasoning",
    id: metadata.id,
    summary:
      block.text.length === 0
        ? []
        : [{ type: "summary_text", text: block.text }],
    ...(typeof encryptedContent === "string"
      ? { encrypted_content: encryptedContent }
      : {}),
    ...(status === "in_progress" ||
    status === "completed" ||
    status === "incomplete"
      ? { status }
      : {}),
  }
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
            ...((response.usage.input_tokens_details?.cached_tokens ?? 0) === 0
              ? {}
              : {
                  cacheReadInputTokens:
                    response.usage.input_tokens_details.cached_tokens,
                }),
            ...((response.usage.input_tokens_details?.cache_write_tokens ??
              0) === 0
              ? {}
              : {
                  cacheWriteInputTokens:
                    response.usage.input_tokens_details.cache_write_tokens,
                }),
          },
        }),
    providerRequestId: response.id,
  }
}

function responseError(
  response: Response,
  code: string,
  message: string,
  details?: JsonObject,
): ModelResponse {
  return {
    ...responseResult(response, ModelStopReason.Error, []),
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
}

function terminalError(error: unknown): ModelResponse {
  const details = retryableDetails(error)
  return {
    stopReason: ModelStopReason.Error,
    content: [],
    error: {
      code: "openai_error",
      message:
        error instanceof Error ? error.message : "OpenAI request failed.",
      ...(details === undefined ? {} : { details }),
    },
  }
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 429, 500, 502, 503, 504, 529,
])

// Stream error events and failed responses carry no HTTP status; these error
// codes are the transient ones worth retrying.
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "server_error",
  "rate_limit_exceeded",
])

const REASONING_SUMMARY_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "codex",
])

// Transient failures carry retryable details for withRetries: retryable HTTP
// statuses, plus connection/timeout errors (APIConnectionTimeoutError extends
// APIConnectionError; both have no HTTP status).
function retryableDetails(error: unknown): JsonObject | undefined {
  if (error instanceof OpenAI.APIConnectionError) {
    return { retryable: true }
  }
  if (
    error instanceof OpenAI.APIError &&
    typeof error.status === "number" &&
    RETRYABLE_STATUSES.has(error.status)
  ) {
    return { retryable: true, status: error.status }
  }
  return undefined
}

function abortedResponse(): ModelStreamEvent {
  return {
    type: "response",
    response: { stopReason: ModelStopReason.Aborted, content: [] },
  }
}
