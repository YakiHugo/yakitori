import OpenAI, { type ClientOptions, toFile } from "openai"
import type {
  Tool as OpenAITool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputMessage,
  ResponseOutputText,
} from "openai/resources/responses/responses"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue } from "../kernel/index.ts"
import { supportsOpenAIRequestWarmup } from "../shared/request-warmup-policy.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import {
  requireChatGPTPlanNamespace,
  toChatGPTPlanRequest,
} from "./chatgpt-plan-request.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import {
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelStreamFailureEvent,
  requireModelDocumentData,
  requireModelImageData,
  type StreamFn,
} from "./model.ts"
import { resolveModelWireEffort } from "./model-catalog.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import { createOpenAIResponsesTransport } from "./openai-responses-transport.ts"
import { createFileUploadCache } from "./provider-file-cache.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"

export type OpenAIProviderOptions = {
  readonly warmup?: boolean
  readonly requestProfile?: "chatgpt-plan"
  readonly apiKey: string
  readonly model: string
  readonly client?: OpenAI
  // Compatible endpoints (e.g. xAI at https://api.x.ai/v1) override the default.
  readonly baseURL?: string
  // Extra per-endpoint identity headers (e.g. chatgpt-account-id for the
  // codex ChatGPT backend).
  readonly defaultHeaders?: Record<string, string>
  readonly onResponseHeaders?: (headers: Headers) => void
  readonly fetchOptions?: ClientOptions["fetchOptions"]
}

export function createOpenAIProvider(options: OpenAIProviderOptions): StreamFn {
  const client = openAIClient(options)
  return (request) =>
    streamOpenAI(
      client,
      options.model,
      request,
      options.onResponseHeaders,
      undefined,
      false,
      options.requestProfile,
      undefined,
    )
}

// Opt-in API-only transport. Unsupported endpoints retain ordinary HTTP and
// expose no warmup capability; never probe subscription or compatible backends.
export function createOpenAITurnTransport(options: OpenAIProviderOptions) {
  const client = openAIClient(options)
  const upload =
    URL.parse(client.baseURL)?.origin === "https://api.openai.com" &&
    options.requestProfile === undefined
      ? createFileUploadCache(
          async (document, bytes, signal) =>
            (
              await client.files.create(
                {
                  file: await toFile(bytes, document.name, {
                    type: document.mediaType,
                  }),
                  purpose: "user_data",
                },
                signal === undefined ? undefined : { signal },
              )
            ).id,
          (id) => client.files.delete(id),
        )
      : undefined
  const transport =
    options.warmup !== false &&
    options.requestProfile === undefined &&
    supportsOpenAIRequestWarmup(options.baseURL ?? client.baseURL)
      ? createOpenAIResponsesTransport(client)
      : undefined
  const stream: StreamFn = (request) =>
    streamOpenAI(
      client,
      options.model,
      request,
      options.onResponseHeaders,
      transport,
      false,
      options.requestProfile,
      upload,
    )
  return {
    stream,
    ...(transport === undefined
      ? {}
      : {
          warmup: ((request) =>
            streamOpenAI(
              client,
              options.model,
              request,
              options.onResponseHeaders,
              transport,
              true,
              options.requestProfile,
              upload,
            )) as StreamFn,
        }),
    async close() {
      transport?.close()
      await upload?.close()
    },
  }
}

function openAIClient(options: OpenAIProviderOptions): OpenAI {
  // SDK-internal retries stay disabled: the model request runtime owns policy.
  return (
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      fetchOptions: options.fetchOptions,
      maxRetries: 0,
    })
  )
}

