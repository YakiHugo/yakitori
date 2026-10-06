import { randomUUID } from "node:crypto"
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../kernel/index.ts"
import {
  flattenModelSystem,
  type ModelContentBlock,
  type ModelFailureStage,
  type ModelMessage,
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelUsage,
  requireModelImageData,
  requireModelDocumentData,
  type StreamFn,
} from "./model.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
} from "./model-failure.ts"
import {
  GEMINI_INLINE_REQUEST_MAX_BYTES,
  supportsGeminiToolPdf,
  supportsGeminiUserPdf,
} from "./native-pdf-capabilities.ts"
import { parseRetryAfterMs } from "./retry-after.ts"

export type GeminiProviderOptions = Readonly<{
  apiKey: string
  model: string
  baseURL: string
  fetchFn?: typeof fetch
}>

type GeminiContent = { role: "user" | "model"; parts: JsonObject[] }
class GeminiProtocolError extends Error {}
class GeminiIncompleteStreamError extends Error {}
class GeminiInlineRequestSizeError extends Error {
  constructor() {
    super(
      "The Gemini request exceeds the 100 MB inline limit. Retry with fewer PDF pages, smaller attachments or less request content.",
    )
  }
}

// GenerateContent owns complete parts, unlike OpenAI argument deltas. Keep each
// returned part intact: signatures can be attached even to an empty text part.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export function createGeminiProvider(options: GeminiProviderOptions): StreamFn {
  return (request) => streamGemini(options, request)
}

