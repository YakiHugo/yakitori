import OpenAI from "openai"
import type {
  Tool as OpenAITool,
  Response,
  ResponseInput,
} from "openai/resources/responses/responses"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue, type JsonObject } from "../kernel/index.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import { isAbortError } from "./errors.ts"
import { parseRetryAfterMs } from "./retry-after.ts"
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  requireModelImageData,
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
    const nativeDeferredLoading =
      nativeDeferredToolProtocol(request) === "openai"
    const customFallbackKeys = customFallbackKeysForRequest(
      request,
      nativeDeferredLoading,
    )
    const stream = await client.responses.create(
      {
        model: request.target.model || defaultModel,
        instructions: flattenModelSystem(request.system),
        input: toOpenAIInput(
          request.messages,
          nativeDeferredLoading,
          request.target.provider,
          request.continuationScope,
        ),
        tools: toOpenAITools(request.tools, nativeDeferredLoading),
        parallel_tool_calls: true,
        max_output_tokens:
          request.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
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
        yield {
          type: "response",
          response: fromOpenAIResponse(
            event.response,
            customFallbackKeys,
            request.target.provider,
            request.continuationScope,
          ),
        }
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

function customFallbackKeysForRequest(
  request: ModelRequest,
  nativeDeferredLoading: boolean,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const tool of request.tools) {
    if (
      tool.kind === "custom" &&
      tool.customInputFallbackKey !== undefined &&
      (!nativeDeferredLoading || tool.deferLoading !== true)
    ) {
      result.set(tool.name, tool.customInputFallbackKey)
    }
  }
  if (!nativeDeferredLoading) return result

  // Responses can call a custom tool loaded by an earlier tool_search_output
  // even after the live catalog changes. Interpret that call using the exact
  // historical definition that granted the capability on the wire.
  for (const message of request.messages) {
    if (message.role !== "tool" || message.toolSearch === undefined) continue
    for (const tool of message.toolSearch.tools) {
      if (tool.kind === "custom" && tool.customInputFallbackKey !== undefined) {
        result.set(tool.name, tool.customInputFallbackKey)
      }
    }
  }
  return result
}

export function toOpenAIInput(
  messages: readonly ModelMessage[],
  nativeDeferredLoading = true,
  provider = "openai",
  continuationScope?: string,
): ResponseInput {
  const input: ResponseInput = []
  const customCallIds = new Set<string>()
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
            detail: block.detail ?? "high",
            image_url: `data:${block.mediaType};base64,${requireModelImageData(block)}`,
          })),
        ],
      })
      continue
    }
    if (message.role === "tool") {
      if (nativeDeferredLoading && message.toolSearch !== undefined) {
        input.push({
          type: "tool_search_output",
          call_id: message.toolCallId,
          execution: "client",
          status: "completed",
          tools: message.toolSearch.tools.flatMap((tool) =>
            toOpenAITool(tool, true),
          ),
        })
        continue
      }
      const output = message.isError
        ? `[tool_error]\n${message.content}`
        : message.content
      input.push(
        customCallIds.has(message.toolCallId)
          ? {
              type: "custom_tool_call_output",
              call_id: message.toolCallId,
              output,
            }
          : {
              type: "function_call_output",
              call_id: message.toolCallId,
              output,
            },
      )
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
        const reasoning = toOpenAIReasoningItem(
          block,
          provider,
          continuationScope,
        )
        if (reasoning !== undefined) input.push(reasoning)
        continue
      }
      if (block.type === "text") {
        text += block.text
        continue
      }
      flushText()
      if (block.toolKind === "tool_search" && nativeDeferredLoading) {
        input.push({
          type: "tool_search_call",
          call_id: block.id,
          execution: "client",
          status: "completed",
          arguments: block.input,
        })
        continue
      }
      if (block.toolKind === "custom") {
        customCallIds.add(block.id)
        input.push({
          type: "custom_tool_call",
          call_id: block.id,
          name: block.name,
          input: customToolInput(block.input),
        })
        continue
      }
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

