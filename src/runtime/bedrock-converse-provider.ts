import { isDeepStrictEqual } from "node:util"
import { Agent, fetch as bedrockFetch } from "undici"
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../kernel/index.ts"
import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
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
  validateModelHistoryScope,
} from "./model-native.ts"
import { validateModelImage } from "./prepare-model-image.ts"
import {
  flattenModelSystem,
  ModelStopReason,
  requireModelImageData,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"

const WIRE = "bedrock_converse"
const ENDPOINT = "https://bedrock-runtime.us-east-1.amazonaws.com"
const MODEL = "us.amazon.nova-2-lite-v1:0"
// Nova 2's inline limit is stricter than generic Converse's 20 images.
// https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-multimodal-models.html
const MAX_IMAGES = 5
const MAX_BODY_BYTES = 25_000_000
// Converse Message restricts each image to 3.75 MB and 8000px per edge.
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
const MAX_IMAGE_BYTES = 3_750_000
class BedrockProtocolError extends Error {}

type BufferedResponse = Response | Awaited<ReturnType<typeof bedrockFetch>>
type Options = Readonly<{
  apiKey: string
  baseURL: string
  model: string
  fetchFn?: (
    url: string,
    init: {
      method: "POST"
      headers: Record<string, string>
      body: string
      signal: AbortSignal | null
      redirect: "error"
      dispatcher: Agent
    },
  ) => Promise<BufferedResponse>
}>
type Message = { role: "user" | "assistant"; content: JsonObject[] }

// Intentionally buffered Converse, not SSE or AWS binary EventStream. The
// harness owns tools, cancellation and retries; no AWS credentials are read.
export function createBedrockConverseProvider(options: Options): StreamFn {
  return (request) => streamBedrock(options, request)
}

async function* streamBedrock(
  options: Options,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  let stage: "request_build" | "connect" | "response_body" = "request_build"
  let usage: ModelUsage | undefined
  let response: BufferedResponse | undefined
  let dispatcher: Agent | undefined
  try {
    request.signal?.throwIfAborted()
    validateModelHistoryScope(request, WIRE)
    if (
      options.baseURL.replace(/\/$/, "") !== ENDPOINT ||
      !options.apiKey.trim()
    )
      throw new BedrockProtocolError(
        "Nova requires a us-east-1 Bedrock bearer API key and the official us-east-1 Runtime endpoint.",
      )
    const model = request.target.model || options.model
    if (model !== MODEL)
      throw new BedrockProtocolError(
        "This adapter supports only us.amazon.nova-2-lite-v1:0.",
      )
    if (request.compaction && request.compaction !== "local")
      throw new BedrockProtocolError("Bedrock supports local compaction only.")
    if (
      (request.target.effort && request.target.effort !== "none") ||
      request.target.speed
    )
      throw new BedrockProtocolError(
        "This Nova adapter supports reasoning off and default speed only.",
      )
    if (
      request.providerOptions ||
      request.outputFormat ||
      request.parallelToolCalls === false
    )
      throw new BedrockProtocolError(
        "Native controls, structured output and enforced serial tool calls are not supported by this Nova adapter.",
      )
    if (!["eager", "meta_dispatch"].includes(request.toolWireProtocol))
      throw new BedrockProtocolError(
        "Bedrock requires ordinary JSON function tools.",
      )
    const imageCount = request.messages.reduce(
      (sum, message) =>
        sum +
        (message.role === "user" || message.role === "tool"
          ? message.content.filter((block) => block.type === "image").length
          : 0),
      0,
    )
    if (imageCount > MAX_IMAGES)
      throw new AssetMediaError(
        "Nova inline requests support at most 5 image occurrences. Send fewer images; originals have not been changed.",
      )
    if (
      request.messages.some(
        (message) =>
          (message.role === "user" || message.role === "tool") &&
          message.content.some((block) => block.type === "document"),
      )
    )
      throw new BedrockProtocolError(
        "Native documents are not supported by this Nova adapter.",
      )
    const customKeys = new Map<string, string>()
    for (const tool of request.tools) {
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        tool.kind === "tool_search" ||
        tool.deferLoading
      )
        throw new BedrockProtocolError(
          "Invalid or deferred Bedrock tool definition.",
        )
      if (tool.kind === "custom") {
        if (!tool.customInputFallbackKey)
          throw new BedrockProtocolError(
            "Custom tools require a JSON fallback.",
          )
        customKeys.set(tool.name, tool.customInputFallbackKey)
      }
    }
    const prepared = await prepareProviderMedia(request, {
      inlineImageUrls: true,
      async prepareImage(bytes, block) {
        if (bytes.length > MAX_IMAGE_BYTES)
          throw new AssetMediaError(
            "Image exceeds Converse's 3.75 MB per-image limit. Resize a copy; the original has not been changed.",
          )
        const metadata = inspectImageBytes(bytes)
        if (metadata.width > 8000 || metadata.height > 8000)
          throw new AssetMediaError(
            "Image exceeds Converse's 8000px edge limit. Resize a copy; the original has not been changed.",
          )
        await validateModelImage(bytes, request.signal)
        return {
          type: "image",
          mediaType: metadata.mediaType,
          detail: block.detail ?? "high",
          data: bytes.toString("base64"),
        }
      },
    })
    const body: Record<string, JsonValue> = {
      messages: buildMessages(prepared.messages, request),
      ...(request.system.length
        ? { system: [{ text: flattenModelSystem(request.system) }] }
        : {}),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { inferenceConfig: { maxTokens: request.maxOutputTokens } }),
    }
    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens < 1 ||
        request.maxOutputTokens > 65_000)
    )
      throw new BedrockProtocolError(
        "Nova output token limit must be an integer from 1 to 65000.",
      )
    if (request.toolChoice !== "none" && request.tools.length) {
      const choice = request.toolChoice
      if (
        typeof choice === "object" &&
        !request.tools.some((tool) => tool.name === choice.name)
      )
        throw new BedrockProtocolError(
          "Requested tool is absent from the captured tool plan.",
        )
      body.toolConfig = {
        tools: request.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.inputSchema },
          },
        })),
        toolChoice:
          typeof choice === "object"
            ? { tool: { name: choice.name } }
            : choice === "required"
              ? { any: {} }
              : { auto: {} },
      }
    } else if (
      request.toolChoice === "required" ||
      typeof request.toolChoice === "object"
    ) {
      throw new BedrockProtocolError(
        "Tool choice requires a nonempty tool plan.",
      )
    }
    if (jsonRequestByteLength(body, MAX_BODY_BYTES) === undefined)
      throw new AssetMediaError(
        "Nova request exceeds the 25 MB encoded JSON budget. Send fewer images or less history; originals have not been changed.",
      )
    stage = "connect"
    // Node fetch otherwise imposes a shorter headers timeout than Nova's
    // documented 60-minute inference window. This request owns its pool.
    dispatcher = new Agent({
      headersTimeout: 3_600_000,
      bodyTimeout: 3_600_000,
    })
    const init = {
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
      redirect: "error" as const,
      dispatcher,
    }
    response = await (options.fetchFn ?? bedrockFetch)(
      `${ENDPOINT}/model/${encodeURIComponent(model)}/converse`,
      init,
    )
    stage = "response_body"
    if (!response.ok) {
      yield {
        type: "failure",
        failure: modelFailureFromUnknown(undefined, {
          provider: request.target.provider,
          wireApi: WIRE,
          stage: "response_headers",
          kind: failureKindForStatus(response.status),
          status: response.status,
          fallbackMessage:
            "Bedrock rejected the request. Check the region, key expiry, model permissions and request limits.",
          serverShouldRetry: false,
        }),
      }
      return
    }
    if (!response.body)
      throw new BedrockProtocolError("Missing Bedrock response body.")
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let responseBytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        request.signal?.throwIfAborted()
        if (!chunk.value)
          throw new BedrockProtocolError("Invalid Bedrock response chunk.")
        responseBytes += chunk.value.byteLength
        // Local memory safety bound, not an AWS output quota. Buffered output
        // must not allocate an unbounded response before validating its schema.
        if (responseBytes > 16_000_000)
          throw new BedrockProtocolError(
            "Bedrock response exceeds Yakitori's 16 MB buffered response safety limit.",
          )
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      reader.releaseLock()
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    request.signal?.throwIfAborted()
    if (
      !isJsonObject(result) ||
      !isJsonObject(result.output) ||
      !isJsonObject(result.output.message) ||
      result.output.message.role !== "assistant" ||
      !Array.isArray(result.output.message.content) ||
      !result.output.message.content.every(isJsonObject)
    )
      throw new BedrockProtocolError("Invalid Bedrock response envelope.")
    if (isJsonObject(result.usage)) {
      const u = result.usage
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheWriteInputTokens",
      ])
        if (
          u[key] !== undefined &&
          (!Number.isSafeInteger(u[key]) || (u[key] as number) < 0)
        )
          throw new BedrockProtocolError("Invalid Bedrock usage counter.")
      usage = {
        ...(typeof u.inputTokens === "number"
          ? { inputTokens: u.inputTokens }
          : {}),
        ...(typeof u.outputTokens === "number"
          ? { outputTokens: u.outputTokens }
          : {}),
        ...(typeof u.cacheReadInputTokens === "number"
          ? { cacheReadInputTokens: u.cacheReadInputTokens }
          : {}),
        ...(typeof u.cacheWriteInputTokens === "number"
          ? { cacheWriteInputTokens: u.cacheWriteInputTokens }
          : {}),
      }
      request.onUsageSnapshot?.(usage)
    }
    const rawStopReason = result.stopReason
    if (
      typeof rawStopReason !== "string" ||
      ![
        "end_turn",
        "tool_use",
        "max_tokens",
        "stop_sequence",
        "guardrail_intervened",
        "content_filtered",
      ].includes(rawStopReason)
    )
      throw new BedrockProtocolError("Unsupported Bedrock stop reason.")
    const native = result.output.message.content
    const content = parseContent(native, customKeys)
    const calls = content.filter((block) => block.type === "tool_call")
    if (
      rawStopReason === "tool_use" &&
      (calls.length === 0 ||
        request.toolChoice === "none" ||
        calls.some(
          (call) => !request.tools.some((tool) => tool.name === call.name),
        ))
    )
      throw new BedrockProtocolError(
        "Bedrock returned tools outside the captured tool plan.",
      )
    if (["end_turn", "stop_sequence"].includes(rawStopReason) && calls.length)
      throw new BedrockProtocolError(
        "Bedrock returned tool calls without a tool-use stop reason.",
      )
    const incompleteToolCalls = rawStopReason !== "tool_use" && calls.length > 0
    const stopReason =
      rawStopReason === "tool_use"
        ? ModelStopReason.ToolUse
        : rawStopReason === "max_tokens"
          ? ModelStopReason.Length
          : ["content_filtered", "guardrail_intervened"].includes(rawStopReason)
            ? ModelStopReason.ContentFilter
            : ModelStopReason.EndTurn
    yield {
      type: "response",
      response: {
        stopReason,
        rawStopReason,
        content: incompleteToolCalls
          ? content.filter((block) => block.type !== "tool_call")
          : content,
        // Never replay truncated/filtered tool calls as though executed.
        native: modelNativeItems(
          request,
          WIRE,
          incompleteToolCalls
            ? native.filter((block) => block.toolUse === undefined)
            : native,
        ),
        nativeMetadata: modelNativeResponseMetadata(request, WIRE, {
          ...result,
          output: undefined,
        }),
        ...(usage === undefined ? {} : { usage }),
        ...(stopReason === ModelStopReason.Length
          ? { lengthReason: "output" }
          : {}),
        ...(incompleteToolCalls ? { incompleteToolCalls: true } : {}),
      },
    }
  } catch (cause) {
    if (request.signal?.aborted) {
      yield { type: "cancelled", ...(usage ? { usage } : {}) }
      return
    }
    yield {
      type: "failure",
      failure: modelFailureFromUnknown(cause, {
        provider: request.target.provider,
        wireApi: WIRE,
        stage,
        kind:
          stage === "request_build"
            ? "invalid_request"
            : cause instanceof BedrockProtocolError ||
                cause instanceof SyntaxError
              ? "protocol_error"
              : "provider_error",
        fallbackMessage:
          cause instanceof BedrockProtocolError ||
          cause instanceof AssetMediaError
            ? cause.message
            : "Bedrock request failed; the outcome may be unknown. It was not automatically retried.",
        // Only locally constructed validation reasons are safe diagnostics;
        // never copy HTTP bodies, SDK errors or request headers into failures.
        ...(cause instanceof BedrockProtocolError ||
        (stage === "request_build" && cause instanceof AssetMediaError)
          ? { providerMessage: cause.message }
          : {}),
        serverShouldRetry: false,
      }),
      ...(usage ? { usage } : {}),
      cause,
    }
  } finally {
    try {
      if (response?.body && !response.body.locked) await response.body.cancel()
    } catch {
      // An errored/aborted body rejects cancel; the owned dispatcher below
      // still tears down the socket and its pending work before returning.
    } finally {
      await dispatcher?.destroy()
    }
  }
}

