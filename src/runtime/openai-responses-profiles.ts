import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses"
import { isJsonObject } from "../kernel/index.ts"
import { supportsOpenAIRequestWarmup } from "../shared/request-warmup-policy.ts"
import {
  requireChatGPTPlanNamespace,
  toChatGPTPlanRequest,
} from "./chatgpt-plan-request.ts"
import type { ModelRequest, ModelResponse } from "./model.ts"
import { ModelRequestControlsError } from "./model-request-controls.ts"
import {
  codexResponsesMedia,
  grokResponsesMedia,
  kimiResponsesMedia,
  openAIResponsesMedia,
  type ResponsesMediaContext,
  type ResponsesMediaPolicy,
} from "./openai-responses-media.ts"

type LengthReason = NonNullable<ModelResponse["lengthReason"]>
export type OpenAIResponsesProfile = Readonly<{
  id: string
  supportsWarmup?(baseURL: string): boolean
  supportsRemoteCompaction?: "api" | "stream"
  supportsNativeDeferredLoading: boolean
  useContainerImages?: boolean
  supportsFileUploads?: boolean
  includeReasoningSummary?(baseURL: string): boolean
  omitParallelToolCalls?: boolean
  omitMaxOutputTokens?: boolean
  omitStore?: boolean
  validateRequest?(request: ModelRequest, model: string): void
  prepareMedia?(
    context: ResponsesMediaContext,
  ): ResponsesMediaPolicy | undefined
  buildRequestBody?(
    body: ResponseCreateParamsStreaming,
    request: ModelRequest,
  ): ResponseCreateParamsStreaming
  finalizeBody?(
    body: ResponseCreateParamsStreaming,
    request: ModelRequest,
  ): ResponseCreateParamsStreaming
  validateStreamEvent?(event: ResponseStreamEvent): void
  requireTerminalEvent?: boolean
  lengthReason?(reason: string): LengthReason | undefined
  activeContextTokens?(usage: NonNullable<Response["usage"]>): number
  neverRetryStatus?(status: number | undefined): boolean
}>

export const openAIResponsesProfile: OpenAIResponsesProfile = {
  id: "openai",
  supportsWarmup: supportsOpenAIRequestWarmup,
  supportsRemoteCompaction: "api",
  supportsNativeDeferredLoading: true,
  useContainerImages: true,
  supportsFileUploads: true,
  includeReasoningSummary: (url) =>
    URL.parse(url)?.origin === "https://api.openai.com",
  prepareMedia: openAIResponsesMedia,
}

export const codexResponsesProfile: OpenAIResponsesProfile = {
  id: "codex",
  supportsRemoteCompaction: "stream",
  supportsNativeDeferredLoading: true,
  omitMaxOutputTokens: true,
  includeReasoningSummary: () => true,
  prepareMedia: codexResponsesMedia,
}

export const grokResponsesProfile: OpenAIResponsesProfile = {
  id: "grok",
  supportsNativeDeferredLoading: true,
  prepareMedia: grokResponsesMedia,
  lengthReason(reason) {
    if (reason === "max_output_tokens") return "output"
    if (reason === "max_prompt_tokens") return "context"
    if (reason === "max_time_limit") return "unknown"
    return undefined
  },
  activeContextTokens(usage) {
    const details = (usage as unknown as Record<string, unknown>)
      .context_details
    if (
      isJsonObject(details) &&
      typeof details.input_tokens === "number" &&
      typeof details.output_tokens === "number"
    )
      return details.input_tokens + details.output_tokens
    return usage.total_tokens
  },
  neverRetryStatus: (status) => status === 525 || status === 526,
}

