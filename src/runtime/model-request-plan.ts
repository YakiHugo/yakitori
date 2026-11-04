import { isPortableChatOnlyNative } from "./chat-only-native.ts"
import { nativeDeferredToolProtocol } from "./deferred-tool-loading.ts"
import type { ModelRequest, ModelWireApi } from "./model.ts"
import type { ResolvedModel } from "./model-catalog.ts"
import type { ProviderToolCapabilities } from "./model-provider.ts"
import {
  estimateModelRequestBudget,
  type ModelRequestBudget,
} from "./model-request-budget.ts"
import { validateModelRequestControls } from "./model-request-controls.ts"
import type { ImageTokenEstimator } from "./openai-image-budget.ts"

export type ModelRequestPlanFailureCode =
  | "invalid_request"
  | "unsupported_effort"
  | "unsupported_speed"
  | "unsupported_modality"
  | "unsupported_tool_protocol"
  | "unsupported_combination"
  | "budget_exceeded"

export class ModelRequestPlanError extends Error {
  readonly code: ModelRequestPlanFailureCode

  constructor(code: ModelRequestPlanFailureCode, message: string) {
    super(message)
    this.code = code
  }
}

export type ModelRequestPlan = Readonly<{
  request: ModelRequest
  budget: ModelRequestBudget
  // Estimates guide the harness compaction loop; they are not provider token
  // admission or a reason to silently truncate/switch a request's connection.
  inputBudgetExceeded: boolean
}>

