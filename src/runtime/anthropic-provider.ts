import Anthropic, { toFile } from "@anthropic-ai/sdk"
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type {
  MessageCreateParamsStreaming,
  OutputConfig,
  RawMessageStreamEvent,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages"
import { isJsonObject, isJsonValue } from "../kernel/index.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import {
  DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS,
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelStreamFailureEvent,
  type ModelUsage,
  requireModelDocumentData,
  requireModelImageData,
  type StreamFn,
} from "./model.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import { groupModelResponses } from "./model-history.ts"
import {
  modelNativeItems,
  modelNativeResponseMetadata,
  portableModelContent,
  replayModelNativeItems,
} from "./model-native.ts"
import {
  applyModelRequestControls,
  ModelRequestControlsError,
} from "./model-request-controls.ts"
import { ANTHROPIC_REQUEST_MAX_BYTES } from "./native-pdf-capabilities.ts"
import { createFileUploadCache } from "./provider-file-cache.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"

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
  return anthropicTransport(options, false).stream
}

export function createAnthropicTurnTransport(
  options: AnthropicProviderOptions,
) {
  return anthropicTransport(options, true)
}

function anthropicTransport(
  options: AnthropicProviderOptions,
  ownsFiles: boolean,
) {
  // SDK-internal retries stay disabled: the model request runtime owns policy.
  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      maxRetries: 0,
    })

  const upload =
    ownsFiles &&
    URL.parse(client.baseURL)?.origin === "https://api.anthropic.com"
      ? createFileUploadCache(
          async (document, bytes, signal) =>
            (
              await client.beta.files.upload(
                {
                  file: await toFile(bytes, document.name, {
                    type: document.mediaType,
                  }),
                },
                signal === undefined ? undefined : { signal },
              )
            ).id,
          (id) => client.beta.files.delete(id),
        )
      : undefined
  const stream: StreamFn = (request) =>
    streamAnthropic(
      client,
      options.model,
      request,
      options.baseURL ?? "https://api.anthropic.com",
      upload,
    )
  return {
    stream,
    async close() {
      await upload?.close()
    },
  }
}