async function* streamGemini(
  options: GeminiProviderOptions,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield { type: "cancelled" }
    return
  }
  let stage: ModelFailureStage = "request_build"
  let usage: ModelUsage | undefined
  let response: Response | undefined
  let providerRequestId: string | undefined
  try {
    if (request.compaction === "remote_v2")
      throw new GeminiProtocolError(
        "Gemini does not support remote compaction.",
      )
    const model = request.target.model || options.model
    const modelId = model.replace(/^models\//, "")
    if (!/^[a-zA-Z0-9._-]+$/.test(modelId))
      throw new GeminiProtocolError("Invalid Gemini model ID.")
    const contents = toGeminiContents(
      request.messages,
      request.target.provider,
      request.continuationScope,
      model,
    )
    const system = flattenModelSystem(request.system)
    const customKeys = new Map(
      request.tools.flatMap((tool) => {
        if (tool.kind !== "custom") return []
        if (tool.customInputFallbackKey === undefined)
          throw new GeminiProtocolError("Custom tools require a JSON fallback.")
        return [[tool.name, tool.customInputFallbackKey] as const]
      }),
    )
    const generationConfig: Record<string, JsonValue> = { candidateCount: 1 }
    if (request.maxOutputTokens !== undefined)
      generationConfig.maxOutputTokens = request.maxOutputTokens
    if (request.target.effort !== undefined) {
      if (!["minimal", "low", "medium", "high"].includes(request.target.effort))
        throw new GeminiProtocolError("Unsupported Gemini thinking level.")
      generationConfig.thinkingConfig = { thinkingLevel: request.target.effort }
    }
    const url = new URL(
      `${options.baseURL.replace(/\/$/, "")}/models/${modelId}:streamGenerateContent`,
    )
    url.searchParams.set("alt", "sse")
    const body = JSON.stringify({
      contents,
      ...(system === ""
        ? {}
        : { systemInstruction: { parts: [{ text: system }] } }),
      generationConfig,
      ...(request.tools.length === 0
        ? {}
        : {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.inputSchema,
                })),
              },
            ],
          }),
    })
    // Check the complete serialized UTF-8 request, including text, tools and
    // base64 expansion. Per-document raw limits alone do not bound this body.
    if (
      request.messages.some(
        (message) =>
          ((message.role === "tool" && supportsGeminiToolPdf(model)) ||
            (message.role === "user" && supportsGeminiUserPdf(model))) &&
          message.content.some((block) => block.type === "document"),
      ) &&
      Buffer.byteLength(body, "utf8") > GEMINI_INLINE_REQUEST_MAX_BYTES
    )
      throw new GeminiInlineRequestSizeError()
    stage = "connect"
    response = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    stage = "response_headers"
    providerRequestId = response.headers.get("x-request-id") ?? undefined
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("Gemini HTTP request failed.")
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream") ||
      response.body === null
    )
      throw new GeminiProtocolError("Gemini did not return an SSE body.")
    stage = "response_body"
    const content: ModelContentBlock[] = []
    const ids = new Set<string>()
    const itemId = `gemini_${randomUUID()}`
    let finishReason: string | undefined
    let blocked = false
    for await (const payload of geminiSse(response.body)) {
      if (request.signal?.aborted) {
        yield { type: "cancelled", ...(usage === undefined ? {} : { usage }) }
        return
      }
      if (!isJsonObject(payload))
        throw new GeminiProtocolError("Invalid Gemini response.")
      if (payload.error !== undefined) {
        // API status errors inside a successful SSE connection are still errors.
        const error = payload.error
        const status =
          isJsonObject(error) && typeof error.code === "number"
            ? error.code
            : undefined
        yield {
          type: "failure",
          failure: modelFailureFromUnknown(error, {
            provider: request.target.provider,
            wireApi: "gemini_generate_content",
            stage: "model_event",
            fallbackMessage: "Gemini returned a stream error.",
            kind: failureKindForStatus(status),
            ...(status === undefined ? {} : { status }),
          }),
          ...(usage === undefined ? {} : { usage }),
        }
        return
      }
      if (payload.usageMetadata !== undefined) {
        usage = geminiUsage(payload.usageMetadata)
        request.onUsageSnapshot?.(usage)
      }
      if (typeof payload.responseId === "string")
        providerRequestId ??= payload.responseId
      if (
        isJsonObject(payload.promptFeedback) &&
        typeof payload.promptFeedback.blockReason === "string"
      ) {
        blocked = true
        finishReason = payload.promptFeedback.blockReason
      }
      if (payload.candidates === undefined) continue
      if (!Array.isArray(payload.candidates) || payload.candidates.length > 1)
        throw new GeminiProtocolError("Invalid Gemini candidates.")
      for (const candidate of payload.candidates) {
        if (
          !isJsonObject(candidate) ||
          (candidate.index !== undefined && candidate.index !== 0) ||
          finishReason !== undefined
        )
          throw new GeminiProtocolError("Unexpected Gemini candidate.")
        if (candidate.content !== undefined) {
          if (
            !isJsonObject(candidate.content) ||
            (candidate.content.role !== undefined &&
              candidate.content.role !== "model") ||
            !Array.isArray(candidate.content.parts)
          )
            throw new GeminiProtocolError("Invalid Gemini content.")
          for (const part of candidate.content.parts) {
            if (
              !isJsonObject(part) ||
              (part.thoughtSignature !== undefined &&
                typeof part.thoughtSignature !== "string") ||
              (part.thought !== undefined &&
                typeof part.thought !== "boolean") ||
              [
                "inlineData",
                "fileData",
                "functionResponse",
                "executableCode",
                "codeExecutionResult",
                "toolCall",
                "toolResponse",
              ].some((key) => part[key] !== undefined)
            )
              throw new GeminiProtocolError(
                "Invalid or unsupported Gemini part.",
              )
            const metadata = {
              gemini: {
                provider: request.target.provider,
                model,
                ...(request.continuationScope === undefined
                  ? {}
                  : { scope: request.continuationScope }),
                part,
              },
            }
            if (
              typeof part.text === "string" &&
              part.functionCall === undefined
            ) {
              const type = part.thought === true ? "reasoning" : "text"
              content.push({
                type,
                text: part.text,
                providerMetadata: metadata,
              })
              if (part.text !== "")
                yield {
                  type: type === "text" ? "delta" : "reasoning_delta",
                  text: part.text,
                  ...(request.streamOutputItems ? { itemId } : {}),
                }
            } else if (
              isJsonObject(part.functionCall) &&
              part.text === undefined
            ) {
              const call = part.functionCall
              if (
                typeof call.name !== "string" ||
                call.name === "" ||
                (call.args !== undefined && !isJsonObject(call.args)) ||
                (call.id !== undefined &&
                  (typeof call.id !== "string" || call.id === "")) ||
                call.partialArgs !== undefined ||
                call.willContinue !== undefined
              )
                throw new GeminiProtocolError(
                  "Invalid or partial Gemini function call.",
                )
              const id =
                typeof call.id === "string"
                  ? call.id
                  : `gemini_call_${randomUUID()}`
              if (ids.has(id))
                throw new GeminiProtocolError("Duplicate Gemini call ID.")
              ids.add(id)
              const args = call.args ?? {}
              const key = customKeys.get(call.name)
              if (key !== undefined && typeof args[key] !== "string")
                throw new GeminiProtocolError("Invalid custom function input.")
              content.push({
                type: "tool_call",
                id,
                name: call.name,
                input: key === undefined ? args : (args[key] as string),
                ...(key === undefined
                  ? {}
                  : { toolKind: "custom", customInputFallbackKey: key }),
                providerMetadata: metadata,
              })
            } else {
              // Audio/video, generated images, and built-in tools need explicit
              // canonical support; do not silently report a successful response.
              throw new GeminiProtocolError("Unsupported Gemini output part.")
            }
          }
        }
        if (candidate.finishReason !== undefined) {
          if (
            typeof candidate.finishReason !== "string" ||
            candidate.finishReason === "FINISH_REASON_UNSPECIFIED"
          )
            throw new GeminiProtocolError("Invalid Gemini finish reason.")
          finishReason = candidate.finishReason
        }
      }
    }
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...(usage === undefined ? {} : { usage }) }
      return
    }
    if (finishReason === undefined)
      throw new GeminiIncompleteStreamError(
        "Gemini stream ended without completion.",
      )
    const filtered =
      blocked ||
      [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "IMAGE_RECITATION",
      ].includes(finishReason)
    if (!filtered && !["STOP", "MAX_TOKENS"].includes(finishReason))
      throw new GeminiProtocolError(
        "Gemini could not complete a valid response.",
      )
    // Only a natural completed response may execute functions. A truncated or
    // filtered response never commits a possibly incomplete tool batch.
    const incompleteToolCalls =
      finishReason !== "STOP" &&
      content.some((block) => block.type === "tool_call")
    const completed = incompleteToolCalls
      ? content.filter((block) => block.type !== "tool_call")
      : content
    const stopReason = filtered
      ? ModelStopReason.ContentFilter
      : finishReason === "MAX_TOKENS"
        ? ModelStopReason.Length
        : completed.some((block) => block.type === "tool_call")
          ? ModelStopReason.ToolUse
          : ModelStopReason.EndTurn
    if (request.streamOutputItems && completed.length > 0)
      yield { type: "output_item", itemId, content: completed }
    yield {
      type: "response",
      response: {
        stopReason,
        rawStopReason: finishReason,
        content: completed,
        ...(finishReason === "MAX_TOKENS" ? { lengthReason: "output" } : {}),
        ...(incompleteToolCalls ? { incompleteToolCalls: true } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      },
    }
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...(usage === undefined ? {} : { usage }) }
      return
    }
    if (error instanceof GeminiInlineRequestSizeError) {
      yield {
        type: "failure",
        failure: {
          provider: request.target.provider,
          wireApi: "gemini_generate_content",
          stage: "request_build",
          kind: "invalid_request",
          message: error.message,
        },
      }
      return
    }
    const status =
      response !== undefined && !response.ok ? response.status : undefined
    const retryAfterMs = parseRetryAfterMs(response?.headers)
    yield {
      type: "failure",
      failure: modelFailureFromUnknown(error, {
        provider: request.target.provider,
        wireApi: "gemini_generate_content",
        stage: error instanceof SyntaxError ? "sse_decode" : stage,
        fallbackMessage: "Gemini request failed.",
        kind:
          status !== undefined
            ? failureKindForStatus(status)
            : error instanceof GeminiProtocolError ||
                error instanceof SyntaxError
              ? "protocol_error"
              : error instanceof GeminiIncompleteStreamError
                ? "stream_disconnected"
                : stage === "connect"
                  ? "connection_failed"
                  : "stream_disconnected",
        ...(status === undefined ? {} : { status }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      }),
      ...(usage === undefined ? {} : { usage }),
      cause: error,
    }
  }
}

