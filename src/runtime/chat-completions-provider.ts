import OpenAI from "openai"
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue, type JsonObject } from "../kernel/index.ts"
import {
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelToolCallBlock,
  type ModelUsage,
  requireModelImageData,
  type StreamFn,
} from "./model.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"

export type ChatCompletionsProviderOptions = Readonly<{
  apiKey: string
  model: string
  baseURL: string
  defaultHeaders?: Record<string, string>
  flavor?: "generic" | "deepseek" | "gemini" | "qwen" | "mistral"
}>

type Flavor = NonNullable<ChatCompletionsProviderOptions["flavor"]>
type ToolCall = ChatCompletionMessageToolCall & {
  extra_content?: { google: { thought_signature: string } }
}
type AssistantMessage = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string
}
type PendingToolCall = {
  id: string
  name: string
  arguments: string
  thoughtSignature?: string
}

export function createChatCompletionsProvider(
  options: ChatCompletionsProviderOptions,
): StreamFn {
  // The runtime owns retries and attempt budgets for every wire protocol.
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.defaultHeaders,
    maxRetries: 0,
  })
  return (request) => streamChatCompletions(client, options, request)
}

async function* streamChatCompletions(
  client: OpenAI,
  options: ChatCompletionsProviderOptions,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield { type: "cancelled" }
    return
  }
  let stage: "request_build" | "connect" | "response_body" = "request_build"
  let usage: ModelUsage | undefined
  const usageFields = () => (usage === undefined ? {} : { usage })
  let providerRequestId: string | undefined
  try {
    if (request.compaction === "remote_v2")
      throw new ChatCompletionsProtocolError(
        "Chat Completions does not support native remote compaction.",
      )
    const messages = toChatCompletionsMessages(
      request.messages,
      request.target.provider,
      request.continuationScope,
      options.flavor ?? "generic",
    )
    const system = flattenModelSystem(request.system)
    if (system.length > 0) messages.unshift({ role: "system", content: system })
    const customFallbackKeys = new Map(
      request.tools.flatMap((tool) => {
        if (tool.kind !== "custom") return []
        if (tool.customInputFallbackKey === undefined)
          throw new ChatCompletionsProtocolError(
            `Custom tool ${tool.name} requires a JSON input fallback.`,
          )
        return [[tool.name, tool.customInputFallbackKey] as const]
      }),
    )
    stage = "connect"
    const { data: stream, response } = await client.chat.completions
      .create(
        {
          model: request.target.model || options.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(request.maxOutputTokens === undefined
            ? {}
            : { max_tokens: request.maxOutputTokens }),
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
                tool_choice: "auto" as const,
              }),
          // The configured model owns its supported effort values. Omit the
          // field entirely when that model has no explicit effort selection.
          ...(request.target.effort === undefined
            ? {}
            : { reasoning_effort: request.target.effort as ReasoningEffort }),
        },
        request.signal === undefined ? undefined : { signal: request.signal },
      )
      .withResponse()
    providerRequestId = response.headers.get("x-request-id") ?? undefined
    stage = "response_body"
    let completionId: string | undefined
    let text = ""
    let reasoning = ""
    const annotations: import("../kernel/index.ts").JsonValue[] = []
    let finishReason: string | undefined
    const calls = new Map<number, PendingToolCall>()
    for await (const chunk of stream) {
      if (request.signal?.aborted) {
        yield { type: "cancelled", ...usageFields() }
        return
      }
      if (!Array.isArray(chunk.choices))
        throw new ChatCompletionsProtocolError("Missing completion choices.")
      if (typeof chunk.id === "string" && chunk.id.length > 0) {
        if (completionId !== undefined && completionId !== chunk.id)
          throw new ChatCompletionsProtocolError(
            "Completion ID changed mid-stream.",
          )
        completionId = chunk.id
      }
      if (chunk.usage != null) {
        usage = fromChatUsage(chunk.usage)
        request.onUsageSnapshot?.(usage)
      }
      for (const choice of chunk.choices) {
        if (choice.index !== 0 || finishReason !== undefined)
          throw new ChatCompletionsProtocolError(
            "Unexpected completion choice.",
          )
        const delta = choice.delta
        if (!isJsonObject(delta))
          throw new ChatCompletionsProtocolError("Invalid completion delta.")
        for (const field of ["audio", "images", "video", "function_call"]) {
          if (delta[field] != null)
            throw new ChatCompletionsProtocolError(
              `Unsupported completion output: ${field}.`,
            )
        }
        if (delta.annotations != null) {
          if (
            !Array.isArray(delta.annotations) ||
            !delta.annotations.every(isJsonValue)
          )
            throw new ChatCompletionsProtocolError(
              "Invalid completion annotations.",
            )
          annotations.push(...delta.annotations)
        }
        for (const [field, type] of [
          ["content", "delta"],
          ["reasoning_content", "reasoning_delta"],
          ["refusal", "delta"],
        ] as const) {
          const fragment = delta[field]
          if (fragment === undefined || fragment === null) continue
          if (typeof fragment !== "string")
            throw new ChatCompletionsProtocolError(`Invalid ${field} delta.`)
          if (type === "reasoning_delta") reasoning += fragment
          else text += fragment
          if (fragment.length > 0)
            yield {
              type,
              text: fragment,
              ...(request.streamOutputItems && completionId !== undefined
                ? {
                    itemId: `${completionId}_0${type === "reasoning_delta" ? "_reasoning" : ""}`,
                  }
                : {}),
            }
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls))
            throw new ChatCompletionsProtocolError("Invalid tool call deltas.")
          for (const tool of delta.tool_calls) {
            if (
              !isJsonObject(tool) ||
              typeof tool.index !== "number" ||
              !Number.isInteger(tool.index) ||
              tool.index < 0 ||
              (tool.type !== undefined && tool.type !== "function")
            )
              throw new ChatCompletionsProtocolError(
                "Invalid function call delta.",
              )
            const call = calls.get(tool.index) ?? {
              id: "",
              name: "",
              arguments: "",
            }
            if (tool.id !== undefined) {
              if (
                typeof tool.id !== "string" ||
                (call.id !== "" && call.id !== tool.id)
              )
                throw new ChatCompletionsProtocolError(
                  "Invalid function call ID.",
                )
              call.id = tool.id
            }
            if (tool.function !== undefined) {
              if (!isJsonObject(tool.function))
                throw new ChatCompletionsProtocolError("Invalid function call.")
              if (tool.function.name !== undefined) {
                if (typeof tool.function.name !== "string")
                  throw new ChatCompletionsProtocolError(
                    "Invalid function name.",
                  )
                call.name = tool.function.name
              }
              if (tool.function.arguments !== undefined) {
                if (typeof tool.function.arguments !== "string")
                  throw new ChatCompletionsProtocolError(
                    "Invalid function arguments.",
                  )
                call.arguments += tool.function.arguments
              }
            }
            if (options.flavor === "gemini") {
              const signature = geminiThoughtSignature(tool)
              if (signature !== undefined) call.thoughtSignature = signature
            }
            calls.set(tool.index, call)
          }
        }
        if (choice.finish_reason != null) finishReason = choice.finish_reason
      }
    }
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...usageFields() }
      return
    }
    if (finishReason === undefined)
      throw new ChatCompletionsIncompleteStreamError(
        "Completion ended without a finish reason.",
      )
    if (
      !["stop", "length", "tool_calls", "content_filter"].includes(finishReason)
    )
      throw new ChatCompletionsProtocolError(
        "Invalid completion finish reason.",
      )
    const content: ModelContentBlock[] = []
    if (reasoning.length > 0)
      content.push({
        type: "reasoning",
        text: reasoning,
        providerMetadata: {
          chatCompletions: continuationMetadata(request, {
            reasoningContent: true,
          }),
        },
      })
    if (text.length > 0 || annotations.length > 0)
      content.push({
        type: "text",
        text,
        ...(annotations.length === 0
          ? {}
          : {
              providerMetadata: {
                chatCompletions: continuationMetadata(request, { annotations }),
              },
            }),
      })
    let incompleteToolCalls = false
    const ids = new Set<string>()
    for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
      if (
        finishReason === "content_filter" ||
        (finishReason === "length" &&
          (call.id.length === 0 || call.name.length === 0))
      ) {
        incompleteToolCalls = true
        continue
      }
      if (call.id.length === 0 || call.name.length === 0 || ids.has(call.id))
        throw new ChatCompletionsProtocolError(
          "Missing or duplicate function call identity.",
        )
      ids.add(call.id)
      let input: unknown
      try {
        input = JSON.parse(call.arguments)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        if (finishReason !== "length")
          throw new ChatCompletionsProtocolError(
            "Invalid JSON function arguments.",
            { cause: error },
          )
        incompleteToolCalls = true
        continue
      }
      if (!isJsonValue(input))
        throw new ChatCompletionsProtocolError("Invalid function input.")
      const fallbackKey = customFallbackKeys.get(call.name)
      if (fallbackKey !== undefined) {
        if (!isJsonObject(input) || typeof input[fallbackKey] !== "string")
          throw new ChatCompletionsProtocolError(
            "Custom function input is missing its fallback field.",
          )
        input = input[fallbackKey]
      }
      if (!isJsonValue(input))
        throw new ChatCompletionsProtocolError("Invalid function input.")
      content.push({
        type: "tool_call",
        id: call.id,
        name: call.name,
        input,
        ...(fallbackKey === undefined
          ? {}
          : { toolKind: "custom", customInputFallbackKey: fallbackKey }),
        ...(call.thoughtSignature === undefined
          ? {}
          : {
              providerMetadata: {
                chatCompletions: continuationMetadata(request, {
                  thoughtSignature: call.thoughtSignature,
                }),
              },
            }),
      })
    }
    const hasCalls = content.some((block) => block.type === "tool_call")
    // The Turn processor counts Length alongside completed calls to bound
    // truncated tool loops; preserve it rather than masking it with ToolUse.
    const stopReason =
      finishReason === "length"
        ? ModelStopReason.Length
        : finishReason === "content_filter"
          ? ModelStopReason.ContentFilter
          : hasCalls
            ? ModelStopReason.ToolUse
            : ModelStopReason.EndTurn
    if (finishReason === "tool_calls" && !hasCalls)
      throw new ChatCompletionsProtocolError(
        "Invalid completion finish reason.",
      )
    if (request.streamOutputItems && content.length > 0)
      yield {
        type: "output_item",
        itemId: `${completionId ?? "completion"}_0`,
        content,
      }
    const requestId = providerRequestId ?? completionId
    yield {
      type: "response",
      response: {
        stopReason,
        rawStopReason: finishReason,
        content,
        ...(finishReason === "length" ? { lengthReason: "output" } : {}),
        ...(incompleteToolCalls ? { incompleteToolCalls: true } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      },
    }
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...usageFields() }
      return
    }
    const apiError = error instanceof OpenAI.APIError ? error : undefined
    const requestId = apiError?.requestID ?? providerRequestId
    const retryAfterMs =
      apiError === undefined ? undefined : parseRetryAfterMs(apiError.headers)
    const serverShouldRetry =
      apiError === undefined ? undefined : parseShouldRetry(apiError.headers)
    yield {
      type: "failure",
      failure: modelFailureFromUnknown(error, {
        provider: request.target.provider,
        wireApi: "openai_chat_completions",
        stage: error instanceof SyntaxError ? "sse_decode" : stage,
        fallbackMessage: "Chat Completions request failed.",
        ...(error instanceof ChatCompletionsProtocolError ||
        error instanceof SyntaxError
          ? { kind: "protocol_error" }
          : error instanceof ChatCompletionsIncompleteStreamError
            ? { kind: "stream_disconnected" }
            : error instanceof OpenAI.APIConnectionError
              ? {
                  kind:
                    stage === "connect"
                      ? "connection_failed"
                      : "stream_disconnected",
                }
              : apiError?.status === undefined
                ? {}
                : { kind: failureKindForStatus(apiError.status) }),
        ...(apiError?.status === undefined ? {} : { status: apiError.status }),
        ...(typeof apiError?.code === "string"
          ? { providerCode: apiError.code }
          : {}),
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(serverShouldRetry === undefined ? {} : { serverShouldRetry }),
      }),
      ...(usage === undefined ? {} : { usage }),
      cause: error,
    }
  }
}

