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
import { isJsonObject, isJsonValue, type JsonValue } from "../kernel/index.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelStreamFailureEvent,
  requireModelImageData,
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
  // SDK-internal retries stay disabled: the model request runtime owns policy.
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
    yield { type: "cancelled" }
    return
  }

  let stream: Awaited<ReturnType<typeof client.messages.stream>>
  let failureStage: "connect" | "response_body" = "connect"
  const customFallbackKeys = new Map(
    request.tools.flatMap((tool) =>
      tool.kind === "custom" && tool.customInputFallbackKey !== undefined
        ? [[tool.name, tool.customInputFallbackKey] as const]
        : [],
    ),
  )
  try {
    const nativeDeferredLoading =
      nativeDeferredToolProtocol(request) === "anthropic"
    const explicitPromptCaching =
      request.target.provider === "anthropic" ||
      request.target.provider === "kimi"
    const tools = toAnthropicTools(
      request.tools,
      explicitPromptCaching,
      nativeDeferredLoading,
    )
    // Effort is only sent where support is confirmed: official Anthropic and
    // Kimi's Anthropic-compatible coding endpoint (which mirrors Claude Code).
    // Explicit cache breakpoints are supported by both official Anthropic and
    // Kimi's Anthropic-compatible coding endpoint. Kimi boolean-thinking
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
        max_tokens: request.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
        system: toAnthropicSystem(request.system, explicitPromptCaching),
        messages: toAnthropicRequestMessages(
          request.messages,
          request.tools,
          explicitPromptCaching,
          nativeDeferredLoading,
          request.target.provider,
          request.continuationScope,
        ),
        ...(tools === undefined ? {} : { tools }),
        ...(request.cacheKey === undefined
          ? {}
          : { metadata: { user_id: request.cacheKey } }),
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
    // MessageStream starts its HTTP request asynchronously. Await its response
    // when the real SDK surface is present so pre-header failures stay in the
    // connect stage; lightweight test clients remain ordinary async iterables.
    if (typeof stream.withResponse === "function") {
      await stream.withResponse()
      failureStage = "response_body"
    }
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled" }
      return
    }
    yield terminalFailure(error, request.target.provider, "connect")
    return
  }

  let text = ""
  let reasoning = ""
  try {
    for await (const event of stream) {
      failureStage = "response_body"
      if (request.signal?.aborted) {
        yield { type: "cancelled" }
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
      response: fromAnthropicMessage(
        final,
        customFallbackKeys,
        request.target.provider,
        request.continuationScope,
      ),
    }
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled" }
      return
    }
    yield terminalFailure(error, request.target.provider, failureStage)
  }
}

export function toAnthropicMessages(
  messages: readonly ModelMessage[],
  nativeDeferredLoading = true,
  availableTools?: ReadonlyMap<string, ModelRequest["tools"][number]>,
  provider = "anthropic",
  continuationScope?: string,
): MessageParam[] {
  const converted: MessageParam[] = []
  for (const message of messages) {
    if (message.role === "developer") {
      const content = message.content.map((block) => ({
        type: "text" as const,
        text: block.text,
      }))
      appendAnthropicUserContent(converted, content)
      continue
    }
    if (message.role === "user") {
      appendAnthropicUserContent(converted, [
        ...message.content.map((block) => ({
          type: "text" as const,
          text: block.text,
        })),
        ...(message.images ?? []).map((block) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: block.mediaType,
            data: requireModelImageData(block),
          },
        })),
      ])
      continue
    }
    if (message.role === "assistant") {
      const content = message.content.flatMap((block) => {
        const converted = toAnthropicAssistantBlock(
          block,
          provider,
          continuationScope,
        )
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
      content:
        nativeDeferredLoading &&
        message.toolSearch !== undefined &&
        message.toolSearch.tools.length > 0 &&
        (availableTools === undefined ||
          message.toolSearch.tools.every((tool) => {
            const available = availableTools.get(tool.name)
            return (
              available !== undefined &&
              JSON.stringify(available) === JSON.stringify(tool)
            )
          }))
          ? message.toolSearch.tools.map((tool) => ({
              type: "tool_reference" as const,
              tool_name: tool.name,
            }))
          : (message.images?.length ?? 0) + (message.documents?.length ?? 0) ===
              0
            ? message.content
            : [
                { type: "text" as const, text: message.content },
                ...(message.images ?? []).map((image) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mediaType,
                    data: requireModelImageData(image),
                  },
                })),
                ...(message.documents ?? []).map((document) => {
                  if (document.data === undefined)
                    throw new Error("Unresolved document asset.")
                  return {
                    type: "document" as const,
                    title: document.name,
                    source: {
                      type: "base64" as const,
                      media_type: "application/pdf" as const,
                      data: document.data,
                    },
                  }
                }),
              ],
      ...(message.isError ? { is_error: true } : {}),
    }
    appendAnthropicUserContent(converted, [toolResult])
  }
  return converted
}