async function* streamOpenAI(
  client: OpenAI,
  defaultModel: string,
  request: ModelRequest,
  onResponseHeaders?: (headers: Headers) => void,
  transport?: ReturnType<typeof createOpenAIResponsesTransport>,
  warmup = false,
  requestProfile?: "chatgpt-plan",
  upload?: ReturnType<typeof createFileUploadCache>,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield abortedResponse()
    return
  }

  let failureStage: "connect" | "response_body" = "connect"
  let terminalUsage: ModelResponse["usage"]
  let terminalEvent:
    | Extract<ModelStreamEvent, { type: "response" | "failure" }>
    | undefined
  try {
    const nativeDeferredLoading =
      requestProfile !== "chatgpt-plan" &&
      nativeDeferredToolProtocol(request) === "openai"
    const customFallbackKeys = customFallbackKeysForRequest(
      request,
      nativeDeferredLoading,
    )
    const media = await prepareProviderMedia(
      request,
      upload === undefined
        ? {}
        : {
            uploadDocument: (document, bytes) =>
              upload(document, bytes, request.signal),
          },
    )
    const effort = resolveModelWireEffort(request.target)
    let body: ResponseCreateParamsStreaming = {
      model: request.target.model || defaultModel,
      instructions: flattenModelSystem(request.system),
      input: [
        ...toOpenAIInput(
          media.messages,
          nativeDeferredLoading,
          request.target.provider,
          request.continuationScope,
          media.uploadedFiles,
        ),
        ...(request.compaction === "remote_v2"
          ? [{ type: "compaction_trigger" as const }]
          : []),
      ],
      tools: toOpenAITools(request.tools, nativeDeferredLoading),
      parallel_tool_calls: true,
      // The Codex subscription endpoint rejects max_output_tokens. Its
      // ResponsesApiRequest omits this API-only output control.
      ...(request.target.provider === "codex" ||
      request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
      store: false,
      stream: true,
      ...(request.cacheKey === undefined
        ? {}
        : { prompt_cache_key: request.cacheKey }),
      ...(effort === undefined &&
      !REASONING_SUMMARY_PROVIDERS.has(request.target.provider)
        ? {}
        : {
            reasoning: {
              ...(effort === undefined
                ? {}
                : { effort: effort as ReasoningEffort }),
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
    }
    if (requestProfile === "chatgpt-plan") body = toChatGPTPlanRequest(body)
    const warmed = warmup
      ? transport?.warmup(body, request.signal, request.continuationScope)
      : transport?.take(body, request.signal, request.continuationScope)
    if (warmup && warmed === undefined) return
    const stream =
      warmed ??
      (await (async () => {
        const pending = client.responses.create(
          body,
          request.signal === undefined ? undefined : { signal: request.signal },
        )
        return onResponseHeaders === undefined
          ? await pending
          : await pending.withResponse().then(({ data, response }) => {
              onResponseHeaders(response.headers)
              return data
            })
      })())
    if (stream === undefined)
      throw new OpenAIProtocolError("OpenAI returned no response stream.")
    failureStage = "response_body"
    const completedItems = new Map<number, Response["output"][number]>()
    const startedItems = new Map<number, Response["output"][number]>()
    const fragments = new Map<
      string,
      {
        outputIndex: number
        type: "message" | "reasoning"
        parts: Map<
          number,
          {
            type: "text" | "reasoning" | "refusal"
            text: string
            annotations?: ResponseOutputText["annotations"]
          }
        >
      }
    >()
    let nextOutputIndex = 0
    for await (const event of stream) {
      if (requestProfile === "chatgpt-plan") {
        if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.done"
        )
          requireChatGPTPlanNamespace(event.item)
        if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        )
          event.response.output?.forEach(requireChatGPTPlanNamespace)
      }
      // Cancellation suppresses content, not accounting already delivered by
      // the provider. Tool completion may abort a queued warmup terminal event.
      // Never replace the first terminal sample with contradictory tail data.
      if (
        terminalEvent === undefined &&
        (event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed")
      ) {
        terminalUsage = responseResult(
          event.response,
          ModelStopReason.EndTurn,
          [],
          request.target.provider,
        ).usage
        if (terminalUsage !== undefined)
          request.onUsageSnapshot?.(terminalUsage)
      }
      if (request.signal?.aborted) {
        yield abortedResponse(terminalUsage)
        return
      }
      if (terminalEvent !== undefined)
        throw new OpenAIProtocolError(
          "OpenAI returned an event after its terminal response.",
        )
      // These are semantic payloads, not ignorable progress notifications.
      // Their asset/native-reasoning contracts need dedicated IR support.
      if (
        event.type.startsWith("response.audio.") ||
        event.type.startsWith("response.image_generation_call.") ||
        event.type.startsWith("response.reasoning_text.")
      )
        throw new OpenAIProtocolError(
          `Unsupported OpenAI content event: ${event.type}.`,
        )
      if (
        (event.type === "response.content_part.added" ||
          event.type === "response.content_part.done") &&
        !["output_text", "refusal", "summary_text"].includes(event.part.type)
      )
        throw new OpenAIProtocolError(
          `Unsupported OpenAI content part: ${event.part.type}.`,
        )
      if (event.type === "response.output_item.added") {
        startedItems.set(event.output_index, event.item)
        continue
      }
      if (
        event.type === "response.output_text.delta" ||
        event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.refusal.delta"
      ) {
        const reasoning = event.type === "response.reasoning_summary_text.delta"
        if (event.item_id !== undefined && event.output_index !== undefined) {
          const partIndex = reasoning
            ? event.summary_index
            : event.content_index
          const item = fragments.get(event.item_id) ?? {
            outputIndex: event.output_index,
            type: reasoning ? ("reasoning" as const) : ("message" as const),
            parts: new Map<
              number,
              {
                type: "text" | "reasoning" | "refusal"
                text: string
                annotations?: ResponseOutputText["annotations"]
              }
            >(),
          }
          item.parts.set(partIndex, {
            ...item.parts.get(partIndex),
            type: reasoning
              ? "reasoning"
              : event.type === "response.refusal.delta"
                ? "refusal"
                : "text",
            text: (item.parts.get(partIndex)?.text ?? "") + event.delta,
          })
          fragments.set(event.item_id, item)
        }
        yield {
          type: reasoning ? "reasoning_delta" : "delta",
          text: event.delta,
          ...(request.streamOutputItems && event.item_id !== undefined
            ? { itemId: event.item_id }
            : {}),
        }
        continue
      }
      if (event.type === "response.output_text.annotation.added") {
        if (!isJsonObject(event.annotation))
          throw new OpenAIProtocolError("Invalid OpenAI annotation.")
        const fragment = fragments.get(event.item_id) ?? {
          outputIndex: event.output_index,
          type: "message" as const,
          parts: new Map<
            number,
            {
              type: "text" | "reasoning" | "refusal"
              text: string
              annotations?: ResponseOutputText["annotations"]
            }
          >(),
        }
        const part = fragment.parts.get(event.content_index) ?? {
          type: "text" as const,
          text: "",
        }
        const annotations = [...(part.annotations ?? [])]
        if (
          !Number.isInteger(event.annotation_index) ||
          event.annotation_index < 0 ||
          event.annotation_index > annotations.length
        )
          throw new OpenAIProtocolError("Invalid OpenAI annotation index.")
        annotations[event.annotation_index] =
          event.annotation as unknown as ResponseOutputText["annotations"][number]
        fragment.parts.set(event.content_index, { ...part, annotations })
        fragments.set(event.item_id, fragment)
        continue
      }
      if (event.type === "response.output_item.done") {
        if (completedItems.has(event.output_index)) continue
        completedItems.set(event.output_index, event.item)
        if (request.streamOutputItems && request.compaction === undefined) {
          // Preserve provider output order even when completed items arrive out of order.
          for (;;) {
            const item = completedItems.get(nextOutputIndex)
            if (
              item === undefined ||
              ("status" in item &&
                item.status !== undefined &&
                item.status !== "completed")
            )
              break
            const result = fromOpenAIOutput(
              [item],
              customFallbackKeys,
              request.target.provider,
              request.continuationScope,
              request.target.model,
              new Set([outputItemId(item)].filter((id) => id !== undefined)),
            )
            if (result.incompleteToolCalls) break
            nextOutputIndex += 1
            if (result.content.length > 0)
              yield {
                type: "output_item",
                itemId: item.id ?? `output_${nextOutputIndex - 1}`,
                content: result.content,
              }
          }
        }
        continue
      }
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        // Failed Responses envelopes may omit output and carry null usage.
        // Codex also sends completed items separately from terminal metadata.
        const terminalOutput = event.response.output ?? []
        if (warmup && terminalOutput.length !== 0)
          throw new OpenAIProtocolError(
            "Non-generating warmup unexpectedly produced output.",
          )
        // Codex sends completed items separately and may leave terminal
        // output empty. Preserve output_index order and merge by item id so
        // ordinary Responses endpoints cannot duplicate a tool side effect.
        const outputByIndex = new Map([...startedItems, ...completedItems])
        const completedIds = new Set(
          [...completedItems.values()]
            .filter(
              (item) =>
                !("status" in item) ||
                item.status === undefined ||
                item.status === "completed",
            )
            .flatMap((item) => {
              const id = outputItemId(item)
              return id === undefined ? [] : [id]
            }),
        )
        const authoritativeIds = new Set(
          [...completedItems.values(), ...terminalOutput].map(
            (item) => item.id,
          ),
        )
        for (const [index, item] of terminalOutput.entries()) {
          if (completedIds.has(outputItemId(item) ?? "")) continue
          const knownIndex = [...outputByIndex].find(
            ([, known]) => outputItemId(known) === outputItemId(item),
          )?.[0]
          const targetIndex =
            knownIndex ??
            (outputByIndex.has(index)
              ? Math.max(...outputByIndex.keys()) + 1
              : index)
          outputByIndex.set(targetIndex, item)
        }
        for (const [id, fragment] of fragments) {
          if (completedIds.has(id)) continue
          const item = outputByIndex.get(fragment.outputIndex)
          if (fragment.type === "reasoning") {
            const summary = new Map(
              (item?.type === "reasoning" ? item.summary : []).map(
                (part, index) => [index, part],
              ),
            )
            for (const [index, part] of fragment.parts) {
              if (authoritativeIds.has(id) && summary.get(index)?.text) continue
              summary.set(index, { type: "summary_text", text: part.text })
            }
            outputByIndex.set(fragment.outputIndex, {
              ...(item?.type === "reasoning"
                ? item
                : { id, type: "reasoning" as const }),
              summary: [...summary.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, part]) => part),
            })
          } else {
            const content = new Map(
              (item?.type === "message" ? item.content : []).map(
                (part, index) => [index, part],
              ),
            )
            for (const [index, part] of fragment.parts) {
              const retained = content.get(index)
              if (
                authoritativeIds.has(id) &&
                (retained?.type === "output_text"
                  ? retained.text.length > 0
                  : (retained?.refusal.length ?? 0) > 0)
              )
                continue
              content.set(
                index,
                part.type === "refusal"
                  ? { type: "refusal", refusal: part.text }
                  : {
                      type: "output_text",
                      text: part.text,
                      annotations: part.annotations ?? [],
                      logprobs: [],
                    },
              )
            }
            outputByIndex.set(fragment.outputIndex, {
              ...(item?.type === "message"
                ? item
                : {
                    id,
                    type: "message" as const,
                    role: "assistant" as const,
                    status: "incomplete" as const,
                  }),
              content: [...content.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, part]) => part),
            })
          }
        }
        const response = {
          ...event.response,
          output: [...outputByIndex.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => item),
        }
        const failure = responseFailure(response, request.target.provider)
        if (failure !== undefined) {
          terminalEvent = failure
        } else {
          terminalEvent = {
            type: "response",
            response: fromOpenAIResponse(
              response,
              customFallbackKeys,
              request.target.provider,
              request.continuationScope,
              request.target.model,
              completedIds,
            ),
          }
        }
        continue
      }
      if (event.type === "error") {
        const providerCode = event.code ?? "openai_error"
        yield {
          type: "failure",
          failure: modelFailureFromUnknown(undefined, {
            provider: request.target.provider,
            wireApi: "openai_responses",
            stage: "model_event",
            kind: failureKindForProviderCode(providerCode),
            providerCode,
            fallbackMessage: "OpenAI request failed.",
          }),
        }
        return
      }
    }
    // Responses terminal events precede stream EOF. Validate the tail before
    // exposing success or a Length eligible for compaction retry.
    if (request.signal?.aborted) {
      yield abortedResponse(terminalUsage)
      return
    }
    if (requestProfile === "chatgpt-plan" && terminalEvent === undefined) {
      yield {
        type: "failure",
        failure: modelFailureFromUnknown(undefined, {
          provider: request.target.provider,
          wireApi: "openai_responses",
          stage: "response_body",
          kind: "stream_disconnected",
          fallbackMessage: "ChatGPT stream ended without a terminal response.",
        }),
        ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
      }
      return
    }
    if (terminalEvent !== undefined) yield terminalEvent
  } catch (error) {
    if (request.signal?.aborted) {
      yield abortedResponse(terminalUsage)
      return
    }
    if (error instanceof AssetMediaError) {
      yield {
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          provider: request.target.provider,
          wireApi: "openai_responses",
          message: error.message,
        },
      }
      return
    }
    yield {
      ...terminalFailure(
        terminalEvent !== undefined && !(error instanceof OpenAIProtocolError)
          ? new OpenAIProtocolError(
              "OpenAI stream failed after its terminal response.",
              { cause: error },
            )
          : error,
        request.target.provider,
        failureStage,
      ),
      ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
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
  uploadedFiles: ReadonlyMap<
    import("./model.ts").ModelDocumentBlock,
    string
  > = new Map(),
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
      input.push({
        role: "user",
        content: message.content.every((block) => block.type === "text")
          ? message.content.map((block) => block.text).join("")
          : message.content.map((block) => {
              if (block.type === "text")
                return { type: "input_text" as const, text: block.text }
              if (block.type === "image")
                return {
                  type: "input_image" as const,
                  detail: block.detail ?? "high",
                  image_url:
                    block.file && "url" in block.file
                      ? block.file.url
                      : `data:${block.mediaType};base64,${requireModelImageData(block)}`,
                }
              const fileId = uploadedFiles.get(block)
              return {
                type: "input_file" as const,
                filename: block.name,
                ...(fileId !== undefined
                  ? { file_id: fileId }
                  : "url" in block.file
                    ? { file_url: block.file.url }
                    : {
                        file_data: `data:application/pdf;base64,${requireModelDocumentData(block)}`,
                      }),
              }
            }),
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
      const blocks = message.content.map((block) => {
        if (block.type === "text")
          return { type: "input_text" as const, text: block.text }
        if (block.type === "image")
          return {
            type: "input_image" as const,
            image_url:
              block.file && "url" in block.file
                ? block.file.url
                : `data:${block.mediaType};base64,${requireModelImageData(block)}`,
            detail: block.detail ?? ("high" as const),
          }
        const fileId = uploadedFiles.get(block)
        if (
          block.data === undefined &&
          !("url" in block.file) &&
          fileId === undefined
        )
          throw new Error("Unresolved document asset.")
        return {
          type: "input_file" as const,
          filename: block.name,
          ...(fileId !== undefined
            ? { file_id: fileId }
            : "url" in block.file
              ? { file_url: block.file.url }
              : { file_data: `data:application/pdf;base64,${block.data}` }),
        }
      })
      if (message.isError)
        blocks.unshift({ type: "input_text", text: "[tool_error]" })
      const output = blocks.every((block) => block.type === "input_text")
        ? blocks.map((block) => block.text).join("\n")
        : blocks
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
    let annotatedMessage: ResponseOutputMessage | undefined
    const flushText = () => {
      if (annotatedMessage !== undefined) {
        input.push(annotatedMessage)
        annotatedMessage = undefined
      }
      if (text.length > 0) input.push({ role: "assistant", content: text })
      text = ""
    }
    for (const block of message.content) {
      if (block.type === "compaction") {
        flushText()
        if (block.provider !== provider || block.scope !== continuationScope) {
          throw new Error(
            "Native compaction belongs to another provider or account; convert it through its owner before continuing.",
          )
        }
        input.push({
          type: "compaction",
          encrypted_content: block.encryptedContent,
          ...(block.id === undefined ? {} : { id: block.id }),
          ...(block.metadata === undefined
            ? {}
            : { internal_chat_message_metadata_passthrough: block.metadata }),
        })
        continue
      }
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
        const metadata = block.providerMetadata?.openai
        const part = isJsonObject(metadata) ? metadata.part : undefined
        // Preserve citation offsets and message phase without joining adjacent
        // parts. Opaque file references stay with the account that issued them.
        if (
          isJsonObject(metadata) &&
          metadata.provider === provider &&
          continuationScope !== undefined &&
          metadata.scope === continuationScope &&
          typeof metadata.messageId === "string" &&
          isJsonObject(part) &&
          ((part.type === "output_text" &&
            part.text === block.text &&
            Array.isArray(part.annotations)) ||
            (part.type === "refusal" && part.refusal === block.text))
        ) {
          if (annotatedMessage?.id !== metadata.messageId) {
            flushText()
            annotatedMessage = {
              type: "message",
              role: "assistant",
              id: metadata.messageId,
              status:
                metadata.status === "incomplete" ? "incomplete" : "completed",
              content: [],
              ...(metadata.phase === "commentary" ||
              metadata.phase === "final_answer"
                ? { phase: metadata.phase }
                : {}),
            }
          }
          annotatedMessage.content.push(
            part as unknown as ResponseOutputMessage["content"][number],
          )
        } else {
          if (annotatedMessage !== undefined) flushText()
          text += block.text
        }
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
  model = response.model,
  completedItemIds: ReadonlySet<string> = new Set(),
): ModelResponse {
  if (response.status === "cancelled") {
    throw new OpenAIProtocolError(
      "Cancelled OpenAI responses are not successful results.",
    )
  }
  if (response.status === "failed" || response.error) {
    throw new Error(response.error?.message ?? "OpenAI response failed.")
  }
  if (response.status !== "completed" && response.status !== "incomplete")
    throw new OpenAIProtocolError(
      `Unsupported OpenAI response status: ${response.status ?? "missing"}.`,
    )
  const rawStopReason: string | undefined = response.incomplete_details?.reason
  let stopReason: ModelStopReason | undefined
  let lengthReason: ModelResponse["lengthReason"]
  if (response.status === "incomplete") {
    if (rawStopReason === "max_output_tokens") {
      stopReason = ModelStopReason.Length
      // OpenAI uses this reason for both output and context exhaustion. Only
      // xAI distinguishes max_prompt_tokens, so do not infer OpenAI's cause.
      lengthReason = provider === "grok" ? "output" : "unknown"
    } else if (provider === "grok" && rawStopReason === "max_prompt_tokens") {
      stopReason = ModelStopReason.Length
      lengthReason = "context"
    } else if (provider === "grok" && rawStopReason === "max_time_limit") {
      stopReason = ModelStopReason.Length
      lengthReason = "unknown"
    } else if (rawStopReason === "content_filter") {
      stopReason = ModelStopReason.ContentFilter
    } else {
      throw new OpenAIProtocolError(
        `OpenAI response was incomplete: ${rawStopReason ?? "unknown"}.`,
      )
    }
  }
  const result = fromOpenAIOutput(
    response.output,
    customFallbackKeys,
    provider,
    continuationScope,
    model,
    response.status === "completed"
      ? new Set(
          response.output.flatMap((item) => {
            const id = outputItemId(item)
            return id === undefined ? [] : [id]
          }),
        )
      : completedItemIds,
  )
  if (
    result.incompleteToolCalls &&
    stopReason !== ModelStopReason.Length &&
    stopReason !== ModelStopReason.ContentFilter
  )
    throw new OpenAIProtocolError(
      "OpenAI returned incomplete tool arguments without a length or content filter stop.",
    )
  const refused = response.output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((part) => part.type === "refusal"),
  )
  stopReason ??= refused
    ? ModelStopReason.ContentFilter
    : result.content.some((block) => block.type === "tool_call")
      ? ModelStopReason.ToolUse
      : ModelStopReason.EndTurn
  return {
    ...responseResult(response, stopReason, result.content, provider),
    ...(rawStopReason === undefined
      ? refused
        ? { rawStopReason: "refusal" }
        : {}
      : { rawStopReason }),
    ...(lengthReason === undefined ? {} : { lengthReason }),
    ...(result.incompleteToolCalls ? { incompleteToolCalls: true } : {}),
  }
}

function outputItemId(item: Response["output"][number]): string | undefined {
  return (
    item.id ?? ("call_id" in item ? (item.call_id ?? undefined) : undefined)
  )
}

function fromOpenAIOutput(
  output: Response["output"],
  customFallbackKeys: ReadonlyMap<string, string>,
  provider: string,
  continuationScope: string | undefined,
  model: string,
  completedItemIds: ReadonlySet<string>,
): { content: ModelContentBlock[]; incompleteToolCalls: boolean } {
  const content: ModelContentBlock[] = []
  let incompleteToolCalls = false
  for (const item of output) {
    if (
      item.type === "function_call" ||
      item.type === "custom_tool_call" ||
      item.type === "tool_search_call"
    ) {
      const status = "status" in item ? item.status : undefined
      if (
        (status !== undefined && status !== "completed") ||
        (status === undefined &&
          !completedItemIds.has(outputItemId(item) ?? ""))
      ) {
        incompleteToolCalls = true
        continue
      }
    }
    if (item.type === "compaction") {
      if (
        continuationScope === undefined ||
        item.encrypted_content.length === 0
      ) {
        throw new Error(
          "Native compaction requires non-empty encrypted content and an account scope.",
        )
      }
      const metadata =
        "internal_chat_message_metadata_passthrough" in item
          ? item.internal_chat_message_metadata_passthrough
          : undefined
      content.push({
        type: "compaction",
        provider,
        model,
        scope: continuationScope,
        encryptedContent: item.encrypted_content,
        id: item.id,
        ...(isJsonObject(metadata) ? { metadata } : {}),
      })
      continue
    }
    if (item.type === "reasoning") {
      if ((item.content?.length ?? 0) > 0)
        throw new OpenAIProtocolError(
          "Unsupported OpenAI native reasoning content; summary reasoning remains supported.",
        )
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
      const preserveParts =
        item.phase != null ||
        item.content.some(
          (part) =>
            part.type === "refusal" ||
            (part.type === "output_text" &&
              Array.isArray(part.annotations) &&
              part.annotations.length > 0),
        )
      for (const part of item.content) {
        if (part.type !== "output_text" && part.type !== "refusal")
          throw new OpenAIProtocolError("Unsupported OpenAI message content.")
        if (
          part.type === "output_text" &&
          part.annotations != null &&
          !Array.isArray(part.annotations)
        )
          throw new OpenAIProtocolError("Invalid OpenAI annotations.")
        const projected =
          part.type === "output_text"
            ? {
                type: part.type,
                text: part.text,
                annotations: part.annotations ?? [],
              }
            : { type: part.type, refusal: part.refusal }
        if (!isJsonObject(projected))
          throw new OpenAIProtocolError(
            "Invalid OpenAI message content metadata.",
          )
        content.push({
          type: "text",
          text: part.type === "output_text" ? part.text : part.refusal,
          ...(preserveParts
            ? {
                providerMetadata: {
                  openai: {
                    provider,
                    ...(continuationScope === undefined
                      ? {}
                      : { scope: continuationScope }),
                    messageId: item.id,
                    status: item.status,
                    ...(item.phase == null ? {} : { phase: item.phase }),
                    part: projected,
                  },
                },
              }
            : {}),
        })
      }
      continue
    }
    if (item.type === "custom_tool_call") {
      if (typeof item.input !== "string") {
        incompleteToolCalls = true
        continue
      }
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
        throw new OpenAIProtocolError(
          "Unsupported or invalid server tool search output.",
        )
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
    if (item.type !== "function_call")
      throw new OpenAIProtocolError(
        `Unsupported OpenAI output type: ${item.type}.`,
      )

    let parsed: unknown
    try {
      parsed = JSON.parse(item.arguments)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      incompleteToolCalls = true
      continue
    }
    if (!isJsonValue(parsed)) {
      incompleteToolCalls = true
      continue
    }
    content.push({
      type: "tool_call",
      id: item.call_id,
      name: item.name,
      input: parsed,
    })
  }

  return { content, incompleteToolCalls }
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

function parseRolloutBudgetUnits(value: unknown): number {
  const units = typeof value === "number" ? value : Number.NaN
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(
      "Provider rollout budget units must be finite and non-negative.",
    )
  }
  return units
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
    ...(response.usage == null
      ? {}
      : {
          usage: {
            ...("codex_rollout_budget_units" in response.usage &&
            response.usage.codex_rollout_budget_units != null
              ? {
                  rolloutBudgetUnits: parseRolloutBudgetUnits(
                    response.usage.codex_rollout_budget_units,
                  ),
                }
              : {}),
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

function responseFailure(
  response: Response,
  provider: string,
): ModelStreamFailureEvent | undefined {
  if (
    response.status !== "cancelled" &&
    response.status !== "failed" &&
    (response.error === null || response.error === undefined)
  ) {
    return undefined
  }
  const providerCode =
    response.error?.code ??
    (response.status === "cancelled"
      ? "response_cancelled"
      : "openai_incomplete")
  return {
    type: "failure",
    failure: modelFailureFromUnknown(undefined, {
      provider,
      wireApi: "openai_responses",
      stage: "model_event",
      kind: failureKindForProviderCode(providerCode),
      providerCode,
      providerRequestId: response.id,
      fallbackMessage: "OpenAI request failed.",
    }),
    ...(response.usage == null
      ? {}
      : {
          usage: responseResult(response, ModelStopReason.EndTurn, [], provider)
            .usage,
        }),
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

class OpenAIProtocolError extends Error {}

function terminalFailure(
  error: unknown,
  provider: string,
  stage: "connect" | "response_body",
): ModelStreamFailureEvent {
  const status =
    error instanceof OpenAI.APIError && typeof error.status === "number"
      ? error.status
      : undefined
  const providerCode =
    error instanceof OpenAI.APIError && typeof error.code === "string"
      ? error.code
      : undefined
  const kind =
    error instanceof OpenAIProtocolError
      ? "protocol_error"
      : error instanceof OpenAI.APIConnectionError
        ? stage === "connect"
          ? "connection_failed"
          : "stream_disconnected"
        : status !== undefined
          ? failureKindForStatus(status)
          : providerCode === undefined
            ? undefined
            : failureKindForProviderCode(providerCode)
  const retryAfterMs =
    error instanceof OpenAI.APIError
      ? parseRetryAfterMs(error.headers)
      : undefined
  const serverShouldRetry =
    error instanceof OpenAI.APIError
      ? (parseShouldRetry(error.headers) ??
        (provider === "grok" && (status === 525 || status === 526)
          ? false
          : undefined))
      : undefined
  const providerRequestId =
    error instanceof OpenAI.APIError && typeof error.requestID === "string"
      ? error.requestID
      : undefined
  return {
    type: "failure",
    failure: modelFailureFromUnknown(error, {
      provider,
      wireApi: "openai_responses",
      stage,
      ...(kind === undefined ? {} : { kind }),
      fallbackMessage: "OpenAI request failed.",
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(serverShouldRetry === undefined ? {} : { serverShouldRetry }),
    }),
    cause: error,
  }
}

function failureKindForProviderCode(
  code: string,
): ReturnType<typeof failureKindForStatus> {
  if (code === "rate_limit_exceeded") return "rate_limited"
  if (code === "server_error") return "server_error"
  return "provider_error"
}

const REASONING_SUMMARY_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "codex",
])

function abortedResponse(usage?: ModelResponse["usage"]): ModelStreamEvent {
  return { type: "cancelled", ...(usage === undefined ? {} : { usage }) }
}
