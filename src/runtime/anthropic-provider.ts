import Anthropic, { toFile } from "@anthropic-ai/sdk"
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages"
import { isJsonObject, isJsonValue } from "../kernel/index.ts"
import {
  anthropicImageCount,
  anthropicImageTier,
  prepareAnthropicImage,
  validateAnthropicScreenshot,
} from "./anthropic-image-policy.ts"
import {
  type AnthropicMessagesProfile,
  defaultAnthropicMessagesProfile,
} from "./anthropic-messages-profiles.ts"
import { anthropicModel } from "./anthropic-models.ts"
import {
  prepareAnthropicThinkingHistory,
  reportAnthropicThinkingChanges,
  thinkingBindingBeta,
} from "./anthropic-thinking-policy.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import { prepareKimiCodeImage } from "./kimi-code-image-policy.ts"
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
import { anthropicCitations } from "./model-citations.ts"
import { cleanModelTextStream } from "./model-control-tokens.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import { groupModelResponses } from "./model-history.ts"
import {
  ModelHistoryScopeError,
  modelNativeItems,
  modelNativeResponseMetadata,
  portableModelContent,
  replayModelNativeItems,
  validateModelHistoryScope,
} from "./model-native.ts"
import {
  applyModelRequestControls,
  ModelRequestControlsError,
  validateModelRequestControls,
} from "./model-request-controls.ts"
import { ANTHROPIC_REQUEST_MAX_BYTES } from "./native-pdf-capabilities.ts"
import { createFileUploadCache } from "./provider-file-cache.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"

class AnthropicImageBudgetFallback extends Error {}

export type AnthropicProviderOptions = Readonly<{
  apiKey: string
  model: string
  client?: Anthropic
  // Compatible endpoints (e.g. Kimi Code at https://api.kimi.com/coding/v1)
  // override the default and may require extra identity headers.
  baseURL?: string
  defaultHeaders?: Record<string, string | null>
  profile?: AnthropicMessagesProfile
}>