function appendAnthropicUserContent(
  messages: MessageParam[],
  content: ContentBlockParam[],
): void {
  const last = messages.at(-1)
  if (last?.role === "user" && Array.isArray(last.content)) {
    messages[messages.length - 1] = {
      role: "user",
      content: [...last.content, ...content],
    }
    return
  }
  messages.push({ role: "user", content })
}

export function toAnthropicTools(
  tools: ModelRequest["tools"],
  cacheBreakpoint = false,
  nativeDeferredLoading = true,
): Tool[] | undefined {
  if (tools.length === 0) return undefined
  let cacheBreakpointIndex = -1
  if (cacheBreakpoint) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      if (!nativeDeferredLoading || tools[index]?.deferLoading !== true) {
        cacheBreakpointIndex = index
        break
      }
    }
  }
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool["input_schema"],
    ...(nativeDeferredLoading && tool.deferLoading === true
      ? { defer_loading: true }
      : {}),
    ...(index === cacheBreakpointIndex
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
  messages: readonly ModelMessage[],
  tools: ModelRequest["tools"],
  cacheBreakpoint: boolean,
  nativeDeferredLoading: boolean,
  provider: string,
  continuationScope?: string,
): MessageParam[] {
  const dynamic = toAnthropicMessages(
    messages,
    nativeDeferredLoading,
    new Map(tools.map((tool) => [tool.name, tool])),
    provider,
    continuationScope,
  )
  if (cacheBreakpoint) markLastModelContentBlockCacheable(dynamic)
  return dynamic
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

export function fromAnthropicMessage(
  message: {
    readonly content: readonly unknown[]
    readonly stop_reason: string | null
    readonly usage?: {
      readonly input_tokens?: number
      readonly output_tokens?: number
      readonly cache_read_input_tokens?: number | null
      readonly cache_creation_input_tokens?: number | null
    }
    readonly id?: string
  },
  customFallbackKeys: ReadonlyMap<string, string> = new Map(),
  provider = "anthropic",
  continuationScope?: string,
): ModelResponse {
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
          anthropic: {
            provider,
            ...(continuationScope === undefined
              ? {}
              : { scope: continuationScope }),
            signature: block.signature,
          },
        },
      })
      continue
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      content.push({
        type: "reasoning",
        text: "",
        providerMetadata: {
          anthropic: {
            provider,
            ...(continuationScope === undefined
              ? {}
              : { scope: continuationScope }),
            redactedData: block.data,
          },
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
      const fallbackKey = customFallbackKeys.get(block.name)
      const toolInput =
        fallbackKey !== undefined &&
        isRecord(block.input) &&
        typeof block.input[fallbackKey] === "string"
          ? block.input[fallbackKey]
          : isJsonValue(block.input)
            ? block.input
            : {}
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: toolInput as JsonValue,
        ...(block.name === "tool_search"
          ? { toolKind: "tool_search" as const }
          : {}),
        ...(fallbackKey !== undefined
          ? {
              toolKind: "custom" as const,
              customInputFallbackKey: fallbackKey,
            }
          : {}),
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
            inputTokens:
              (message.usage.input_tokens ?? 0) +
              (message.usage.cache_read_input_tokens ?? 0) +
              (message.usage.cache_creation_input_tokens ?? 0),
            activeContextTokens:
              (message.usage.input_tokens ?? 0) +
              (message.usage.cache_read_input_tokens ?? 0) +
              (message.usage.cache_creation_input_tokens ?? 0) +
              (message.usage.output_tokens ?? 0),
            ...(message.usage.output_tokens === undefined
              ? {}
              : { outputTokens: message.usage.output_tokens }),
            ...(message.usage.cache_read_input_tokens === undefined
              ? {}
              : {
                  cacheReadInputTokens:
                    message.usage.cache_read_input_tokens ?? 0,
                }),
            ...(message.usage.cache_creation_input_tokens === undefined
              ? {}
              : {
                  cacheWriteInputTokens:
                    message.usage.cache_creation_input_tokens ?? 0,
                }),
          },
        }),
    ...(message.id === undefined ? {} : { providerRequestId: message.id }),
  }
}