function parseContent(
  parts: JsonObject[],
  customKeys: Map<string, string>,
): ModelContentBlock[] {
  const ids = new Set<string>()
  return parts.flatMap((part): ModelContentBlock[] => {
    if (typeof part.text === "string" && Object.keys(part).length === 1)
      return [{ type: "text", text: part.text }]
    if (isJsonObject(part.reasoningContent) && Object.keys(part).length === 1)
      return [] // Opaque, retained only in owner-fenced native history.
    if (isJsonObject(part.toolUse) && Object.keys(part).length === 1) {
      const call = part.toolUse
      if (
        typeof call.toolUseId !== "string" ||
        !/^[a-zA-Z0-9_.:-]{1,64}$/.test(call.toolUseId) ||
        ids.has(call.toolUseId) ||
        typeof call.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name) ||
        !isJsonObject(call.input) ||
        call.type !== undefined
      )
        throw new BedrockProtocolError(
          "Invalid or duplicate Bedrock tool call.",
        )
      ids.add(call.toolUseId)
      const key = customKeys.get(call.name)
      if (key !== undefined && typeof call.input[key] !== "string")
        throw new BedrockProtocolError("Invalid custom tool input.")
      return [
        {
          type: "tool_call",
          id: call.toolUseId,
          name: call.name,
          input: key === undefined ? call.input : (call.input[key] as string),
          ...(key === undefined
            ? {}
            : { toolKind: "custom", customInputFallbackKey: key }),
        },
      ]
    }
    throw new BedrockProtocolError("Unsupported Bedrock response content.")
  })
}