export function toGeminiContents(
  messages: readonly ModelMessage[],
  provider: string,
  scope?: string,
  model?: string,
): GeminiContent[] {
  const contents: GeminiContent[] = []
  const calls = new Map<string, { name: string; id?: string }>()
  // GenerateContent documents nested multimodal function responses for Gemini 3.
  // Do not infer this capability for aliases or older/future model families.
  // https://ai.google.dev/gemini-api/docs/generate-content/function-calling#multimodal
  const nativeToolImages = /^(?:models\/)?gemini-3(?:[.-]|$)/.test(model ?? "")
  const nativeToolPdfs = supportsGeminiToolPdf(model ?? "")
  let toolResultIndex = 0
  for (const message of messages) {
    if (message.role === "tool") {
      const call = calls.get(message.toolCallId)
      if (call === undefined)
        throw new GeminiProtocolError("Unmatched Gemini tool result.")
      calls.delete(message.toolCallId)
      const resultIndex = toolResultIndex++
      const media: JsonObject[] = []
      let imageIndex = 0
      let pdfIndex = 0
      const fallbackImages: JsonObject[] = []
      const ordered = message.content.map((block, index): JsonValue => {
        if (block.type === "text") return { text: block.text }
        if (block.type === "document") {
          if (!nativeToolPdfs)
            return {
              text: `[Document ${block.name} was not sent: native PDF input is not enabled for Gemini.]`,
            }
          if (block.data === undefined)
            throw new GeminiProtocolError(
              "Model request contains an unresolved Session PDF.",
            )
          const displayName = `tool_${resultIndex}_pdf_${pdfIndex++}`
          media.push({
            inlineData: {
              mimeType: "application/pdf",
              displayName,
              data: block.data,
            },
          })
          return { $ref: displayName }
        }
        if (!nativeToolImages) {
          const label = `Image from tool ${call.name}, call ${message.toolCallId}, content part ${index + 1}`
          fallbackImages.push(
            { text: `[${label}]` },
            {
              inlineData: {
                mimeType: block.mediaType,
                data: requireModelImageData(block),
              },
            },
          )
          return { text: `[${label}; image follows the function response.]` }
        }
        if (
          block.mediaType !== "image/png" &&
          block.mediaType !== "image/jpeg" &&
          block.mediaType !== "image/webp"
        )
          throw new GeminiProtocolError(
            `Gemini 3 function responses do not support ${block.mediaType}; use PNG, JPEG or WebP.`,
          )
        const displayName = `tool_${resultIndex}_image_${imageIndex++}`
        media.push({
          inlineData: {
            mimeType: block.mediaType,
            displayName,
            data: requireModelImageData(block),
          },
        })
        return { $ref: displayName }
      })
      // Response JSON owns the ordered descriptors; binary parts are referenced
      // once at their source position, never promoted to user-authored text.
      const output = message.content.every((block) => block.type === "text")
        ? message.content.map((block) => block.text).join("\n")
        : ordered
      const parts: JsonObject[] = [
        {
          functionResponse: {
            ...call,
            response: message.isError ? { error: output } : { output },
            ...(media.length === 0 ? {} : { parts: media }),
          },
        },
        ...fallbackImages,
      ]
      const previous = contents.at(-1)
      // Parallel results must follow the entire model call batch together.
      if (
        previous?.role === "user" &&
        previous.parts.some((part) => part.functionResponse !== undefined)
      )
        previous.parts.push(...parts)
      else contents.push({ role: "user", parts })
    } else if (message.role === "assistant") {
      const parts: JsonObject[] = []
      for (const block of message.content) {
        if (block.type === "compaction")
          throw new GeminiProtocolError(
            "Opaque compaction cannot be sent to Gemini.",
          )
        const metadata = block.providerMetadata?.gemini
        const owned =
          isJsonObject(metadata) &&
          metadata.provider === provider &&
          scope !== undefined &&
          metadata.scope === scope &&
          metadata.model === model &&
          isJsonObject(metadata.part)
            ? metadata.part
            : undefined
        if (block.type === "tool_call") {
          if (calls.has(block.id))
            throw new GeminiProtocolError("Duplicate tool history ID.")
          const input =
            block.toolKind === "custom" &&
            block.customInputFallbackKey !== undefined
              ? { [block.customInputFallbackKey]: block.input }
              : block.input
          if (!isJsonObject(input))
            throw new GeminiProtocolError(
              "Gemini function input must be an object.",
            )
          const nativeCall = owned?.functionCall
          calls.set(block.id, {
            name: block.name,
            ...(isJsonObject(nativeCall) && typeof nativeCall.id === "string"
              ? { id: nativeCall.id }
              : {}),
          })
          // Google documents this sentinel for foreign function-call traces.
          // Never reuse a real signature across credential/model boundaries.
          parts.push(
            owned ?? {
              functionCall: { name: block.name, args: input },
              thoughtSignature: "skip_thought_signature_validator",
            },
          )
        } else if (owned !== undefined) parts.push(owned)
        else if (block.type === "text") parts.push({ text: block.text })
      }
      if (parts.length > 0) contents.push({ role: "model", parts })
    } else {
      const parts: JsonObject[] = message.content.map((block) => {
        if (block.type === "text") return { text: block.text }
        if (block.type === "document") {
          if (!supportsGeminiUserPdf(model ?? ""))
            return {
              text: `[Document ${block.name} was not sent: native PDF input is not enabled for Gemini.]`,
            }
          return {
            inlineData: {
              mimeType: "application/pdf",
              data: requireModelDocumentData(block),
            },
          }
        }
        return {
          inlineData: {
            mimeType: block.mediaType,
            data: requireModelImageData(block),
          },
        }
      })
      // Later developer messages are history instructions, not the top-level
      // system prompt; retain their position rather than hoist across turns.
      if (message.role === "developer")
        parts.unshift({ text: "[Developer instruction]" })
      contents.push({ role: "user", parts })
    }
  }
  return contents
}