function toAnthropicReasoningBlock(
  block: Extract<ModelContentBlock, { readonly type: "reasoning" }>,
  provider: string,
  continuationScope?: string,
): ThinkingBlockParam | RedactedThinkingBlockParam | undefined {
  const metadata = block.providerMetadata?.anthropic
  if (!isJsonObject(metadata)) return undefined
  if (
    metadata.provider !== provider &&
    !(metadata.provider === undefined && provider === "anthropic")
  ) {
    return undefined
  }
  if (metadata.scope !== continuationScope) return undefined
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
  provider: string,
  continuationScope?: string,
): ContentBlockParam | undefined {
  if (block.type === "compaction") {
    throw new Error(
      "Native compaction must be converted by its owning provider before using Anthropic Messages.",
    )
  }
  if (block.type === "text") return { type: "text", text: block.text }
  if (block.type === "reasoning")
    return toAnthropicReasoningBlock(block, provider, continuationScope)
  if (block.toolKind === "custom" && typeof block.input === "string") {
    if (block.customInputFallbackKey === undefined) {
      throw new Error(
        `Custom tool ${block.name} is missing its function fallback key.`,
      )
    }
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: { [block.customInputFallbackKey]: block.input },
    }
  }
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
  throw new Error(`Unsupported Anthropic stop reason: ${stopReason}.`)
}

function terminalFailure(
  error: unknown,
  provider: string,
  stage: "connect" | "response_body",
): ModelStreamFailureEvent {
  const status =
    error instanceof Anthropic.APIError && typeof error.status === "number"
      ? error.status
      : undefined
  const providerCode =
    error instanceof Anthropic.APIError && error.type !== null
      ? error.type
      : undefined
  const kind =
    error instanceof Anthropic.APIConnectionError
      ? stage === "connect"
        ? "connection_failed"
        : "stream_disconnected"
      : status !== undefined
        ? failureKindForStatus(status)
        : RETRYABLE_ERROR_TYPES.has(providerCode ?? "")
          ? "server_error"
          : undefined
  const retryAfterMs =
    error instanceof Anthropic.APIError
      ? parseRetryAfterMs(error.headers)
      : undefined
  const serverShouldRetry =
    error instanceof Anthropic.APIError
      ? parseShouldRetry(error.headers)
      : undefined
  const providerRequestId =
    error instanceof Anthropic.APIError && typeof error.requestID === "string"
      ? error.requestID
      : undefined
  return {
    type: "failure",
    failure: modelFailureFromUnknown(error, {
      provider,
      wireApi: "anthropic_messages",
      stage,
      ...(kind === undefined ? {} : { kind }),
      fallbackMessage: "Anthropic request failed.",
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(serverShouldRetry === undefined ? {} : { serverShouldRetry }),
    }),
    cause: error,
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
