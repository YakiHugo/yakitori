import OpenAI, { type ClientOptions } from "openai"
import type {
  Tool as OpenAITool,
  Response,
  ResponseInput,
} from "openai/resources/responses/responses"
import type { ReasoningEffort } from "openai/resources/shared"
import { isJsonObject, isJsonValue } from "../kernel/index.ts"
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

export type OpenAIProviderOptions = {
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
  // SDK-internal retries stay disabled: the model request runtime owns policy.
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      fetchOptions: options.fetchOptions,
      maxRetries: 0,
    })
  return (request) =>
    streamOpenAI(client, options.model, request, options.onResponseHeaders)
}

async function* streamOpenAI(
  client: OpenAI,
  defaultModel: string,
  request: ModelRequest,
  onResponseHeaders?: (headers: Headers) => void,
): AsyncGenerator<ModelStreamEvent> {
  if (request.signal?.aborted) {
    yield abortedResponse()
    return
  }

  let failureStage: "connect" | "response_body" = "connect"
  try {
    const nativeDeferredLoading =
      nativeDeferredToolProtocol(request) === "openai"
    const customFallbackKeys = customFallbackKeysForRequest(
      request,
      nativeDeferredLoading,
    )
    const pending = client.responses.create(
      {
        model: request.target.model || defaultModel,
        instructions: flattenModelSystem(request.system),
        input: [
          ...toOpenAIInput(
            request.messages,
            nativeDeferredLoading,
            request.target.provider,
            request.continuationScope,
          ),
          ...(request.compaction === "remote_v2"
            ? [{ type: "compaction_trigger" as const }]
            : []),
        ],
        tools: toOpenAITools(request.tools, nativeDeferredLoading),
        parallel_tool_calls: true,
        // The Codex subscription endpoint rejects max_output_tokens. Its
        // ResponsesApiRequest omits this API-only output control.
        ...(request.target.provider === "codex"
          ? {}
          : {
              max_output_tokens:
                request.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
            }),
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
    const stream =
      onResponseHeaders === undefined
        ? await pending
        : await pending.withResponse().then(({ data, response }) => {
            onResponseHeaders(response.headers)
            return data
          })
    failureStage = "response_body"
    let text = ""
    let reasoning = ""
    const completedItems = new Map<number, Response["output"][number]>()
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
      if (event.type === "response.output_item.done") {
        completedItems.set(event.output_index, event.item)
        continue
      }
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        // Codex sends completed items separately and may leave terminal
        // output empty. Preserve output_index order and merge by item id so
        // ordinary Responses endpoints cannot duplicate a tool side effect.
        const outputById = new Map(
          [...completedItems.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => [item.id, item]),
        )
        for (const item of event.response.output) outputById.set(item.id, item)
        const response = {
          ...event.response,
          output: [...outputById.values()],
        }
        const failure = responseFailure(response, request.target.provider)
        if (failure !== undefined) {
          yield failure
        } else {
          yield {
            type: "response",
            response: fromOpenAIResponse(
              response,
              customFallbackKeys,
              request.target.provider,
              request.continuationScope,
              request.target.model,
            ),
          }
        }
        return
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
  } catch (error) {
    if (request.signal?.aborted) {
      yield abortedResponse()
      return
    }
    yield terminalFailure(error, request.target.provider, failureStage)
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
      const text = message.isError
        ? `[tool_error]\n${message.content}`
        : message.content
      // Responses supports file inputs; do not assume every compatible backend does.
      const documentsSupported = provider === "openai"
      const media = [
        ...(message.images ?? []).map((image) => ({
          type: "input_image" as const,
          image_url: `data:${image.mediaType};base64,${requireModelImageData(image)}`,
          detail: image.detail ?? ("high" as const),
        })),
        ...(message.documents ?? []).map((document) => {
          if (!documentsSupported)
            return {
              type: "input_text" as const,
              text: `[Document ${document.name} was not sent: native PDF input is not enabled for this provider.]`,
            }
          if (document.data === undefined)
            throw new Error("Unresolved document asset.")
          return {
            type: "input_file" as const,
            filename: document.name,
            file_data: `data:application/pdf;base64,${document.data}`,
          }
        }),
      ]
      const output =
        media.length === 0
          ? text
          : [{ type: "input_text" as const, text }, ...media]
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
  model = response.model,
): ModelResponse {
  if (response.status === "cancelled") {
    throw new Error("Cancelled OpenAI responses are not successful results.")
  }
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") {
      return responseResult(response, ModelStopReason.Length, [], provider)
    }
    throw new Error(
      `OpenAI response was incomplete: ${response.incomplete_details?.reason ?? "unknown"}.`,
    )
  }
  if (response.status === "failed" || response.error) {
    throw new Error(response.error?.message ?? "OpenAI response failed.")
  }

  const content: ModelContentBlock[] = []
  for (const item of response.output) {
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
          throw new Error(part.refusal)
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
      throw new Error(
        `OpenAI returned invalid JSON arguments for tool ${item.name}.`,
      )
    }
    if (!isJsonValue(parsed)) {
      throw new Error(
        `OpenAI returned non-JSON arguments for tool ${item.name}.`,
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
    ...(response.usage === undefined
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
    !(
      response.status === "incomplete" &&
      response.incomplete_details?.reason !== "max_output_tokens"
    ) &&
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
    ...(response.usage === undefined
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
    error instanceof OpenAI.APIConnectionError
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

function abortedResponse(): ModelStreamEvent {
  return { type: "cancelled" }
}