async function* streamAnthropic(
  client: Anthropic,
  defaultModel: string,
  request: ModelRequest,
  fallbackBaseURL: string,
  upload?: ReturnType<typeof createFileUploadCache>,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield { type: "cancelled" }
    return
  }

  let stream: AsyncIterable<BetaRawMessageStreamEvent | RawMessageStreamEvent>
  let providerRequestId: string | undefined
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
    if (
      request.tools.some(
        (tool) =>
          tool.kind === "custom" && tool.customInputFallbackKey === undefined,
      )
    )
      throw new ModelRequestControlsError(
        "Messages custom tools require a JSON input fallback.",
      )
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
    const media = await prepareProviderMedia(
      request,
      upload === undefined
        ? {}
        : {
            uploadDocument: (document, bytes) =>
              upload(document, bytes, request.signal),
          },
    )
    let body: import("@anthropic-ai/sdk/resources/beta/messages/messages").MessageCreateParamsStreaming =
      {
        stream: true,
        model: request.target.model || defaultModel,
        max_tokens:
          request.maxOutputTokens ?? DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS,
        system: toAnthropicSystem(request.system, explicitPromptCaching),
        messages: toAnthropicRequestMessages(
          media.messages,
          request.tools,
          explicitPromptCaching,
          nativeDeferredLoading,
          request.target.provider,
          request.continuationScope,
          media.uploadedFiles,
          request.target.model || defaultModel,
        ),
        ...(tools === undefined ? {} : { tools }),
        ...(request.toolChoice === undefined &&
        request.parallelToolCalls === undefined
          ? {}
          : {
              tool_choice: {
                ...(typeof request.toolChoice === "object"
                  ? { type: "tool" as const, name: request.toolChoice.name }
                  : {
                      type:
                        request.toolChoice === "required"
                          ? ("any" as const)
                          : (request.toolChoice ?? ("auto" as const)),
                    }),
                ...(request.parallelToolCalls === undefined
                  ? {}
                  : { disable_parallel_tool_use: !request.parallelToolCalls }),
              },
            }),
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
      }
    if (request.outputFormat !== undefined)
      body.output_config = {
        ...body.output_config,
        format: { type: "json_schema", schema: request.outputFormat.schema },
      }
    body = applyModelRequestControls(request, "anthropic_messages", body)
    // Only PDFs sent to the direct API use Anthropic's documented whole-body
    // limit. Compatible endpoints own their limits, regardless of provider ID.
    if (
      URL.parse(client.baseURL ?? fallbackBaseURL)?.href ===
        "https://api.anthropic.com/" &&
      body.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === "document" ||
              (block.type === "tool_result" &&
                Array.isArray(block.content) &&
                block.content.some((part) => part.type === "document")),
          ),
      )
    ) {
      const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8")
      if (requestBytes > ANTHROPIC_REQUEST_MAX_BYTES) {
        yield {
          type: "failure",
          failure: {
            kind: "invalid_request",
            stage: "request_build",
            provider: request.target.provider,
            wireApi: "anthropic_messages",
            message: `PDF-bearing Anthropic request is ${requestBytes} bytes, exceeding the ${ANTHROPIC_REQUEST_MAX_BYTES}-byte (32 MB) request limit. Send fewer PDF pages or attachments, reduce other request content, or use read_document with selected pages.`,
          },
        }
        return
      }
    }
    const pendingRequest =
      media.uploadedFiles.size > 0 ||
      request.providerOptions?.betas !== undefined
        ? client.beta.messages.create(
            {
              ...body,
              betas: [
                ...(media.uploadedFiles.size > 0
                  ? ["files-api-2025-04-14"]
                  : []),
                ...(request.providerOptions?.betas ?? []),
                ...(effortLevel === undefined ? [] : ["effort-2025-11-24"]),
              ],
            },
            request.signal === undefined
              ? undefined
              : { signal: request.signal },
          )
        : client.messages.create(
            body as MessageCreateParamsStreaming,
            request.signal === undefined && effortLevel === undefined
              ? undefined
              : {
                  ...(request.signal === undefined
                    ? {}
                    : { signal: request.signal }),
                  ...(effortLevel === undefined
                    ? {}
                    : { headers: { "anthropic-beta": "effort-2025-11-24" } }),
                },
          )
    const wireResponse = await pendingRequest.withResponse()
    stream = wireResponse.data
    providerRequestId =
      wireResponse.response.headers.get("request-id") ??
      wireResponse.response.headers.get("x-request-id") ??
      undefined
    failureStage = "response_body"
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled" }
      return
    }
    if (
      error instanceof AssetMediaError ||
      error instanceof ModelRequestControlsError
    ) {
      yield {
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          provider: request.target.provider,
          wireApi: "anthropic_messages",
          message: error.message,
        },
      }
    } else yield terminalFailure(error, request.target.provider, "connect")
    return
  }

  // The SDK MessageStream helper repairs partial JSON. Keep raw arguments here
  // so only a closed block with strictly parsed input can become an early call.
  const blocks = new Map<
    number,
    {
      block: Record<string, unknown>
      input: string
      inputStarted: boolean
      completed: boolean
      invalidInput: boolean
      content?: readonly ModelContentBlock[]
    }
  >()
  let message:
    | {
        id: string
        stop_reason: string | null
        usage: NonNullable<Parameters<typeof fromAnthropicMessage>[0]["usage"]>
      }
    | undefined
  let nativeMetadata: Record<string, unknown> = {}
  let observedUsage: ModelResponse["usage"]
  const usageFields = () =>
    observedUsage === undefined ? {} : { usage: observedUsage }
  let nextOutputIndex = 0
  let terminalResponse: ModelResponse | undefined
  try {
    for await (const event of stream) {
      if (request.signal?.aborted) {
        yield { type: "cancelled", ...usageFields() }
        return
      }
      if (terminalResponse !== undefined)
        throw new AnthropicProtocolError(
          "Anthropic returned an event after message_stop.",
        )
      if (event.type === "message_start") {
        if (message !== undefined)
          throw new AnthropicProtocolError("Anthropic repeated message_start.")
        const { content: _content, ...metadata } = event.message
        nativeMetadata = metadata
        message = {
          id: event.message.id,
          stop_reason: event.message.stop_reason,
          usage: { ...event.message.usage },
        }
        if (Object.values(message.usage).some((value) => value != null)) {
          observedUsage = fromAnthropicUsage(message.usage)
          request.onUsageSnapshot?.(observedUsage)
        }
        continue
      }
      if (message === undefined)
        throw new AnthropicProtocolError(
          "Anthropic output preceded message_start.",
        )
      if (event.type === "content_block_start") {
        if (blocks.has(event.index))
          throw new AnthropicProtocolError(
            "Anthropic repeated a content block.",
          )
        blocks.set(event.index, {
          block: { ...event.content_block },
          input: "",
          inputStarted: false,
          completed: false,
          invalidInput: false,
        })
        continue
      }
      if (event.type === "content_block_delta") {
        const pending = blocks.get(event.index)
        if (pending === undefined || pending.completed)
          throw new AnthropicProtocolError("Anthropic delta has no open block.")
        const itemId = `${message.id}_block_${event.index}`
        if (event.delta.type === "text_delta") {
          if (pending.block.type !== "text")
            throw new AnthropicProtocolError(
              "Anthropic text delta has a non-text block.",
            )
          pending.block.text =
            String(pending.block.text ?? "") + event.delta.text
          yield {
            type: "delta",
            text: event.delta.text,
            ...(request.streamOutputItems ? { itemId } : {}),
          }
        } else if (event.delta.type === "citations_delta") {
          if (
            pending.block.type !== "text" ||
            !isJsonObject(event.delta.citation)
          )
            throw new AnthropicProtocolError(
              "Anthropic citation delta has an invalid text block.",
            )
          const citations = pending.block.citations
          if (citations != null && !Array.isArray(citations))
            throw new AnthropicProtocolError("Invalid Anthropic citations.")
          pending.block.citations = [...(citations ?? []), event.delta.citation]
        } else if (event.delta.type === "thinking_delta") {
          if (pending.block.type !== "thinking")
            throw new AnthropicProtocolError(
              "Anthropic thinking delta has a non-thinking block.",
            )
          pending.block.thinking =
            String(pending.block.thinking ?? "") + event.delta.thinking
          yield {
            type: "reasoning_delta",
            text: event.delta.thinking,
            ...(request.streamOutputItems ? { itemId } : {}),
          }
        } else if (event.delta.type === "signature_delta") {
          if (pending.block.type !== "thinking")
            throw new AnthropicProtocolError(
              "Anthropic signature delta has a non-thinking block.",
            )
          // Signature events carry the full value, matching SDK accumulation.
          pending.block.signature = event.delta.signature
        } else if (event.delta.type === "input_json_delta") {
          if (
            pending.block.type !== "tool_use" &&
            pending.block.type !== "server_tool_use"
          )
            throw new AnthropicProtocolError(
              "Anthropic tool delta has a non-tool block.",
            )
          pending.inputStarted = true
          pending.input += event.delta.partial_json
        } else {
          throw new AnthropicProtocolError(
            "Unsupported Anthropic content delta.",
          )
        }
        continue
      }
      if (event.type === "content_block_stop") {
        const pending = blocks.get(event.index)
        if (pending === undefined || pending.completed)
          throw new AnthropicProtocolError(
            "Anthropic stopped an unknown or closed block.",
          )
        pending.completed = true
        if (
          (pending.block.type === "tool_use" ||
            pending.block.type === "server_tool_use") &&
          pending.inputStarted
        ) {
          try {
            pending.block.input = JSON.parse(pending.input)
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
            pending.invalidInput = true
          }
        }
        if (!pending.invalidInput)
          pending.content = fromAnthropicMessage(
            { content: [pending.block], stop_reason: "end_turn" },
            customFallbackKeys,
            request.target.provider,
            request.continuationScope,
          ).content
        if (request.streamOutputItems && request.compaction === undefined) {
          for (;;) {
            const completed = blocks.get(nextOutputIndex)
            if (completed?.content === undefined) break
            const itemId = `${message.id}_block_${nextOutputIndex}`
            nextOutputIndex += 1
            yield {
              type: "output_item",
              itemId,
              content: completed.content,
              native: modelNativeItems(request, "anthropic_messages", [
                completed.block,
              ]),
            }
          }
        }
        continue
      }
      if (event.type === "message_delta") {
        message.stop_reason = event.delta.stop_reason
        message.usage = {
          ...message.usage,
          ...(event.usage.input_tokens == null
            ? {}
            : { input_tokens: event.usage.input_tokens }),
          output_tokens: event.usage.output_tokens,
          ...(event.usage.cache_read_input_tokens == null
            ? {}
            : { cache_read_input_tokens: event.usage.cache_read_input_tokens }),
          ...(event.usage.cache_creation_input_tokens == null
            ? {}
            : {
                cache_creation_input_tokens:
                  event.usage.cache_creation_input_tokens,
              }),
        }
        nativeMetadata = {
          ...nativeMetadata,
          ...event.delta,
          usage: message.usage,
        }
        observedUsage = fromAnthropicUsage(message.usage)
        request.onUsageSnapshot?.(observedUsage)
        continue
      }
      if (event.type === "message_stop") {
        const incompleteToolCalls = [...blocks.values()].some(
          (pending) =>
            pending.block.type === "tool_use" &&
            (!pending.completed || pending.invalidInput),
        )
        const content = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .flatMap(([, pending]) =>
            pending.block.type === "tool_use" &&
            (!pending.completed || pending.invalidInput)
              ? []
              : [
                  pending.block.type === "thinking" && !pending.completed
                    ? { ...pending.block, signature: undefined }
                    : pending.block,
                ],
          )
        const response = fromAnthropicMessage(
          { ...message, content },
          customFallbackKeys,
          request.target.provider,
          request.continuationScope,
        )
        if (
          incompleteToolCalls &&
          response.stopReason !== ModelStopReason.Length &&
          response.stopReason !== ModelStopReason.ContentFilter
        )
          throw new AnthropicProtocolError(
            "Anthropic returned incomplete tool arguments without a length or content filter stop.",
          )
        terminalResponse = {
          ...response,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          native: modelNativeItems(request, "anthropic_messages", content),
          nativeMetadata: modelNativeResponseMetadata(
            request,
            "anthropic_messages",
            nativeMetadata,
          ),
          ...(message.id === undefined
            ? {}
            : { providerResponseId: message.id }),
          ...(incompleteToolCalls ? { incompleteToolCalls: true } : {}),
        }
      }
    }
    // A terminal event is provisional until the raw SDK iterator reaches EOF.
    // Otherwise a malformed tail could become a retryable compaction Length.
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...usageFields() }
      return
    }
    if (terminalResponse !== undefined)
      yield { type: "response", response: terminalResponse }
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...usageFields() }
      return
    }
    yield {
      ...terminalFailure(
        terminalResponse !== undefined &&
          !(error instanceof AnthropicProtocolError)
          ? new AnthropicProtocolError(
              "Anthropic stream failed after message_stop.",
              { cause: error },
            )
          : error,
        request.target.provider,
        failureStage,
        providerRequestId,
        message?.id,
      ),
      ...usageFields(),
    }
  }
}