export function toChatCompletionsMessages(
  messages: readonly ModelMessage[],
  provider: string,
  continuationScope?: string,
  flavor: Flavor = "generic",
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []
  let toolMedia: ChatCompletionContentPart[] = []
  for (const message of messages) {
    // Chat only accepts image and file parts on user messages. Keep this out of
    // durable history and after ALL adjacent results, never between a call and
    // its results (including parallel tools).
    if (message.role !== "tool" && toolMedia.length > 0) {
      result.push({ role: "user", content: toolMedia })
      toolMedia = []
    }
    if (message.role === "developer") {
      result.push({
        role: "system",
        content: message.content.map((block) => block.text).join(""),
      })
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: message.content.every((block) => block.type === "text")
          ? message.content.map((block) => block.text).join("")
          : message.content.map((block) =>
              block.type === "text"
                ? { type: "text" as const, text: block.text }
                : {
                    type: "image_url" as const,
                    image_url: {
                      url: `data:${block.mediaType};base64,${requireModelImageData(block)}`,
                      detail: "high" as const,
                    },
                  },
            ),
      })
    } else if (message.role === "tool") {
      const text = message.content
        .map((block, index) => {
          if (block.type === "text") return block.text
          if (block.type === "document") {
            // Request preparation owns endpoint/model PDF capability admission.
            if (block.data === undefined)
              throw new ChatCompletionsProtocolError(
                "Model request contains an unresolved Session PDF.",
              )
            const label = `PDF from tool result ${JSON.stringify(message.toolCallId)}, content part ${index + 1}`
            toolMedia.push(
              { type: "text", text: `${label}:` },
              {
                type: "file",
                file: {
                  filename: block.name,
                  file_data: `data:application/pdf;base64,${block.data}`,
                },
              },
            )
            return `[${label}; PDF follows the tool-result batch.]`
          }
          const label = `Image from tool result ${JSON.stringify(message.toolCallId)}, content part ${index + 1}`
          toolMedia.push(
            { type: "text", text: `${label}:` },
            {
              type: "image_url",
              image_url: {
                url: `data:${block.mediaType};base64,${requireModelImageData(block)}`,
                detail: "high",
              },
            },
          )
          // Keep tool text in the tool role. The marker binds this position to the
          // labeled image after the complete result batch; Chat cannot interleave it.
          return `[${label}; image follows the tool-result batch.]`
        })
        .join("\n")
      result.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.isError ? `[tool_error]\n${text}` : text,
      })
    } else {
      const toolCalls: ToolCall[] = []
      const reasoning: string[] = []
      let text = ""
      for (const block of message.content) {
        if (block.type === "compaction")
          throw new ChatCompletionsProtocolError(
            "Opaque provider compaction cannot be sent through Chat Completions.",
          )
        if (block.type === "text") text += block.text
        if (block.type === "reasoning") {
          const metadata = chatContinuationMetadata(
            block.providerMetadata,
            provider,
            continuationScope,
          )
          if (metadata?.reasoningContent === true) reasoning.push(block.text)
        }
        if (block.type !== "tool_call") continue
        const metadata =
          flavor === "gemini"
            ? chatContinuationMetadata(
                block.providerMetadata,
                provider,
                continuationScope,
              )
            : undefined
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(chatToolInput(block)),
          },
          ...(typeof metadata?.thoughtSignature !== "string"
            ? {}
            : {
                extra_content: {
                  google: { thought_signature: metadata.thoughtSignature },
                },
              }),
        })
      }
      const converted: AssistantMessage = {
        role: "assistant",
        content: text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        ...(reasoning.length === 0
          ? {}
          : { reasoning_content: reasoning.join("\n") }),
      }
      result.push(converted)
    }
  }
  if (toolMedia.length > 0) result.push({ role: "user", content: toolMedia })
  return result
}

