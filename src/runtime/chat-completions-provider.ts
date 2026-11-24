import OpenAI from "openai"
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue, type JsonObject } from "../kernel/index.ts"
import type { ReasoningFormat } from "../protocol/model-output.ts"
import { AssetMediaError, prepareProviderMedia } from "./asset-media.ts"
import { chatCompletionsIncompatibility } from "./chat-completions-compatibility.ts"
import {
  type ChatCompletionsFlavor,
  genericChatDialect,
  type ResolvedChatDialect,
  resolveChatCompletionsDialect,
} from "./chat-completions-dialects.ts"
import { JsonRequestBudgetError } from "./json-request-budget.ts"
import {
  flattenModelSystem,
  type ModelContentBlock,
  type ModelMessage,
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelToolCallBlock,
  type ModelUsage,
  requireModelDocumentData,
  requireModelImageData,
  type StreamFn,
} from "./model.ts"
import { openAICitations } from "./model-citations.ts"
import { cleanModelTextStream } from "./model-control-tokens.ts"
import {
  failureKindForStatus,
  modelFailureFromUnknown,
  providerErrorMessage,
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
import { ModelRequestPlanError } from "./model-request-plan.ts"
import { parseRetryAfterMs, parseShouldRetry } from "./retry-after.ts"

export type ChatCompletionsProviderOptions = Readonly<{
  apiKey: string
  model: string
  baseURL: string
  defaultHeaders?: Record<string, string | null>
  flavor?: ChatCompletionsFlavor
}>

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
  kind: "function" | "custom"
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
  return (request) =>
    cleanModelTextStream(streamChatCompletions(client, options, request))
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
  const incompatibility = chatCompletionsIncompatibility(options, request)
  if (incompatibility !== undefined) {
    yield {
      type: "failure",
      failure: {
        provider: request.target.provider,
        wireApi: "openai_chat_completions",
        stage: "request_build",
        kind: "invalid_request",
        message: incompatibility,
      },
    }
    return
  }
  let stage: "request_build" | "connect" | "response_body" = "request_build"
  let usage: ModelUsage | undefined
  const usageFields = () => (usage === undefined ? {} : { usage })
  let providerRequestId: string | undefined
  try {
    validateModelHistoryScope(request, "openai_chat_completions")
    validateModelRequestControls(request, "openai_chat_completions")
    if (request.compaction !== undefined && request.compaction !== "local")
      throw new ChatCompletionsProtocolError(
        "Chat Completions does not support native remote compaction.",
      )
    const model = request.target.model || options.model
    const dialect = resolveChatCompletionsDialect(options, model)
    dialect.validateRequest?.(request, model)
    const imagePolicy = dialect.prepareMedia?.(request)
    const portableChat = dialect.assistantHistory === "portable"
    const media = await prepareProviderMedia(request, {
      ...imagePolicy,
      inlineDocumentUrls: true,
    })
    const messages = toChatCompletionsMessages(
      media.messages,
      request.target.provider,
      request.continuationScope,
      dialect,
      model,
    )
    const system = flattenModelSystem(request.system)
    if (system.length > 0) messages.unshift({ role: "system", content: system })
    const customFallbackKeys = new Map(
      request.tools.flatMap((tool) => {
        if (tool.kind !== "custom") return []
        if (tool.customInputFallbackKey === undefined) return []
        return [[tool.name, tool.customInputFallbackKey] as const]
      }),
    )
    const body = applyModelRequestControls(request, "openai_chat_completions", {
      model,
      messages,
      stream: true as const,
      ...(dialect.wire.includeStreamUsage
        ? { stream_options: { include_usage: true as const } }
        : {}),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { [dialect.wire.maxOutputTokensField]: request.maxOutputTokens }),
      ...(request.parallelToolCalls === undefined
        ? {}
        : { parallel_tool_calls: request.parallelToolCalls }),
      ...(request.outputFormat === undefined
        ? {}
        : {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: request.outputFormat.name,
                schema: request.outputFormat.schema,
                strict: request.outputFormat.strict ?? true,
              },
            },
          }),
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) =>
              tool.kind === "custom" &&
              tool.customInputFallbackKey === undefined
                ? {
                    type: "custom" as const,
                    custom: {
                      name: tool.name,
                      description: tool.description,
                      ...(tool.inputFormat === undefined
                        ? {}
                        : {
                            format: {
                              type: "grammar" as const,
                              grammar: {
                                syntax: tool.inputFormat.syntax,
                                definition: tool.inputFormat.definition,
                              },
                            },
                          }),
                    },
                  }
                : {
                    type: "function" as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                      ...(tool.strict === undefined
                        ? {}
                        : { strict: tool.strict }),
                    },
                  },
            ),
          }),
      ...(request.tools.length === 0 && request.toolChoice === undefined
        ? {}
        : {
            tool_choice:
              typeof request.toolChoice === "object"
                ? request.tools.some(
                    (tool) =>
                      tool.kind === "custom" &&
                      tool.customInputFallbackKey === undefined &&
                      typeof request.toolChoice === "object" &&
                      tool.name === request.toolChoice.name,
                  )
                  ? {
                      type: "custom" as const,
                      custom: { name: request.toolChoice.name },
                    }
                  : {
                      type: "function" as const,
                      function: { name: request.toolChoice.name },
                    }
                : (request.toolChoice ?? "auto"),
          }),
      // The configured model owns its supported effort values. Omit the
      // field entirely when that model has no explicit effort selection.
      ...(request.target.effort === undefined
        ? {}
        : { reasoning_effort: request.target.effort as ReasoningEffort }),
    })
    const extendedBody: typeof body & { thinking?: JsonObject } = body
    Object.assign(extendedBody, dialect.extendBody?.(extendedBody, model))
    imagePolicy?.validateBody?.(extendedBody, media.messages)
    dialect.validateBody?.(extendedBody, request)

    stage = "connect"
    const { data: stream, response } = await client.chat.completions
      .create(
        body,
        request.signal === undefined ? undefined : { signal: request.signal },
      )
      .withResponse()
    providerRequestId = response.headers.get("x-request-id") ?? undefined
    stage = "response_body"
    let completionId: string | undefined
    const answerParts: { text: string; refusal: boolean }[] = []
    const answerDelta = (text: string, refusal: boolean): ModelStreamEvent => {
      let part = answerParts.at(-1)
      if (part === undefined || part.refusal !== refusal) {
        part = { text: "", refusal }
        answerParts.push(part)
      }
      part.text += text
      const partIndex = answerParts.length - 1
      return {
        type: "delta",
        text,
        ...(refusal ? { refusal: true } : {}),
        ...(partIndex === 0 ? {} : { partIndex }),
        ...(request.streamOutputItems && completionId !== undefined
          ? { itemId: `${completionId}_0` }
          : {}),
      }
    }
    const reasoningParts: {
      text: string
      format: ReasoningFormat
      partIndex: number
    }[] = []
    const reasoningIndexes = { raw: 0, summary: 0, redacted: 0 }
    const addReasoningPart = (format: ReasoningFormat) => {
      const part = {
        text: "",
        format,
        partIndex: reasoningIndexes[format]++,
      }
      reasoningParts.push(part)
      return part
    }
    let plainReasoning: (typeof reasoningParts)[number] | undefined
    const detailParts = new Map<number, (typeof reasoningParts)[number]>()
    const reasoningDelta = (
      part: (typeof reasoningParts)[number],
      fragment: string,
    ): ModelStreamEvent => {
      part.text += fragment
      return {
        type: "reasoning_delta",
        text: fragment,
        format: part.format,
        ...(part.partIndex === 0 ? {} : { partIndex: part.partIndex }),
        ...(request.streamOutputItems && completionId !== undefined
          ? { itemId: `${completionId}_0` }
          : {}),
      }
    }
    let refusal = ""
    let nativeText = ""
    let nativeContentParts: JsonObject[] | undefined
    const nativeReasoning: Record<
      string,
      import("../kernel/index.ts").JsonValue
    > = {}
    const detailIndices = new Map<number, number>()
    const reasoningDetails: Record<
      string,
      import("../kernel/index.ts").JsonValue
    >[] = []
    const annotations: import("../kernel/index.ts").JsonValue[] = []
    let finishReason: string | undefined
    let responseMetadata: Record<string, unknown> = {}
    let choiceMetadata: Record<string, unknown> = {}
    const calls = new Map<number, PendingToolCall>()
    for await (const chunk of stream) {
      if (request.signal?.aborted) {
        yield { type: "cancelled", ...usageFields() }
        return
      }
      if (dialect.checkStreamCode && "code" in chunk && chunk.code !== 0)
        throw new SparkBusinessError(
          String(chunk.code),
          "message" in chunk
            ? String(chunk.message)
            : "Spark MaaS request failed.",
        )
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
        usage = fromChatUsage(chunk.usage, dialect.cachedTokens ?? false)
        request.onUsageSnapshot?.(usage)
      }
      const { choices: _choices, ...metadata } = chunk
      responseMetadata = { ...responseMetadata, ...metadata }
      for (const choice of chunk.choices) {
        const { delta: _delta, ...metadata } = choice
        choiceMetadata = { ...choiceMetadata, ...metadata }
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
        // Ark thinking summaries require the opaque original on tool turns.
        // Ark sends one complete encrypted block, not incremental text.
        // Keep it in provider-scoped native history, never visible reasoning.
        // https://docs.volcengine.com/docs/ark/chat-api?lang=zh
        if (dialect.encryptedReasoning && delta.encrypted_content != null) {
          if (typeof delta.encrypted_content !== "string")
            throw new ChatCompletionsProtocolError(
              "Invalid encrypted_content delta.",
            )
          nativeReasoning.encrypted_content = delta.encrypted_content
        }
        if (
          portableChat &&
          (delta.tool_calls != null ||
            delta.reasoning_details != null ||
            Array.isArray(delta.content))
        )
          throw new ChatCompletionsProtocolError(
            "Image chat returned unsupported tool or structured continuation state.",
          )
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
        const structuredText: string[] = []
        if (delta.reasoning_details !== undefined) {
          if (
            !Array.isArray(delta.reasoning_details) ||
            !delta.reasoning_details.every(isJsonObject)
          )
            throw new ChatCompletionsProtocolError("Invalid reasoning details.")
          for (const fragment of delta.reasoning_details) {
            const providerIndex = fragment.index
            if (
              providerIndex !== undefined &&
              (typeof providerIndex !== "number" ||
                !Number.isInteger(providerIndex) ||
                providerIndex < 0)
            )
              throw new ChatCompletionsProtocolError(
                "Invalid reasoning detail index.",
              )
            const index =
              typeof providerIndex === "number"
                ? (detailIndices.get(providerIndex) ?? reasoningDetails.length)
                : reasoningDetails.length
            if (typeof providerIndex === "number")
              detailIndices.set(providerIndex, index)
            const previous = reasoningDetails[index] ?? {}
            for (const [key, value] of Object.entries(fragment)) {
              if (
                ["text", "summary", "data", "signature"].includes(key) &&
                typeof value === "string"
              )
                previous[key] =
                  (typeof previous[key] === "string" ? previous[key] : "") +
                  value
              else {
                if (
                  ["type", "id", "format"].includes(key) &&
                  previous[key] !== undefined &&
                  previous[key] !== value
                )
                  throw new ChatCompletionsProtocolError(
                    "Reasoning detail identity changed.",
                  )
                previous[key] = value
              }
            }
            reasoningDetails[index] = previous
            const format =
              previous.type === "reasoning.summary"
                ? "summary"
                : previous.type === "reasoning.text"
                  ? "raw"
                  : previous.type === "reasoning.encrypted"
                    ? "redacted"
                    : undefined
            if (format === undefined) continue
            const detailText =
              format === "summary" ? fragment.summary : fragment.text
            const existing = detailParts.get(index)
            if (format === "redacted") {
              if (existing !== undefined) continue
              const part = addReasoningPart(format)
              detailParts.set(index, part)
              yield reasoningDelta(part, "")
            } else if (
              typeof detailText === "string" &&
              detailText.length > 0
            ) {
              const part = existing ?? addReasoningPart(format)
              detailParts.set(index, part)
              structuredText.push(detailText)
              yield reasoningDelta(part, detailText)
            }
          }
        }
        // Mistral switches from thinking/text parts to plain strings within a
        // single stream. Keep its structured continuation separate from the
        // text/reasoning projection consumed by the harness.
        if (Array.isArray(delta.content)) {
          nativeContentParts ??=
            nativeText.length === 0 ? [] : [{ type: "text", text: nativeText }]
          for (const part of delta.content) {
            if (!isJsonObject(part))
              throw new ChatCompletionsProtocolError(
                "Invalid completion content part.",
              )
            let fragment: string
            let type: "delta" | "reasoning_delta"
            if (part.type === "text" && typeof part.text === "string") {
              fragment = part.text
              type = "delta"
            } else if (part.type === "thinking") {
              if (
                !Array.isArray(part.thinking) ||
                !part.thinking.every(isJsonObject) ||
                (part.signature != null &&
                  typeof part.signature !== "string") ||
                (part.closed !== undefined && typeof part.closed !== "boolean")
              )
                throw new ChatCompletionsProtocolError(
                  "Invalid completion thinking part.",
                )
              fragment = part.thinking
                .map((unit) => {
                  if (
                    unit.type === "reference" ||
                    unit.type === "tool_reference"
                  )
                    return ""
                  if (unit.type !== "text")
                    throw new ChatCompletionsProtocolError(
                      "Unsupported completion thinking content.",
                    )
                  if (typeof unit.text !== "string")
                    throw new ChatCompletionsProtocolError(
                      "Invalid completion thinking text.",
                    )
                  return unit.text
                })
                .join("")
              type = "reasoning_delta"
            } else {
              throw new ChatCompletionsProtocolError(
                "Unsupported completion content part.",
              )
            }
            appendChatContentPart(nativeContentParts, part)
            if (fragment.length === 0) continue
            if (type === "reasoning_delta") {
              plainReasoning ??= addReasoningPart("raw")
              yield reasoningDelta(plainReasoning, fragment)
            } else yield answerDelta(fragment, false)
          }
        }
        const plainFragments = new Set<string>()
        for (const [field, type] of [
          ["content", "delta"],
          ...dialect.reasoning.extractFields.map(
            (field) => [field, "reasoning_delta"] as const,
          ),
          ["refusal", "delta"],
        ] as const) {
          const fragment = delta[field]
          if (fragment === undefined || fragment === null) continue
          if (field === "content" && Array.isArray(fragment)) continue
          if (typeof fragment !== "string")
            throw new ChatCompletionsProtocolError(`Invalid ${field} delta.`)
          if (type === "reasoning_delta") {
            nativeReasoning[field] =
              String(nativeReasoning[field] ?? "") + fragment
            // Some endpoints mirror detail text in the flat reasoning fields.
            if (
              fragment.length > 0 &&
              !plainFragments.has(fragment) &&
              !structuredText.includes(fragment) &&
              fragment !== structuredText.join("")
            ) {
              plainFragments.add(fragment)
              plainReasoning ??= addReasoningPart("raw")
              yield reasoningDelta(plainReasoning, fragment)
            }
            continue
          } else {
            if (field === "refusal") refusal += fragment
            else {
              nativeText += fragment
              if (nativeContentParts !== undefined && fragment.length > 0)
                appendChatContentPart(nativeContentParts, {
                  type: "text",
                  text: fragment,
                })
            }
          }
          if (fragment.length > 0)
            yield answerDelta(fragment, field === "refusal")
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls))
            throw new ChatCompletionsProtocolError("Invalid tool call deltas.")
          for (const tool of delta.tool_calls) {
            if (
              dialect.functionToolsOnly &&
              isJsonObject(tool) &&
              tool.type === "custom"
            )
              throw new ChatCompletionsProtocolError(dialect.functionToolsOnly)
            if (
              !isJsonObject(tool) ||
              typeof tool.index !== "number" ||
              !Number.isInteger(tool.index) ||
              tool.index < 0 ||
              (tool.type !== undefined &&
                tool.type !== "function" &&
                tool.type !== "custom")
            )
              throw new ChatCompletionsProtocolError(
                "Invalid function call delta.",
              )
            const call = calls.get(tool.index) ?? {
              id: "",
              name: "",
              arguments: "",
              kind: tool.type === "custom" ? "custom" : "function",
            }
            if (tool.type !== undefined && tool.type !== call.kind)
              throw new ChatCompletionsProtocolError(
                "Tool type changed mid-stream.",
              )
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
            if (tool.custom !== undefined) {
              if (call.kind !== "custom" || !isJsonObject(tool.custom))
                throw new ChatCompletionsProtocolError("Invalid custom call.")
              if (tool.custom.name !== undefined) {
                if (typeof tool.custom.name !== "string")
                  throw new ChatCompletionsProtocolError("Invalid custom name.")
                call.name = tool.custom.name
              }
              if (tool.custom.input !== undefined) {
                if (typeof tool.custom.input !== "string")
                  throw new ChatCompletionsProtocolError(
                    "Invalid custom input.",
                  )
                call.arguments += tool.custom.input
              }
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
            if (dialect.thoughtSignatures) {
              const signature = geminiThoughtSignature(tool)
              if (signature !== undefined) call.thoughtSignature = signature
            }
            calls.set(tool.index, call)
          }
        }
        // StepFun and SenseNova document empty strings on unfinished SSE chunks.
        if (
          choice.finish_reason != null &&
          !(
            dialect.emptyFinishReason && (choice.finish_reason as string) === ""
          )
        )
          finishReason = choice.finish_reason
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
    if (dialect.incompleteFinish?.reason === finishReason)
      throw new MimoRepetitionTruncationError(dialect.incompleteFinish.message)
    if (
      !["stop", "length", "tool_calls", "content_filter"].includes(finishReason)
    )
      throw new ChatCompletionsProtocolError(
        "Invalid completion finish reason.",
      )
    const content: ModelContentBlock[] = []
    if (
      reasoningParts.length === 0 &&
      typeof nativeReasoning.encrypted_content === "string" &&
      nativeReasoning.encrypted_content.length > 0
    )
      addReasoningPart("redacted")
    for (const part of reasoningParts)
      content.push({
        type: "reasoning",
        text: part.text,
        format: part.format,
        ...(dialect.reasoning.echoMode !== "scoped" || part !== plainReasoning
          ? {}
          : {
              providerMetadata: {
                chatCompletions: continuationMetadata(request, {
                  reasoningContent: true,
                }),
              },
            }),
      })
    const plain = answerParts.filter((part) => !part.refusal)
    const citations = openAICitations(
      annotations,
      plain.map((part) => part.text).join(""),
    )
    if (annotations.length > 0 && plain.length === 0)
      answerParts.push({ text: "", refusal: false })
    let plainOffset = 0
    let firstPlain = true
    for (const { text, refusal } of answerParts) {
      if (refusal) {
        content.push({ type: "text", text, refusal: true })
        continue
      }
      const partCitations = citations.flatMap(
        ({ responseSpan, ...citation }) => {
          if (responseSpan === undefined) return firstPlain ? [citation] : []
          const start = Math.max(plainOffset, responseSpan.start)
          const end = Math.min(plainOffset + text.length, responseSpan.end)
          return start >= end
            ? []
            : [
                {
                  ...citation,
                  responseSpan: {
                    start: start - plainOffset,
                    end: end - plainOffset,
                  },
                },
              ]
        },
      )
      content.push({
        type: "text",
        text,
        ...(partCitations.length === 0 ? {} : { annotations: partCitations }),
        ...(annotations.length === 0 || !firstPlain
          ? {}
          : {
              providerMetadata: {
                chatCompletions: continuationMetadata(request, { annotations }),
              },
            }),
      })
      plainOffset += text.length
      firstPlain = false
    }
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
        input =
          call.kind === "custom" ? call.arguments : JSON.parse(call.arguments)
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
      const fallbackKey =
        call.kind === "custom" ? undefined : customFallbackKeys.get(call.name)
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
        ...(call.kind === "custom"
          ? { toolKind: "custom" as const }
          : fallbackKey === undefined
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
        : finishReason === "content_filter" || (refusal.length > 0 && !hasCalls)
          ? ModelStopReason.ContentFilter
          : hasCalls
            ? ModelStopReason.ToolUse
            : ModelStopReason.EndTurn
    if (finishReason === "tool_calls" && !hasCalls)
      throw new ChatCompletionsProtocolError(
        "Invalid completion finish reason.",
      )
    // SenseNova says not to echo reasoning. Keep it in portable history for
    // display, without continuation metadata or a replayable native envelope.
    const native = modelNativeItems(request, "openai_chat_completions", [
      {
        role: "assistant",
        content:
          nativeContentParts ?? (nativeText.length === 0 ? null : nativeText),
        ...(refusal.length === 0 ? {} : { refusal }),
        ...nativeReasoning,
        ...(reasoningDetails.length === 0
          ? {}
          : { reasoning_details: reasoningDetails }),
        ...(annotations.length === 0 ? {} : { annotations }),
        ...(hasCalls
          ? {
              tool_calls: [...calls]
                .sort(([left], [right]) => left - right)
                .flatMap(([, call]) =>
                  ids.has(call.id) &&
                  content.some(
                    (block) =>
                      block.type === "tool_call" && block.id === call.id,
                  )
                    ? [
                        {
                          id: call.id,
                          ...(call.kind === "custom"
                            ? {
                                type: "custom",
                                custom: {
                                  name: call.name,
                                  input: call.arguments,
                                },
                              }
                            : {
                                type: "function",
                                function: {
                                  name: call.name,
                                  arguments: call.arguments,
                                },
                              }),
                          ...(call.thoughtSignature === undefined
                            ? {}
                            : {
                                extra_content: {
                                  google: {
                                    thought_signature: call.thoughtSignature,
                                  },
                                },
                              }),
                        },
                      ]
                    : [],
                ),
            }
          : {}),
      },
    ])
    if (request.streamOutputItems && (content.length > 0 || native.length > 0))
      yield {
        type: "output_item",
        itemId: `${completionId ?? "completion"}_0`,
        content,
        native: portableChat ? [] : native,
      }
    const requestId = providerRequestId
    yield {
      type: "response",
      response: {
        stopReason,
        rawStopReason: finishReason,
        content,
        native: portableChat ? [] : native,
        nativeMetadata: modelNativeResponseMetadata(
          request,
          "openai_chat_completions",
          { ...responseMetadata, choices: [choiceMetadata] },
        ),
        ...(completionId === undefined
          ? {}
          : { providerResponseId: completionId }),
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
    if (
      error instanceof AssetMediaError ||
      error instanceof JsonRequestBudgetError ||
      error instanceof ModelRequestControlsError ||
      error instanceof ModelHistoryScopeError ||
      error instanceof ModelRequestPlanError
    ) {
      yield {
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          provider: request.target.provider,
          wireApi: "openai_chat_completions",
          message: error.message,
          ...(error instanceof ModelHistoryScopeError
            ? { providerCode: error.code }
            : {}),
        },
      }
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
        providerMessage:
          error instanceof MimoRepetitionTruncationError ||
          error instanceof SparkBusinessError
            ? error.message
            : providerErrorMessage({ error: apiError?.error }),
        ...(error instanceof MimoRepetitionTruncationError
          ? { providerCode: "repetition_truncation", serverShouldRetry: false }
          : error instanceof SparkBusinessError
            ? { providerCode: error.code }
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
  dialect: ResolvedChatDialect = genericChatDialect,
  model?: string,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []
  let toolMedia: ChatCompletionContentPart[] = []
  for (const message of groupModelResponses(messages)) {
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
          : message.content.map((block) => {
              if (block.type === "text")
                return { type: "text" as const, text: block.text }
              if (block.type === "document")
                return {
                  type: "file" as const,
                  file: {
                    filename: block.name,
                    file_data: `data:application/pdf;base64,${requireModelDocumentData(block)}`,
                  },
                }
              return {
                type: "image_url" as const,
                image_url: {
                  url:
                    block.file && "url" in block.file
                      ? block.file.url
                      : `data:${block.mediaType};base64,${requireModelImageData(block)}`,
                  ...(dialect.wire.omitImageDetail?.includes("user")
                    ? {}
                    : { detail: "high" }),
                },
              }
            }),
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
                url:
                  block.file && "url" in block.file
                    ? block.file.url
                    : `data:${block.mediaType};base64,${requireModelImageData(block)}`,
                ...(dialect.wire.omitImageDetail?.includes("tool")
                  ? {}
                  : { detail: "high" }),
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
      const native =
        dialect.assistantHistory === "portable"
          ? undefined
          : replayModelNativeItems(
              message,
              "openai_chat_completions",
              provider,
              continuationScope,
              model,
            )
      if (native !== undefined) {
        if (native.length !== 1 || native[0]?.role !== "assistant")
          throw new ChatCompletionsProtocolError(
            "Invalid native assistant message.",
          )
        result.push(native[0] as unknown as ChatCompletionAssistantMessageParam)
        continue
      }
      const toolCalls: ToolCall[] = []
      const reasoning: string[] = []
      let text = ""
      for (const block of portableModelContent(message)) {
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
        const metadata = dialect.thoughtSignatures
          ? chatContinuationMetadata(
              block.providerMetadata,
              provider,
              continuationScope,
            )
          : undefined
        if (
          block.toolKind === "custom" &&
          block.customInputFallbackKey === undefined
        ) {
          if (typeof block.input !== "string")
            throw new ChatCompletionsProtocolError(
              "Custom tool input must be text.",
            )
          toolCalls.push({
            id: block.id,
            type: "custom",
            custom: { name: block.name, input: block.input },
          })
          continue
        }
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
        ...(dialect.reasoning.echoMode !== "scoped" || reasoning.length === 0
          ? {}
          : { reasoning_content: reasoning.join("\n") }),
      }
      result.push(converted)
    }
  }
  if (toolMedia.length > 0) result.push({ role: "user", content: toolMedia })
  return result
}

function appendChatContentPart(parts: JsonObject[], part: JsonObject): void {
  const previous = parts.at(-1)
  if (
    part.type === "text" &&
    previous?.type === "text" &&
    typeof previous.text === "string" &&
    typeof part.text === "string"
  ) {
    parts[parts.length - 1] = {
      ...previous,
      ...part,
      text: previous.text + part.text,
    }
  } else if (
    part.type === "thinking" &&
    previous?.type === "thinking" &&
    Array.isArray(previous.thinking) &&
    Array.isArray(part.thinking) &&
    typeof previous.signature !== "string"
  ) {
    // Thinking text and its final signature can arrive in separate deltas.
    // A signed block is complete; do not attach a later block to its signature.
    // `closed` controls Mistral prefixing, not SSE fragment boundaries.
    const thinking = previous.thinking
    thinking.push(...part.thinking)
    parts[parts.length - 1] = {
      ...previous,
      ...part,
      thinking,
    }
  } else {
    parts.push(part)
  }
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
  usesCachedTokens: boolean,
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
  const stepfunCache =
    usesCachedTokens && isJsonObject(extended)
      ? extended.cached_tokens
      : undefined
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    (typeof stepfunCache === "number" ? stepfunCache : undefined) ??
    (typeof deepseekCache === "number" ? deepseekCache : undefined)
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    activeContextTokens: usage.total_tokens,
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  }
}

class ChatCompletionsProtocolError extends Error {}
class SparkBusinessError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
class MimoRepetitionTruncationError extends ChatCompletionsProtocolError {}
class ChatCompletionsIncompleteStreamError extends Error {}