export function toOpenAITools(
  tools: ModelRequest["tools"],
  nativeDeferredLoading = true,
): OpenAITool[] {
  return tools.flatMap((tool) => {
    if (nativeDeferredLoading && tool.deferLoading === true) return []
    if (nativeDeferredLoading && tool.kind === "tool_search") {
      return [
        {
          type: "tool_search" as const,
          execution: "client" as const,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      ]
    }
    return toOpenAITool(tool, false)
  })
}

function toOpenAITool(
  tool: ModelRequest["tools"][number],
  deferLoading: boolean,
): OpenAITool[] {
  if (tool.kind === "custom") {
    return [
      {
        type: "custom",
        name: tool.name,
        description: tool.description,
        ...(tool.inputFormat === undefined ? {} : { format: tool.inputFormat }),
        ...(deferLoading ? { defer_loading: true } : {}),
      },
    ]
  }
  return [
    {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
      ...(deferLoading ? { defer_loading: true } : {}),
    },
  ]
}

export function fromOpenAIResponse(
  response: Response,
  customFallbackKeys: ReadonlyMap<string, string> = new Map(),
  provider = "openai",
  continuationScope?: string,
): ModelResponse {
  if (response.status === "cancelled") {
    return { stopReason: ModelStopReason.Aborted, content: [] }
  }
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") {
      return responseResult(response, ModelStopReason.Length, [], provider)
    }
    return responseError(
      response,
      "openai_incomplete",
      `OpenAI response was incomplete: ${response.incomplete_details?.reason ?? "unknown"}.`,
      undefined,
      provider,
    )
  }
  if (response.status === "failed" || response.error) {
    const code = response.error?.code ?? "openai_error"
    return responseError(
      response,
      code,
      response.error?.message ?? "OpenAI response failed.",
      TRANSIENT_ERROR_CODES.has(code) ? { retryable: true } : undefined,
      provider,
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
            provider,
            ...(continuationScope === undefined
              ? {}
              : { scope: continuationScope }),
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
          return responseError(
            response,
            "openai_refusal",
            part.refusal,
            undefined,
            provider,
          )
        }
      }
      continue
    }
    if (item.type === "custom_tool_call") {
      const customInputFallbackKey = customFallbackKeys.get(item.name)
      content.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        input: item.input,
        toolKind: "custom",
        ...(customInputFallbackKey === undefined
          ? {}
          : { customInputFallbackKey }),
      })
      continue
    }
    if (item.type === "tool_search_call") {
      if (
        item.execution !== "client" ||
        item.call_id === null ||
        !isJsonValue(item.arguments)
      ) {
        continue
      }
      content.push({
        type: "tool_call",
        id: item.call_id,
        name: "tool_search",
        input: item.arguments,
        toolKind: "tool_search",
      })
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
        undefined,
        provider,
      )
    }
    if (!isJsonValue(parsed)) {
      return responseError(
        response,
        "openai_invalid_tool_arguments",
        `OpenAI returned non-JSON arguments for tool ${item.name}.`,
        undefined,
        provider,
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
    provider,
  )
}

function customToolInput(
  input: import("../kernel/index.ts").JsonValue,
): string {
  if (typeof input === "string") return input
  return JSON.stringify(input)
}

function toOpenAIReasoningItem(
  block: Extract<ModelContentBlock, { readonly type: "reasoning" }>,
  provider: string,
  continuationScope?: string,
): ResponseInput[number] | undefined {
  const metadata = block.providerMetadata?.openai
  if (!isJsonObject(metadata) || typeof metadata.id !== "string") {
    return undefined
  }
  if (
    metadata.provider !== provider &&
    !(metadata.provider === undefined && provider === "openai")
  ) {
    return undefined
  }
  if (metadata.scope !== continuationScope) return undefined
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
  provider = "openai",
): ModelResponse {
  return {
    stopReason,
    content,
    ...(response.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: response.usage.input_tokens,
            activeContextTokens: activeContextTokens(response.usage, provider),
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
  provider = "openai",
): ModelResponse {
  return {
    ...responseResult(response, ModelStopReason.Error, [], provider),
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
}

function activeContextTokens(
  usage: NonNullable<Response["usage"]>,
  provider: string,
): number {
  if (provider === "grok") {
    const contextDetails = (usage as unknown as Record<string, unknown>)
      .context_details
    if (isJsonObject(contextDetails)) {
      const inputTokens = contextDetails.input_tokens
      const outputTokens = contextDetails.output_tokens
      if (typeof inputTokens === "number" && typeof outputTokens === "number") {
        return inputTokens + outputTokens
      }
    }
  }
  return usage.total_tokens
}

function terminalError(error: unknown): ModelResponse {
  const details = providerErrorDetails(error)
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

function providerErrorDetails(error: unknown): JsonObject | undefined {
  const retryable = retryableDetails(error)
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    if (retryable !== undefined || error.status === 401) {
      const retryAfterMs = parseRetryAfterMs(error.headers)
      return {
        ...(retryable ?? {}),
        status: error.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    }
  }
  return retryable
}

function abortedResponse(): ModelStreamEvent {
  return {
    type: "response",
    response: { stopReason: ModelStopReason.Aborted, content: [] },
  }
}