export function toAnthropicMessages(
  messages: readonly ModelMessage[],
  nativeDeferredLoading = true,
  availableTools?: ReadonlyMap<string, ModelRequest["tools"][number]>,
  provider = "anthropic",
  continuationScope?: string,
  uploadedFiles: ReadonlyMap<
    import("./model.ts").ModelDocumentBlock,
    string
  > = new Map(),
  model?: string,
): BetaMessageParam[] {
  const converted: BetaMessageParam[] = []
  for (const message of groupModelResponses(messages)) {
    if (message.role === "developer") {
      const content = message.content.map((block) => ({
        type: "text" as const,
        text: block.text,
      }))
      appendAnthropicContent(converted, "user", content)
      continue
    }
    if (message.role === "user") {
      appendAnthropicContent(
        converted,
        "user",
        message.content.map((block) => {
          if (block.type === "text")
            return { type: "text" as const, text: block.text }
          if (block.type === "image")
            return {
              type: "image" as const,
              source:
                block.file && "url" in block.file
                  ? { type: "url" as const, url: block.file.url }
                  : {
                      type: "base64" as const,
                      media_type: block.mediaType,
                      data: requireModelImageData(block),
                    },
            }
          const fileId = uploadedFiles.get(block)
          return {
            type: "document" as const,
            title: block.name,
            source:
              fileId !== undefined
                ? { type: "file" as const, file_id: fileId }
                : "url" in block.file
                  ? { type: "url" as const, url: block.file.url }
                  : {
                      type: "base64" as const,
                      media_type: "application/pdf" as const,
                      data: requireModelDocumentData(block),
                    },
          }
        }),
      )
      continue
    }
    if (message.role === "assistant") {
      const native = replayModelNativeItems(
        message,
        "anthropic_messages",
        provider,
        continuationScope,
        model,
      )
      const content =
        native === undefined
          ? portableModelContent(message).flatMap((block) => {
              const converted = toAnthropicAssistantBlock(
                block,
                provider,
                continuationScope,
              )
              return converted === undefined ? [] : [converted]
            })
          : native.map((block) => block as unknown as BetaContentBlockParam)
      if (content.length === 0) continue
      // Streamed output items split one response into several history messages.
      // Compatible endpoints may not combine same-role turns like Anthropic does.
      appendAnthropicContent(converted, "assistant", content)
      continue
    }

    const toolResult: BetaToolResultBlockParam = {
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
          : message.content.every((block) => block.type === "text")
            ? message.content.map((block) => block.text).join("\n")
            : message.content.map((block) => {
                if (block.type === "text")
                  return { type: "text" as const, text: block.text }
                if (block.type === "image")
                  return {
                    type: "image" as const,
                    source:
                      block.file && "url" in block.file
                        ? { type: "url" as const, url: block.file.url }
                        : {
                            type: "base64" as const,
                            media_type: block.mediaType,
                            data: requireModelImageData(block),
                          },
                  }
                const fileId = uploadedFiles.get(block)
                if (
                  block.data === undefined &&
                  !("url" in block.file) &&
                  fileId === undefined
                )
                  throw new Error("Unresolved document asset.")
                return {
                  type: "document" as const,
                  title: block.name,
                  source:
                    fileId !== undefined
                      ? {
                          type: "file" as const,
                          file_id: fileId,
                        }
                      : "url" in block.file
                        ? { type: "url" as const, url: block.file.url }
                        : {
                            type: "base64" as const,
                            media_type: "application/pdf" as const,
                            data: requireModelDocumentData(block),
                          },
                }
              }),
      ...(message.isError ? { is_error: true } : {}),
    }
    appendAnthropicContent(converted, "user", [toolResult])
  }
  return converted
}