function geminiUsage(value: unknown): ModelUsage {
  if (!isJsonObject(value))
    throw new GeminiProtocolError("Invalid Gemini usage.")
  for (const key of [
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "totalTokenCount",
    "cachedContentTokenCount",
  ])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0)
    )
      throw new GeminiProtocolError("Invalid Gemini token count.")
  const prompt = value.promptTokenCount as number | undefined
  const output = value.candidatesTokenCount as number | undefined
  const thoughts = value.thoughtsTokenCount as number | undefined
  const total = value.totalTokenCount as number | undefined
  const cached = value.cachedContentTokenCount as number | undefined
  return {
    ...(prompt === undefined ? {} : { inputTokens: prompt }),
    ...(output === undefined && thoughts === undefined
      ? {}
      : { outputTokens: (output ?? 0) + (thoughts ?? 0) }),
    ...(total === undefined ? {} : { activeContextTokens: total }),
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  }
}

async function* geminiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  let data: string[] = []
  // Local memory-safety boundary for malformed/unbounded SSE events, not a
  // Gemini product quota. This adapter only requests text and tool arguments.
  const maxEventCharacters = 16 * 1024 * 1024
  let eventCharacters = 0
  try {
    while (true) {
      const next = await reader.read()
      buffer += next.done
        ? decoder.decode()
        : decoder.decode(next.value, { stream: true })
      if (buffer.length + eventCharacters > maxEventCharacters)
        throw new GeminiProtocolError(
          "Gemini SSE event exceeds safety boundary.",
        )
      while (true) {
        const end = buffer.search(/[\r\n]/)
        if (end === -1) break
        if (buffer[end] === "\r" && end === buffer.length - 1 && !next.done)
          break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(
          end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1),
        )
        if (line === "") {
          if (data.length > 0) yield JSON.parse(data.join("\n"))
          data = []
          eventCharacters = 0
        } else if (line === "data" || line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "")
          data.push(value)
          eventCharacters += value.length
          if (eventCharacters > maxEventCharacters)
            throw new GeminiProtocolError(
              "Gemini SSE event exceeds safety boundary.",
            )
        }
      }
      if (next.done) {
        if (buffer.trim() !== "" || data.length > 0)
          throw new GeminiIncompleteStreamError("Truncated Gemini SSE event.")
        return
      }
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
