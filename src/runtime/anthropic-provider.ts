import Anthropic from "@anthropic-ai/sdk"
import type {
  ContentBlockParam,
  MessageParam,
  OutputConfig,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages"
import {
  isJsonValue,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../kernel/index.ts"
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

export type AnthropicProviderOptions = {
  readonly apiKey: string
  readonly model: string
  readonly client?: Anthropic
  // Compatible endpoints (e.g. Kimi Code at https://api.kimi.com/coding/v1)
  // override the default and may require extra identity headers.
  readonly baseURL?: string
  readonly defaultHeaders?: Record<string, string>
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): StreamFn {
  // SDK-internal retries stay disabled: withRetries owns the retry policy.
  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      maxRetries: 0,
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
    const explicitPromptCaching = request.target.provider === "anthropic"
    const tools = toAnthropicTools(request.tools, explicitPromptCaching)
    // Effort is only sent where support is confirmed: official Anthropic and
    // Kimi's Anthropic-compatible coding endpoint (which mirrors Claude Code).
    // Cache-control stays official-Anthropic-only. Kimi boolean-thinking
    // models take "on"/"off": "off" maps to thinking.disabled, "on" is the
    // endpoint default and sends nothing; real levels use the effort beta.
    const effort = EFFORT_BETA_PROVIDERS.has(request.target.provider)
      ? request.target.effort
      : undefined
    const effortLevel =
      effort === undefined || effort === "on" || effort === "off"
        ? undefined
        : effort
    const thinking =
      effort === "off"
        ? ({ type: "disabled" } as const)
        : request.target.provider === "anthropic" &&
            supportsAdaptiveThinking(request.target.model || defaultModel)
          ? ({ type: "adaptive", display: "summarized" } as const)
          : undefined
    stream = client.messages.stream(
      {
        model: request.target.model || defaultModel,
        max_tokens: 8_192,
        system: toAnthropicSystem(request.system, explicitPromptCaching),
        messages: toAnthropicRequestMessages(
          request.contextual.map((entry) => entry.message),
          request.messages,
          explicitPromptCaching,
        ),
        ...(tools === undefined ? {} : { tools }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(effortLevel === undefined
          ? {}
          : {
              output_config: {
                effort: effortLevel as NonNullable<OutputConfig["effort"]>,
              },
            }),
      },
      request.signal === undefined && effortLevel === undefined
        ? undefined
        : {
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(effortLevel === undefined
              ? {}
              : { headers: { "anthropic-beta": "effort-2025-11-24" } }),
          },
    )
  } catch (error) {
    yield {
      type: "response",
      response: terminalError(error),
    }
    return
  }

  let text = ""
  let reasoning = ""
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
        continue
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "thinking_delta"
      ) {
        reasoning += event.delta.thinking
        yield { type: "reasoning_snapshot", text: reasoning }
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
      const content = message.content.flatMap((block) => {
        const converted = toAnthropicAssistantBlock(block)
        return converted === undefined ? [] : [converted]
      })
      if (content.length === 0) continue
      converted.push({
        role: "assistant",
        content,
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
  cacheBreakpoint = false,
): Tool[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool["input_schema"],
    ...(cacheBreakpoint && index === tools.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }))
}

export function toAnthropicSystem(
  sections: ModelRequest["system"],
  cacheBreakpoints = false,
): string | TextBlockParam[] {
  if (!cacheBreakpoints || sections.length === 0) {
    return flattenModelSystem(sections)
  }
  return sections.map((section, index) => ({
    type: "text",
    text: section.text,
    ...(index === 0 || index === sections.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }))
}

function toAnthropicRequestMessages(
  contextualMessages: readonly ModelMessage[],
  messages: readonly ModelMessage[],
  cacheBreakpoint: boolean,
): MessageParam[] {
  const contextual = toAnthropicMessages(contextualMessages)
  const dynamic = toAnthropicMessages(messages)
  if (cacheBreakpoint && !markLastModelContentBlockCacheable(dynamic)) {
    markLastModelContentBlockCacheable(contextual)
  }
  return [...contextual, ...dynamic]
}

function markLastModelContentBlockCacheable(messages: MessageParam[]): boolean {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const content = messages[messageIndex]?.content
    if (!Array.isArray(content)) continue
    for (
      let blockIndex = content.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = content[blockIndex]
      if (
        block?.type !== "text" &&
        block?.type !== "tool_use" &&
        block?.type !== "tool_result"
      ) {
        continue
      }
      block.cache_control = { type: "ephemeral" }
      return true
    }
  }
  return false
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
    if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      typeof block.signature === "string"
    ) {
      content.push({
        type: "reasoning",
        text: block.thinking,
        providerMetadata: {
          anthropic: { signature: block.signature },
        },
      })
      continue
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      content.push({
        type: "reasoning",
        text: "",
        providerMetadata: {
          anthropic: { redactedData: block.data },
        },
      })
      continue
    }
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

function toAnthropicReasoningBlock(
  block: Extract<ModelContentBlock, { readonly type: "reasoning" }>,
): ThinkingBlockParam | RedactedThinkingBlockParam | undefined {
  const metadata = block.providerMetadata?.anthropic
  if (!isJsonObject(metadata)) return undefined
  if (typeof metadata.redactedData === "string") {
    return { type: "redacted_thinking", data: metadata.redactedData }
  }
  if (typeof metadata.signature !== "string") return undefined
  return {
    type: "thinking",
    thinking: block.text,
    signature: metadata.signature,
  }
}

function toAnthropicAssistantBlock(
  block: ModelContentBlock,
): ContentBlockParam | undefined {
  if (block.type === "text") return { type: "text", text: block.text }
  if (block.type === "reasoning") return toAnthropicReasoningBlock(block)
  return {
    type: "tool_use",
    id: block.id,
    name: block.name,
    input:
      typeof block.input === "object" && block.input !== null
        ? block.input
        : {},
  }
}

function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(?:opus|sonnet)-(?:[5-9](?:-|$)|4-(?:[6-9]|\d{2})(?:-|$))/.test(
    model,
  )
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
  const details = retryableDetails(error)
  return {
    stopReason: ModelStopReason.Error,
    content: [],
    error: {
      code: "anthropic_error",
      message:
        error instanceof Error ? error.message : "Anthropic request failed.",
      ...(details === undefined ? {} : { details }),
    },
  }
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 429, 500, 502, 503, 504, 529,
])

// Providers whose Anthropic-compatible endpoint accepts the effort beta.
const EFFORT_BETA_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "kimi",
])

// Mid-stream SSE error events carry no HTTP status; these error types are the
// transient ones worth retrying.
const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
])

// Transient failures carry retryable details for withRetries: retryable HTTP
// statuses, plus connection/timeout errors (APIConnectionTimeoutError extends
// APIConnectionError; both have no HTTP status).
function retryableDetails(error: unknown): JsonObject | undefined {
  if (error instanceof Anthropic.APIConnectionError) {
    return { retryable: true }
  }
  if (
    error instanceof Anthropic.APIError &&
    typeof error.status === "number" &&
    RETRYABLE_STATUSES.has(error.status)
  ) {
    return { retryable: true, status: error.status }
  }
  if (
    error instanceof Anthropic.APIError &&
    error.type !== null &&
    RETRYABLE_ERROR_TYPES.has(error.type)
  ) {
    return { retryable: true, type: error.type }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