// Prepare once per logical model call, after media/tool projection. A physical
// retry reuses this plan; only its committed history and credential may change.
export function prepareModelRequestPlan(
  request: ModelRequest,
  input: Readonly<{
    model: ResolvedModel
    imageTokenEstimator?: ImageTokenEstimator | undefined
    wireApi: ModelWireApi
    toolCapabilities?: ProviderToolCapabilities
    inputLimitTokens?: number
  }>,
): ModelRequestPlan {
  const model = input.model
  const toolPolicy = model.toolPolicy ?? request.toolPolicy
  const rebuildMessagesAfterOutput = request.rebuildMessagesAfterOutput
  if (toolPolicy === "chat_only") validateChatOnlyRequest(request)
  if (
    request.target.provider !== model.provider ||
    request.target.model !== model.model
  )
    throw new ModelRequestPlanError(
      "invalid_request",
      "Captured model facts do not belong to this request target.",
    )
  const effort = request.target.effort ?? model.defaultEffort
  if (
    effort !== undefined &&
    model.efforts !== undefined &&
    !model.efforts.includes(effort)
  )
    throw new ModelRequestPlanError(
      "unsupported_effort",
      `Model ${model.provider}/${model.model} does not support reasoning effort ${effort}.`,
    )
  if (
    request.target.speed !== undefined &&
    !model.speeds?.includes(request.target.speed)
  )
    throw new ModelRequestPlanError(
      "unsupported_speed",
      `Model ${model.provider}/${model.model} does not support speed ${request.target.speed}.`,
    )
  const maxOutputTokens =
    request.maxOutputTokens ??
    (model.defaultOutputTokens === undefined
      ? undefined
      : Math.min(
          model.defaultOutputTokens,
          model.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        ))
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
  )
    throw new ModelRequestPlanError(
      "invalid_request",
      "The output token budget must be a positive safe integer.",
    )
  if (
    maxOutputTokens !== undefined &&
    model.maxOutputTokens !== undefined &&
    maxOutputTokens > model.maxOutputTokens
  )
    throw new ModelRequestPlanError(
      "budget_exceeded",
      `Requested output budget ${maxOutputTokens} exceeds the captured model limit ${model.maxOutputTokens}.`,
    )
  if (
    !model.inputModalities.includes("image") &&
    request.messages.some(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.some((block) => block.type === "image"),
    )
  )
    throw new ModelRequestPlanError(
      "unsupported_modality",
      `Model ${model.provider}/${model.model} cannot accept the prepared image content.`,
    )
  const nativeProtocol = nativeDeferredToolProtocol(request)
  // Injected streams own their serialization contract; a named production API
  // is required before enforcing a protocol-specific wire upper bound.
  const knownWireApi = input.wireApi !== "unknown" && input.wireApi !== "faux"
  if (
    (input.wireApi === "gemini_generate_content" ||
      input.wireApi === "gemini_interactions") &&
    request.parallelToolCalls === false
  )
    throw new ModelRequestPlanError(
      "unsupported_combination",
      "Gemini cannot guarantee serial function calls.",
    )
  if (
    nativeProtocol !== undefined &&
    (!model.supportsNativeToolSearch ||
      (input.toolCapabilities !== undefined &&
        input.toolCapabilities.nativeDeferredProtocol !==
          request.toolWireProtocol) ||
      (knownWireApi &&
        nativeProtocol === "openai" &&
        input.wireApi !== "openai_responses") ||
      (knownWireApi &&
        nativeProtocol === "anthropic" &&
        input.wireApi !== "anthropic_messages"))
  )
    throw new ModelRequestPlanError(
      "unsupported_tool_protocol",
      "The captured model and endpoint do not support this native deferred tool protocol.",
    )
  if (
    request.tools.some(
      (tool) =>
        tool.kind === "custom" && tool.customInputFallbackKey === undefined,
    ) &&
    (!model.supportsCustomTools ||
      input.toolCapabilities?.supportsCustomTools === false)
  )
    throw new ModelRequestPlanError(
      "unsupported_tool_protocol",
      "Native custom tools require support from both the model and endpoint, or a JSON input fallback.",
    )
  const prepared: ModelRequest = {
    ...request,
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
    ...(toolPolicy !== "chat_only" || rebuildMessagesAfterOutput === undefined
      ? {}
      : {
          rebuildMessagesAfterOutput: async () => {
            const messages = await rebuildMessagesAfterOutput()
            validateChatOnlyRequest({ ...request, messages })
            return messages
          },
        }),
    target: {
      ...request.target,
      ...(effort === undefined ? {} : { effort }),
    },
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    reasoning: {
      ...(model.efforts === undefined ? {} : { efforts: [...model.efforts] }),
      ...(model.defaultEffort === undefined
        ? {}
        : { defaultEffort: model.defaultEffort }),
      ...(model.multiAgentReasoningEffort === undefined
        ? {}
        : { multiAgentReasoningEffort: model.multiAgentReasoningEffort }),
    },
    tools: structuredClone(request.tools),
    system: structuredClone(request.system),
    messages: structuredClone(request.messages),
    ...(typeof request.toolChoice !== "object"
      ? {}
      : { toolChoice: { ...request.toolChoice } }),
    ...(request.outputFormat === undefined
      ? {}
      : { outputFormat: structuredClone(request.outputFormat) }),
    ...(request.providerOptions === undefined
      ? {}
      : { providerOptions: structuredClone(request.providerOptions) }),
  }
  if (knownWireApi) validateModelRequestControls(prepared, input.wireApi)
  if (typeof prepared.toolChoice === "object") {
    const name = prepared.toolChoice.name
    if (!prepared.tools.some((tool) => tool.name === name))
      throw new ModelRequestPlanError(
        "invalid_request",
        `Tool choice ${name} is absent from the captured tool plan.`,
      )
  }
  const budget = estimateModelRequestBudget(prepared, input.imageTokenEstimator)
  return {
    request: prepared,
    budget,
    inputBudgetExceeded:
      input.inputLimitTokens !== undefined &&
      budget.estimatedInputTokens >= input.inputLimitTokens,
  }
}

// Foundation only: do not convert historical tool/native state into ordinary
// user instructions. A later portable-history projection can relax this fence.
export function validateChatOnlyRequest(request: ModelRequest): void {
  if (
    request.tools.length > 0 ||
    request.toolChoice !== undefined ||
    request.parallelToolCalls !== undefined ||
    // Vendor controls are open-ended and may activate hosted tools without
    // a tools array. This portable-only foundation admits none of them.
    request.providerOptions !== undefined ||
    request.compaction !== undefined ||
    request.messages.some(
      (message) =>
        message.role === "tool" ||
        (message.role === "assistant" &&
          (!isPortableChatOnlyNative(message.content, message.native) ||
            message.content.some(
              (block) =>
                block.type === "tool_call" || block.type === "compaction",
            ))),
    )
  )
    throw new ModelRequestPlanError(
      "unsupported_tool_protocol",
      "Chat-only execution rejects tools, tool controls, and tool/native history. The original history has not been changed. Start a new conversation for text/image chat, or switch back to a tool-enabled model to continue this history.",
    )
}