export function createAnthropicTurnTransport(
  options: AnthropicProviderOptions,
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
    cleanModelTextStream(
      streamAnthropic(
        client,
        options.model,
        request,
        options.baseURL ?? "https://api.anthropic.com",
        upload,
        options.profile ??
          defaultAnthropicMessagesProfile(
            client.baseURL ?? options.baseURL ?? "https://api.anthropic.com",
          ),
      ),
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
  upload: ReturnType<typeof createFileUploadCache> | undefined,
  profile: AnthropicMessagesProfile,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield { type: "cancelled" }
    return
  }

  let thinkingDisplay: "summarized" | "updates" | undefined
  let stream: AsyncIterable<BetaRawMessageStreamEvent | RawMessageStreamEvent>
  let providerRequestId: string | undefined
  const customFallbackKeys = new Map(
    request.tools.flatMap((tool) =>
      tool.kind === "custom" && tool.customInputFallbackKey !== undefined
        ? [[tool.name, tool.customInputFallbackKey] as const]
        : [],
    ),
  )
  try {
    validateModelHistoryScope(request, "anthropic_messages")
    validateModelRequestControls(request, "anthropic_messages")
    const model = request.target.model || defaultModel
    profile.validateRequest?.(request, model)
    const nativeDeferredLoading =
      nativeDeferredToolProtocol(request) === "anthropic"
    const explicitPromptCaching = profile.explicitPromptCaching
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
    const thinking = profile.thinking?.(request, model)
    const mediaPolicy = profile.selectMedia(client.baseURL ?? fallbackBaseURL)
    const nativeImagePolicy = mediaPolicy === "anthropic"
    const kimiCodeImages = mediaPolicy === "kimi-code"
    // Hard native admission and local request budgets apply even with PDFs or
    // SDK controls. Only the ordinary image-only slice opts into automatic
    // tier re-encoding: advanced controls may change screenshot/SDK semantics.
    const controls = request.providerOptions?.body
    const imageCount = anthropicImageCount(request.messages)
    const nativeImages = nativeImagePolicy && imageCount > 0
    const allowTierImagePreparation =
      nativeImages &&
      !request.messages.some(
        (message) =>
          (message.role === "user" || message.role === "tool") &&
          message.content.some((block) => block.type === "document"),
      ) &&
      controls?.tools === undefined &&
      controls?.user_profile_id === undefined &&
      controls?.output_format === undefined &&
      controls?.betas === undefined
    const imageTier = anthropicImageTier(request.target.model || defaultModel)
    const delegateImages = allowTierImagePreparation && imageTier !== undefined
    if (
      nativeImages &&
      imageCount >
        (anthropicModel(request.target.model || defaultModel)?.configuration
          .contextWindowTokens === 200_000
          ? 100
          : 600)
    )
      throw new AssetMediaError(
        "Images were not sent: the request exceeds the applicable Claude image-count guard (the documented model allowance when known, otherwise the shared API maximum). Send fewer attachments; originals have not been changed.",
      )
    const screenshotTools = new Set(
      (Array.isArray(controls?.tools) ? controls.tools : []).flatMap((tool) =>
        isJsonObject(tool) &&
        typeof tool.type === "string" &&
        /^(computer|browser)_/.test(tool.type) &&
        typeof tool.name === "string"
          ? [tool.name]
          : [],
      ),
    )
    const screenshotCalls = new Set(
      request.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool_call" && screenshotTools.has(part.name)
                ? [part.id]
                : [],
            )
          : [],
      ),
    )
    const screenshots = new Set(
      request.messages.flatMap((message) =>
        message.role === "tool" && screenshotCalls.has(message.toolCallId)
          ? message.content.filter((part) => part.type === "image")
          : [],
      ),
    )
    let preferSmallerImages = !delegateImages
    let preparedImageBytes = 0
    const prepareImage = async (
      bytes: Buffer,
      image: import("./model.ts").ModelImageBlock,
    ) => {
      if (kimiCodeImages)
        return prepareKimiCodeImage(bytes, image, request.signal)
      if (screenshots.has(image))
        validateAnthropicScreenshot(bytes, request.target.model || defaultModel)
      const prepared = await prepareAnthropicImage(
        bytes,
        image,
        imageCount,
        request.signal,
        preferSmallerImages,
        delegateImages ? (imageTier ?? null) : null,
      )
      preparedImageBytes += prepared.data?.length ?? 0
      // A lower bound catches large file-backed batches before retaining every
      // image. Abandon this no-document pass and rebuild once with smaller
      // candidates; no upload or model request has happened yet.
      if (preparedImageBytes > ANTHROPIC_REQUEST_MAX_BYTES) {
        if (!preferSmallerImages) throw new AnthropicImageBudgetFallback()
        throw new AssetMediaError(
          "Images were not sent: image data alone exceeds the 32 MB Yakitori request budget after bounded preparation. Send fewer attachments; originals have not been changed.",
        )
      }
      return prepared
    }
    const mediaOptions = {
      ...(nativeImagePolicy || kimiCodeImages ? { prepareImage } : {}),
      ...(kimiCodeImages ? { inlineImageUrls: true } : {}),
      ...(upload === undefined
        ? {}
        : {
            uploadDocument: (
              document: import("./model.ts").ModelDocumentBlock,
              bytes: Buffer,
            ) => upload(document, bytes, request.signal),
          }),
    }
    let media: Awaited<ReturnType<typeof prepareProviderMedia>>
    try {
      media = await prepareProviderMedia(request, mediaOptions)
    } catch (cause) {
      if (!(cause instanceof AnthropicImageBudgetFallback)) throw cause
      preferSmallerImages = true
      preparedImageBytes = 0
      media = await prepareProviderMedia(request, mediaOptions)
    }
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
        ...thinking?.fields,
      }
    if (request.outputFormat !== undefined)
      body.output_config = {
        ...body.output_config,
        format: { type: "json_schema", schema: request.outputFormat.schema },
      }
    body = applyModelRequestControls(request, "anthropic_messages", body)
    // Every native image request retains the whole-body budget. Only the
    // image-only slice may retry with its known tier, before any upload. Do not
    // rerun a document upload or guess screenshot resizing for advanced tools.
    if (
      nativeImages &&
      Buffer.byteLength(JSON.stringify(body), "utf8") >
        ANTHROPIC_REQUEST_MAX_BYTES
    ) {
      if (!preferSmallerImages) {
        preferSmallerImages = true
        preparedImageBytes = 0
        const fallback = await prepareProviderMedia(
          { ...request, messages: media.messages },
          { prepareImage },
        )
        body.messages = toAnthropicRequestMessages(
          fallback.messages,
          request.tools,
          explicitPromptCaching,
          nativeDeferredLoading,
          request.target.provider,
          request.continuationScope,
          fallback.uploadedFiles,
          request.target.model || defaultModel,
        )
      }
      const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8")
      if (requestBytes > ANTHROPIC_REQUEST_MAX_BYTES)
        throw new AssetMediaError(
          `Images were not sent: the Anthropic request is ${requestBytes} bytes after bounded preparation, exceeding the 32 MB Yakitori whole-request budget. Send fewer attachments or reduce other request content; originals have not been changed.`,
        )
    }
    // Retain the existing local PDF-bearing request budget. It is not the
    // current official API ceiling; compatible endpoints own their limits.
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
            message: `PDF-bearing Anthropic request is ${requestBytes} bytes, exceeding Yakitori's ${ANTHROPIC_REQUEST_MAX_BYTES}-byte (32 MB) request budget. Send fewer PDF pages or attachments, reduce other request content, or use read_document with selected pages.`,
          },
        }
        return
      }
    }
    const bindingBeta =
      profile.bindThinkingHistory &&
      nativeImagePolicy &&
      prepareAnthropicThinkingHistory(request, body)
    if (
      bindingBeta &&
      request.messages.some(
        (message) =>
          (message.role === "user" || message.role === "tool") &&
          message.content.some(
            (block) => block.type === "image" || block.type === "document",
          ),
      ) &&
      Buffer.byteLength(JSON.stringify(body), "utf8") >
        ANTHROPIC_REQUEST_MAX_BYTES
    )
      throw new AssetMediaError(
        "Media was not sent: thinking controls exceed the 32 MB Yakitori whole-request budget. Reduce other content; originals have not been changed.",
      )
    const effectiveThinking = body.thinking
    thinkingDisplay =
      isJsonObject(effectiveThinking) &&
      (effectiveThinking.display === "updates" ||
        effectiveThinking.display === "summarized")
        ? effectiveThinking.display
        : undefined
    const pendingRequest =
      bindingBeta ||
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
                ...(bindingBeta ? [thinkingBindingBeta] : []),
                ...(thinking?.effortBeta ? ["effort-2025-11-24"] : []),
              ],
            },
            request.signal === undefined
              ? undefined
              : { signal: request.signal },
          )
        : client.messages.create(
            body as MessageCreateParamsStreaming,
            request.signal === undefined && !thinking?.effortBeta
              ? undefined
              : {
                  ...(request.signal === undefined
                    ? {}
                    : { signal: request.signal }),
                  ...(thinking?.effortBeta
                    ? { headers: { "anthropic-beta": "effort-2025-11-24" } }
                    : {}),
                },
          )
    const wireResponse = await pendingRequest.withResponse()
    stream = wireResponse.data
    providerRequestId =
      wireResponse.response.headers.get("request-id") ??
      wireResponse.response.headers.get("x-request-id") ??
      undefined
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled" }
      return
    }
    if (
      error instanceof AssetMediaError ||
      error instanceof ModelRequestControlsError ||
      error instanceof ModelHistoryScopeError
    ) {
      yield {
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          provider: request.target.provider,
          wireApi: "anthropic_messages",
          message: error.message,
          ...(error instanceof ModelHistoryScopeError
            ? { providerCode: error.code }
            : {}),
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
  const thinkingChanges = new Set<string>()
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
        reportAnthropicThinkingChanges(
          nativeMetadata.input_transformations,
          request,
          thinkingChanges,
        )
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
        const hosted = anthropicHostedTool(event.content_block)
        if (hosted !== undefined) yield { type: "hosted_tool", tool: hosted }
        if (event.content_block.type === "redacted_thinking")
          yield {
            type: "reasoning_delta",
            text: "",
            format: "redacted",
            ...(request.streamOutputItems
              ? { itemId: `${message.id}_block_${event.index}` }
              : {}),
          }
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
            type: thinkingDisplay === "updates" ? "delta" : "reasoning_delta",
            text: event.delta.thinking,
            ...(thinkingDisplay === "updates"
              ? { purpose: "commentary" as const }
              : {
                  format:
                    thinkingDisplay === "summarized"
                      ? ("summary" as const)
                      : ("raw" as const),
                }),
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
            thinkingDisplay,
          ).content
        for (const block of pending.content ?? [])
          if (block.type === "hosted_tool")
            yield { type: "hosted_tool", tool: block }
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
              native: modelNativeItems(
                request,
                "anthropic_messages",
                canReplayAnthropicNativeBlock(
                  completed.block,
                  completed.completed,
                  completed.invalidInput,
                )
                  ? [completed.block]
                  : [],
              ),
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
        const transformations =
          "input_transformations" in event
            ? event.input_transformations
            : undefined
        nativeMetadata = {
          ...nativeMetadata,
          ...event.delta,
          usage: message.usage,
          ...(transformations === undefined
            ? {}
            : { input_transformations: transformations }),
        }
        reportAnthropicThinkingChanges(
          transformations,
          request,
          thinkingChanges,
        )
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
        const orderedBlocks = [...blocks.entries()].sort(
          ([left], [right]) => left - right,
        )
        const content = orderedBlocks.flatMap(([, pending]) =>
          pending.block.type === "tool_use" &&
          (!pending.completed || pending.invalidInput)
            ? []
            : [
                pending.block.type === "thinking" && !pending.completed
                  ? { ...pending.block, signature: undefined }
                  : pending.block,
              ],
        )
        const nativeBlocks = orderedBlocks.flatMap(([, pending]) =>
          canReplayAnthropicNativeBlock(
            pending.block,
            pending.completed,
            pending.invalidInput,
          )
            ? [pending.block]
            : [],
        )
        const response = fromAnthropicMessage(
          { ...message, content },
          customFallbackKeys,
          request.target.provider,
          request.continuationScope,
          thinkingDisplay,
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
          native: modelNativeItems(request, "anthropic_messages", nativeBlocks),
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
        "response_body",
        providerRequestId,
        message?.id,
      ),
      ...usageFields(),
    }
  }
}