function buildMessages(
  messages: readonly ModelMessage[],
  request: ModelRequest,
): Message[] {
  const result: Message[] = []
  const pending = new Set<string>()
  const seen = new Set<string>()
  const append = (role: Message["role"], content: JsonObject[]) => {
    if (!content.length) return
    const previous = result.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else result.push({ role, content })
  }
  for (const message of groupModelResponses(messages)) {
    if (message.role === "assistant") {
      if (pending.size)
        throw new BedrockProtocolError(
          "Missing tool results before the next assistant response.",
        )
      const content: JsonObject[] = []
      for (const block of portableModelContent(message)) {
        if (block.type === "text") content.push({ text: block.text })
        else if (block.type === "tool_call") {
          if (seen.has(block.id))
            throw new BedrockProtocolError("Duplicate tool history ID.")
          seen.add(block.id)
          pending.add(block.id)
          const input =
            block.toolKind === "custom" && block.customInputFallbackKey
              ? { [block.customInputFallbackKey]: block.input }
              : block.input
          if (!isJsonObject(input))
            throw new BedrockProtocolError(
              "Tool history must use JSON object inputs.",
            )
          content.push({
            toolUse: { toolUseId: block.id, name: block.name, input },
          })
        } else if (block.type === "compaction")
          throw new BedrockProtocolError(
            "Opaque compaction cannot be sent to Bedrock.",
          )
      }
      const native = replayModelNativeItems(
        message,
        WIRE,
        request.target.provider,
        request.continuationScope,
        request.target.model,
      )
      if (native) {
        parseContent(native, new Map())
        const nativeCalls = native.filter(
          (block) => block.toolUse !== undefined,
        )
        if (
          !isDeepStrictEqual(
            nativeCalls,
            content.filter((block) => block.toolUse !== undefined),
          )
        )
          throw new BedrockProtocolError(
            "Native Bedrock tool history differs from its execution projection.",
          )
      }
      append("assistant", native ?? content)
    } else if (message.role === "tool") {
      if (message.toolSearch || !pending.delete(message.toolCallId))
        throw new BedrockProtocolError("Unmatched or deferred tool result.")
      append("user", [
        {
          toolResult: {
            toolUseId: message.toolCallId,
            content: mediaContent(message.content),
            status: message.isError ? "error" : "success",
          },
        },
      ])
    } else {
      if (pending.size)
        throw new BedrockProtocolError(
          "Missing tool results before user content.",
        )
      const content = mediaContent(message.content)
      if (message.role === "developer")
        content.unshift({ text: "[Developer instruction]" })
      append("user", content)
    }
  }
  if (pending.size)
    throw new BedrockProtocolError("Missing tool results in Bedrock history.")
  if (
    !result.length ||
    result[0]?.role !== "user" ||
    result.at(-1)?.role !== "user"
  )
    throw new BedrockProtocolError(
      "Bedrock conversation must begin and end with user content.",
    )
  return result
}

function mediaContent(content: readonly { type: string }[]): JsonObject[] {
  return content.map((block): JsonObject => {
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    )
      return { text: block.text }
    if (block.type === "image" && "mediaType" in block) {
      const image = block as import("./model.ts").ModelImageBlock
      return {
        image: {
          format: image.mediaType.replace("image/", ""),
          source: { bytes: requireModelImageData(image) },
        },
      }
    }
    throw new BedrockProtocolError("Unsupported Bedrock input content.")
  })
}