export const kimiResponsesProfile: OpenAIResponsesProfile = {
  id: "kimi",
  supportsNativeDeferredLoading: true,
  omitParallelToolCalls: true,
  omitStore: true,
  lengthReason: (reason) =>
    reason === "max_output_tokens" ? "output" : undefined,
  validateRequest(request, model) {
    if (
      !["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"].includes(model)
    )
      throw new ModelRequestControlsError(
        "The Kimi Responses profile supports kimi-k3, kimi-k3.1-pro and kimi-k3.1-pro-highspeed only; use an exact public API model ID.",
      )
    if (request.compaction === "provider")
      throw new ModelRequestControlsError(
        "Kimi Responses does not support remote compaction.",
      )
    if (
      request.messages.some(
        (message) =>
          (message.role === "user" || message.role === "tool") &&
          message.content.some((block) => block.type === "document"),
      )
    )
      throw new ModelRequestControlsError(
        "Kimi Responses supports text and image inputs, not PDF inputs.",
      )
  },
  prepareMedia: kimiResponsesMedia,
  buildRequestBody(body, request) {
    validateKimiResponsesRequest(request, body)
    // Null is an output-schema placeholder, not a valid Kimi reasoning input.
    if (!Array.isArray(body.input)) return body
    return {
      ...body,
      input: body.input.map((item) => {
        if (item.type !== "reasoning" || item.encrypted_content !== null)
          return item
        const { encrypted_content: _encrypted, ...reasoning } = item
        return reasoning
      }),
    }
  },
}

const planControls = new Set([
  "reasoning",
  "prompt_cache_key",
  "service_tier",
  "include",
  "parallel_tool_calls",
  "tool_choice",
])
export const chatGPTPlanResponsesProfile: OpenAIResponsesProfile = {
  id: "chatgpt-plan",
  supportsNativeDeferredLoading: false,
  finalizeBody(body, request) {
    if (
      request.outputFormat !== undefined ||
      Object.keys(request.providerOptions?.body ?? {}).some(
        (key) => !planControls.has(key),
      )
    )
      throw new ModelRequestControlsError(
        "The ChatGPT plan request profile does not support these API-key-only request controls.",
      )
    return toChatGPTPlanRequest(body)
  },
  validateStreamEvent(event) {
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
  },
  requireTerminalEvent: true,
}

function validateKimiResponsesRequest(
  request: ModelRequest,
  body: ResponseCreateParamsStreaming,
): void {
  // The documented Kimi contract is narrower than the Responses wire shape.
  // Reject unsupported constraints rather than letting a server ignore them.
  if (body.tool_choice !== undefined && body.tool_choice !== "auto")
    throw new ModelRequestControlsError(
      "Kimi Responses supports tool_choice auto only.",
    )
  if (
    request.parallelToolCalls === false ||
    body.parallel_tool_calls !== undefined
  )
    throw new ModelRequestControlsError(
      "Kimi Responses does not support parallel_tool_calls controls.",
    )
  if (body.service_tier !== undefined)
    throw new ModelRequestControlsError(
      "Kimi Responses does not support service_tier controls.",
    )
  if (
    body.reasoning?.effort != null &&
    !["low", "high", "max"].includes(body.reasoning.effort)
  )
    throw new ModelRequestControlsError(
      "Kimi Responses reasoning effort must be low, high or max.",
    )
  if (body.reasoning?.summary != null)
    throw new ModelRequestControlsError(
      "Kimi Responses does not support reasoning summary controls.",
    )
  if (
    body.include?.some(
      (field) =>
        field !== "web_search_call.results" &&
        field !== "web_search_call.action.sources",
    )
  )
    throw new ModelRequestControlsError(
      "Kimi Responses include supports web search results and sources only.",
    )
  for (const definition of body.tools ?? []) {
    const tools =
      definition.type === "namespace" ? definition.tools : [definition]
    for (const tool of tools) {
      if (tool.type === "function" || tool.type === "web_search") continue
      if (
        tool.type === "custom" &&
        tool.name === "apply_patch" &&
        tool.format?.type === "grammar" &&
        tool.format.syntax === "lark"
      )
        continue
      throw new ModelRequestControlsError(
        "Kimi Responses supports function, web_search and custom apply_patch tools with a Lark grammar only.",
      )
    }
  }
}