function chatToolInput(block: ModelToolCallBlock): unknown {
  if (block.toolKind !== "custom") return block.input
  if (
    block.customInputFallbackKey === undefined ||
    typeof block.input !== "string"
  )
    throw new ChatCompletionsProtocolError(
      "Custom tool history requires a JSON input fallback.",
    )
  return { [block.customInputFallbackKey]: block.input }
}

function continuationMetadata(
  request: ModelRequest,
  value: JsonObject,
): JsonObject {
  return {
    provider: request.target.provider,
    ...(request.continuationScope === undefined
      ? {}
      : { scope: request.continuationScope }),
    ...value,
  }
}

function chatContinuationMetadata(
  metadata: JsonObject | undefined,
  provider: string,
  scope: string | undefined,
): JsonObject | undefined {
  const continuation = metadata?.chatCompletions
  return isJsonObject(continuation) &&
    continuation.provider === provider &&
    scope !== undefined &&
    continuation.scope === scope
    ? continuation
    : undefined
}

function geminiThoughtSignature(delta: JsonObject): string | undefined {
  const extra = delta.extra_content
  if (!isJsonObject(extra)) return undefined
  const google = extra.google
  return isJsonObject(google) && typeof google.thought_signature === "string"
    ? google.thought_signature
    : undefined
}

function fromChatUsage(
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): ModelUsage {
  if (
    ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  )
    throw new ChatCompletionsProtocolError("Invalid completion usage.")
  const extended: unknown = usage
  const deepseekCache = isJsonObject(extended)
    ? extended.prompt_cache_hit_tokens
    : undefined
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    (typeof deepseekCache === "number" ? deepseekCache : undefined)
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    activeContextTokens: usage.total_tokens,
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  }
}

class ChatCompletionsProtocolError extends Error {}
class ChatCompletionsIncompleteStreamError extends Error {}