// Live streams pass completion flags explicitly. Persisted native blocks have
// already crossed this boundary, but replay rechecks signatures and inputs.
function canReplayAnthropicNativeBlock(
  block: Record<string, unknown>,
  completed = true,
  invalidInput = false,
): boolean {
  if (block.type === "thinking")
    return (
      completed &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    )
  if (block.type === "tool_use" || block.type === "server_tool_use")
    return completed && !invalidInput && isJsonValue(block.input)
  return true
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
          : native.flatMap((block) =>
              canReplayAnthropicNativeBlock(block)
                ? [block as unknown as BetaContentBlockParam]
                : [],
            )
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

function toAnthropicSystem(
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
): void {
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
      return
    }
  }
}

function anthropicHostedTool(value: unknown): HostedToolBlock | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  const call = value.type === "server_tool_use"
  if (!call && !value.type.endsWith("_tool_result")) return undefined
  const id = call ? value.id : value.tool_use_id
  if (typeof id !== "string" || id.length === 0) return undefined
  const name = call && typeof value.name === "string" ? value.name : value.type
  const kind: HostedToolBlock["kind"] = name.startsWith("web_search")
    ? "web_search"
    : name.startsWith("web_fetch")
      ? "web_fetch"
      : name.includes("code_execution")
        ? "code_execution"
        : "lookup"
  const input = isRecord(value.input) ? value.input : {}
  const payload = value.content
  const result = isRecord(payload) ? payload : {}
  const label = input.query ?? input.url
  const detail = Array.isArray(payload)
    ? payload
        .flatMap((item) =>
          isRecord(item) && typeof item.url === "string" ? [item.url] : [],
        )
        .join("\n")
    : [
        input.command,
        input.code,
        result.url,
        result.stdout,
        result.stderr,
        result.error_code,
      ]
        .filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        )
        .join("\n")
  const failed =
    typeof result.error_code === "string" ||
    (typeof result.return_code === "number" && result.return_code !== 0)
  return {
    type: "hosted_tool",
    id,
    kind,
    status: call ? "running" : failed ? "failed" : "completed",
    ...(typeof label === "string" && label.length > 0 ? { label } : {}),
    ...(detail ? { detail } : {}),
  }
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
  thinkingDisplay?: "summarized" | "updates",
): ModelResponse {
  const content: ModelContentBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block))
      throw new AnthropicProtocolError("Invalid Anthropic content block.")
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const signature =
        typeof block.signature === "string" && block.signature.length > 0
          ? block.signature
          : undefined
      const redacted = block.thinking === "" && signature !== undefined
      const presentation =
        !redacted && thinkingDisplay === "updates"
          ? ({ type: "text", purpose: "commentary" } as const)
          : ({
              type: "reasoning",
              format: redacted
                ? "redacted"
                : thinkingDisplay === "summarized"
                  ? "summary"
                  : "raw",
            } as const)
      content.push({
        ...presentation,
        text: block.thinking,
        ...(signature !== undefined
          ? {
              providerMetadata: {
                anthropic: {
                  provider,
                  ...(continuationScope === undefined
                    ? {}
                    : { scope: continuationScope }),
                  signature,
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
        format: "redacted",
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
      const annotations = anthropicCitations(block.citations)
      content.push({
        type: "text",
        text: block.text,
        ...(annotations.length === 0 ? {} : { annotations }),
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
    const hosted = anthropicHostedTool(block)
    if (hosted !== undefined) {
      content.push(hosted)
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
  block: ReturnType<typeof portableModelContent>[number],
  provider: string,
  continuationScope?: string,
): BetaContentBlockParam | undefined {
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

// Mid-stream SSE error events carry no HTTP status; these error types are the
// transient ones worth retrying.
const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

import type { HostedToolBlock } from "../protocol/hosted-tool.ts"