function appendAnthropicContent(
  messages: BetaMessageParam[],
  role: BetaMessageParam["role"],
  content: BetaContentBlockParam[],
): void {
  const last = messages.at(-1)
  if (last?.role === role && Array.isArray(last.content)) {
    messages[messages.length - 1] = {
      role,
      content: [...last.content, ...content],
    }
    return
  }
  messages.push({ role, content })
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
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
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
  uploadedFiles: ReadonlyMap<
    import("./model.ts").ModelDocumentBlock,
    string
  > = new Map(),
  model?: string,
): BetaMessageParam[] {
  const dynamic = toAnthropicMessages(
    messages,
    nativeDeferredLoading,
    new Map(tools.map((tool) => [tool.name, tool])),
    provider,
    continuationScope,
    uploadedFiles,
    model,
  )
  if (cacheBreakpoint) markLastModelContentBlockCacheable(dynamic)
  return dynamic
}

function markLastModelContentBlockCacheable(
  messages: BetaMessageParam[],
): boolean {
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
    if (!isRecord(block))
      throw new AnthropicProtocolError("Invalid Anthropic content block.")
    if (block.type === "thinking" && typeof block.thinking === "string") {
      content.push({
        type: "reasoning",
        text: block.thinking,
        ...(typeof block.signature === "string" && block.signature.length > 0
          ? {
              providerMetadata: {
                anthropic: {
                  provider,
                  ...(continuationScope === undefined
                    ? {}
                    : { scope: continuationScope }),
                  signature: block.signature,
                },
              },
            }
          : {}),
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
      if (
        block.citations != null &&
        (!Array.isArray(block.citations) ||
          !block.citations.every(isJsonObject))
      )
        throw new AnthropicProtocolError("Invalid Anthropic citations.")
      content.push({
        type: "text",
        text: block.text,
        ...(Array.isArray(block.citations) && block.citations.length > 0
          ? {
              providerMetadata: {
                anthropic: {
                  provider,
                  ...(continuationScope === undefined
                    ? {}
                    : { scope: continuationScope }),
                  citations: block.citations,
                },
              },
            }
          : {}),
      })
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
          : block.input
      if (!isJsonValue(toolInput))
        throw new AnthropicProtocolError(
          `Anthropic returned invalid input for tool ${block.name}.`,
        )
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: toolInput,
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
      continue
    }
    if (
      typeof block.type === "string" &&
      (block.type === "server_tool_use" || block.type.endsWith("_tool_result"))
    )
      continue
    throw new AnthropicProtocolError(
      `Unsupported Anthropic content type: ${String(block.type)}.`,
    )
  }

  const stopReason = mapStopReason(message.stop_reason, content)
  return {
    stopReason,
    content,
    ...(message.stop_reason === null
      ? {}
      : { rawStopReason: message.stop_reason }),
    ...(stopReason === ModelStopReason.Length
      ? {
          lengthReason:
            message.stop_reason === "model_context_window_exceeded"
              ? ("context" as const)
              : ("output" as const),
        }
      : {}),
    ...(message.usage === undefined
      ? {}
      : { usage: fromAnthropicUsage(message.usage) }),
    ...(message.id === undefined ? {} : { providerResponseId: message.id }),
  }
}

function fromAnthropicUsage(
  usage: NonNullable<Parameters<typeof fromAnthropicMessage>[0]["usage"]>,
): ModelUsage {
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  return {
    inputTokens,
    activeContextTokens: inputTokens + (usage.output_tokens ?? 0),
    ...(usage.output_tokens === undefined
      ? {}
      : { outputTokens: usage.output_tokens }),
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cache_read_input_tokens ?? 0 }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0 }),
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
  if (typeof metadata.signature !== "string" || metadata.signature.length === 0)
    return undefined
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
): BetaContentBlockParam | undefined {
  if (block.type === "compaction") {
    throw new Error(
      "Native compaction must be converted by its owning provider before using Anthropic Messages.",
    )
  }
  if (block.type === "text") {
    const metadata = block.providerMetadata?.anthropic
    // Document/search-result indices belong to the original request. A model
    // switch or compaction can remove/reorder those sources, so keep their full
    // provenance in history for display but never replay unbound indices.
    const citations =
      isJsonObject(metadata) &&
      metadata.provider === provider &&
      continuationScope !== undefined &&
      metadata.scope === continuationScope &&
      Array.isArray(metadata.citations)
        ? metadata.citations.flatMap((citation) => {
            if (
              !isJsonObject(citation) ||
              citation.type !== "web_search_result_location" ||
              typeof citation.cited_text !== "string" ||
              typeof citation.encrypted_index !== "string" ||
              typeof citation.url !== "string" ||
              (citation.title != null && typeof citation.title !== "string")
            )
              return []
            return [
              {
                type: "web_search_result_location" as const,
                cited_text: citation.cited_text,
                encrypted_index: citation.encrypted_index,
                url: citation.url,
                title: citation.title ?? null,
              },
            ]
          })
        : []
    return {
      type: "text",
      text: block.text,
      ...(citations.length === 0 ? {} : { citations }),
    }
  }
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
  if (
    stopReason === "max_tokens" ||
    stopReason === "model_context_window_exceeded"
  )
    return ModelStopReason.Length
  if (stopReason === "pause_turn") return ModelStopReason.PauseTurn
  if (stopReason === "refusal") return ModelStopReason.ContentFilter
  if (stopReason === "tool_use") return ModelStopReason.ToolUse
  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    return content.some((block) => block.type === "tool_call")
      ? ModelStopReason.ToolUse
      : ModelStopReason.EndTurn
  }
  throw new AnthropicProtocolError(
    `Unsupported Anthropic stop reason: ${stopReason ?? "missing"}.`,
  )
}

class AnthropicProtocolError extends Error {}

function terminalFailure(
  error: unknown,
  provider: string,
  stage: "connect" | "response_body",
  requestId?: string,
  responseId?: string,
): ModelStreamFailureEvent {
  const status =
    error instanceof Anthropic.APIError && typeof error.status === "number"
      ? error.status
      : undefined
  const providerCode =
    error instanceof Anthropic.APIError && error.type !== null
      ? error.type
      : undefined
  const providerMessage =
    error instanceof Anthropic.APIError &&
    isRecord(error.error) &&
    isRecord(error.error.error) &&
    typeof error.error.error.message === "string"
      ? error.error.error.message
      : undefined
  const kind =
    error instanceof AnthropicProtocolError
      ? "protocol_error"
      : error instanceof Anthropic.APIConnectionError
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
      : requestId
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
      ...(providerMessage === undefined ? {} : { providerMessage }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(responseId === undefined ? {} : { providerResponseId: responseId }),
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
