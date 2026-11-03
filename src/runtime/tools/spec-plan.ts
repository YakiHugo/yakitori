import { openAIVisionPolicy } from "../openai-vision-models.ts"
import type { AgentModelOverrides } from "../agent-model-selection.ts"
import { isMetaVisionModel } from "../meta-image-policy.ts"
import { isMimoVisionModel } from "../mimo-image-policy.ts"
import { nvidiaVisionModel } from "../nvidia-image-policy.ts"
import type { ModelTarget, ModelWireApi, ToolWireProtocol } from "../model.ts"
import { catalogModelCapacity, type ResolvedModel } from "../model-catalog.ts"
import type { ProviderToolCapabilities } from "../model-provider.ts"
import {
  ANTHROPIC_REQUEST_MAX_BYTES,
  GEMINI_INLINE_REQUEST_MAX_BYTES,
  supportsGeminiToolPdf,
  supportsGeminiUserPdf,
  supportsOpenAIChatToolPdf,
  supportsOpenAIChatUserPdf,
} from "../native-pdf-capabilities.ts"
import {
  type ImageTokenEstimator,
  openAIImageTokenEstimator,
} from "../openai-image-budget.ts"
import type { DocumentReadingCapabilities } from "../prepare-model-document.ts"
import {
  type ResolvedStepConfiguration,
  stepExecutionLimits,
} from "../session-configuration.ts"
import type { ToolRegistry, ToolRouter } from "./registry.ts"

const FILE_EDITING_TOOLS = new Set(["apply_patch", "edit_file", "write_file"])
// Until a model's capacity is verified, use the smaller documented media
// allowance as a local safety policy rather than assume access to the 1M tier.
const UNVERIFIED_ANTHROPIC_MEDIA_SAFETY_UNITS = 100

export type StepContext = Readonly<{
  configuration: ResolvedStepConfiguration
  target: ModelTarget
  modelInfo: ResolvedModel
  executionPolicy: ReturnType<typeof stepExecutionLimits>
  toolRouter: ToolRouter
  toolWireProtocol: ToolWireProtocol
  imageTokenEstimator: ImageTokenEstimator | undefined
  deferImagePreparation: boolean
  documentReading: DocumentReadingCapabilities
  userDocumentReading: DocumentReadingCapabilities
}>

export function captureStepContext(
  input: Readonly<{
    threadModelOverrides?: AgentModelOverrides
    agentModelOverrides?: AgentModelOverrides
    registry: ToolRegistry
    configuration: ResolvedStepConfiguration
    serviceId?: string
    wireApi?: ModelWireApi
    nativePdf?: boolean
    toolCapabilities?: ProviderToolCapabilities
  }>,
): StepContext {
  const target = Object.freeze({ ...input.configuration.target })
  const model = Object.freeze({
    ...input.configuration.modelInfo,
    inputModalities: Object.freeze([
      ...input.configuration.modelInfo.inputModalities,
    ]),
    imageDetailModes: Object.freeze([
      ...input.configuration.modelInfo.imageDetailModes,
    ]),
  })
  if (model.provider !== target.provider || model.model !== target.model) {
    throw new Error("Step model metadata does not match its concrete target.")
  }
  const provider =
    input.toolCapabilities ??
    providerToolCapabilities(target.provider, input.wireApi)
  const toolWireProtocol =
    model.supportsNativeToolSearch &&
    provider.nativeDeferredProtocol !== undefined
      ? provider.nativeDeferredProtocol
      : provider.eagerTools === true
        ? "eager"
        : "meta_dispatch"
  const fileEditingTools = new Set([
    ...(model.applyPatchToolType === undefined ? [] : ["apply_patch"]),
    ...(model.fileEditingToolType === "edit_write"
      ? ["edit_file", "write_file"]
      : model.fileEditingToolType === "search_replace"
        ? ["edit_file"]
        : []),
  ])
  const nativePdfModel =
    input.wireApi === "openai_chat_completions"
      ? !model.usedFallbackModelMetadata &&
        supportsOpenAIChatToolPdf(model.model, target.effort)
      : input.wireApi === "gemini_interactions"
        ? false
        : input.wireApi === "gemini_generate_content"
          ? supportsGeminiToolPdf(model.model)
          : true
  const nativePdf =
    input.nativePdf === true &&
    nativePdfModel &&
    model.inputModalities.includes("image")
  const nativeUserPdfModel =
    input.wireApi === "openai_chat_completions"
      ? supportsOpenAIChatUserPdf(model.model)
      : input.wireApi === "gemini_generate_content"
        ? supportsGeminiUserPdf(model.model)
        : true
  const nativeUserPdf =
    input.nativePdf === true &&
    nativeUserPdfModel &&
    model.inputModalities.includes("image")
  // These are immutable catalog capabilities, not the user's configured or
  // effective context budget. Unknown IDs get a labeled conservative policy.
  // https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-sizes-by-model
  const anthropicCapacity =
    input.wireApi === "anthropic_messages"
      ? catalogModelCapacity({ provider: "anthropic", model: model.model })
      : undefined
  const documentReading: DocumentReadingCapabilities = Object.freeze({
    nativePdf,
    // First-party PDF transport limits. Decimal MB is the conservative byte
    // interpretation of the published unit, not a model context estimate.
    // https://developers.openai.com/api/docs/guides/file-inputs
    // https://ai.google.dev/gemini-api/docs/generate-content/document-processing
    // https://ai.google.dev/gemini-api/docs/document-processing#passing-multiple-pdfs
    ...((nativePdf || nativeUserPdf) &&
    (input.wireApi === "openai_chat_completions" ||
      input.wireApi === "openai_responses")
      ? {
          nativePdfLimits: {
            maxFileBytes: 50_000_000,
            fileLimitExclusive: true,
            maxRequestBytes: 50_000_000,
          },
        }
      : (nativePdf || nativeUserPdf) &&
          (input.wireApi === "gemini_generate_content" ||
            input.wireApi === "gemini_interactions")
        ? {
            nativePdfLimits: {
              maxFileBytes: 50_000_000,
              maxRequestPages: 1_000,
              maxInlineBytes: GEMINI_INLINE_REQUEST_MAX_BYTES,
            },
          }
        : (nativePdf || nativeUserPdf) && input.wireApi === "anthropic_messages"
          ? {
              nativePdfLimits: {
                // PDF base64 alone is only a lower bound. The adapter checks
                // the complete serialized request before any network call.
                maxInlineBytes: ANTHROPIC_REQUEST_MAX_BYTES,
                maxRequestMediaUnits:
                  anthropicCapacity === undefined
                    ? UNVERIFIED_ANTHROPIC_MEDIA_SAFETY_UNITS
                    : anthropicCapacity.contextWindowTokens >= 1_000_000
                      ? 600
                      : 100,
                ...(anthropicCapacity === undefined
                  ? { mediaLimitIsConservative: true }
                  : {}),
              },
            }
          : {}),
    // Each wire adapter owns image placement, including Chat's synthetic user
    // content after tool results. Only the selected model gates image tools.
    images: model.inputModalities.includes("image"),
  })
  const enabledTrustedTools = new Set(
    input.configuration.enabledTools.filter(
      (name) =>
        (name !== "view_image" || documentReading.images) &&
        (!FILE_EDITING_TOOLS.has(name) || fileEditingTools.has(name)) &&
        (model.shellToolType !== "disabled" ||
          (name !== "exec_command" && name !== "write_stdin")),
    ),
  )
  return {
    configuration: Object.freeze({
      ...input.configuration,
      target,
      modelInfo: model,
      enabledTools: Object.freeze([...input.configuration.enabledTools]),
    }),
    target,
    modelInfo: model,
    executionPolicy: stepExecutionLimits(input.configuration),
    toolRouter: input.registry.finalize({
      ...(model.toolPolicy === undefined
        ? {}
        : { toolPolicy: model.toolPolicy }),
      enabledTrustedTools,
      ...(input.threadModelOverrides === undefined
        ? {}
        : { threadModelOverrides: input.threadModelOverrides }),
      ...(input.agentModelOverrides === undefined
        ? {}
        : { agentModelOverrides: input.agentModelOverrides }),
      customToolMode:
        model.supportsCustomTools && provider.supportsCustomTools
          ? "native"
          : "function",
      wireProtocol: toolWireProtocol,
    }),
    toolWireProtocol,
    // Seed 2.0+ high detail has a fixed documented 1280-token image cost.
    // The Doubao adapter always sends high; never apply this to relay profiles.
    // https://console.volcengine.com/ark/region:cn-beijing/docs/image-understanding
    imageTokenEstimator:
      input.serviceId === "doubao" &&
      input.wireApi === "openai_chat_completions" &&
      model.model === "doubao-seed-2-1-pro-260915"
        ? () => 1280
        : input.wireApi === "bedrock_converse"
          ? () => 230
          : openAIImageTokenEstimator({
              serviceId: input.serviceId,
              wireApi: input.wireApi,
              model,
            }),
    deferImagePreparation:
      (input.serviceId === "nvidia" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === nvidiaVisionModel) ||
      (input.serviceId === "codex" && input.wireApi === "openai_responses") ||
      (input.serviceId === "openai" &&
        input.wireApi === "openai_responses" &&
        openAIVisionPolicy(target.model) !== undefined) ||
      input.wireApi === "bedrock_converse" ||
      (input.serviceId === "xai" &&
        input.wireApi === "openai_responses" &&
        target.model === "grok-4.7") ||
      (input.serviceId === "meta" &&
        input.wireApi === "openai_chat_completions" &&
        isMetaVisionModel(target.model)) ||
      ((input.serviceId === "anthropic" || input.serviceId === "kimi-code") &&
        input.wireApi === "anthropic_messages") ||
      (input.serviceId === "gemini" &&
        input.wireApi === "gemini_generate_content") ||
      (input.serviceId === "moonshot" &&
        input.wireApi === "openai_responses") ||
      (input.serviceId === "longcat" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "LongCat-2.5") ||
      (input.serviceId === "sensenova" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "sensenova-6.8-flash-lite") ||
      (input.serviceId === "tencent" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "hy-vision-2.0-instruct") ||
      (input.serviceId === "minimax" &&
        input.wireApi === "openai_chat_completions") ||
      (input.serviceId === "doubao" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "doubao-seed-2-1-pro-260915") ||
      (input.serviceId === "qwen" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "qwen3.8-max") ||
      (input.serviceId === "deepseek" &&
        input.wireApi === "openai_chat_completions" &&
        model.model === "deepseek-flash") ||
      (input.serviceId === "glm" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "glm-5.3-flash") ||
      (input.serviceId === "stepfun" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "step-5-preview") ||
      (input.serviceId === "mimo" &&
        input.wireApi === "openai_chat_completions" &&
        isMimoVisionModel(target.model)) ||
      (input.serviceId === "reka" &&
        input.wireApi === "openai_chat_completions" &&
        target.model === "reka-edge-2603"),
    documentReading,
    userDocumentReading: Object.freeze({
      ...documentReading,
      nativePdf: nativeUserPdf,
    }),
  }
}

function providerToolCapabilities(
  provider: string,
  wireApi?: ModelWireApi,
): ProviderToolCapabilities {
  // A connection's editable ID carries no protocol meaning. Production Turns
  // supply captured transport capabilities; direct stream callers retain the
  // existing built-in provider defaults.
  if (wireApi === "openai_responses")
    return {
      supportsCustomTools: true,
      nativeDeferredProtocol: "openai_deferred",
    }
  if (wireApi === "anthropic_messages")
    return {
      supportsCustomTools: false,
      nativeDeferredProtocol: "anthropic_deferred",
    }
  if (
    wireApi === "openai_chat_completions" ||
    wireApi === "gemini_generate_content" ||
    wireApi === "gemini_interactions"
  )
    return { supportsCustomTools: false }
  const normalized = provider.toLowerCase()
  if (normalized === "openai" || normalized === "codex") {
    return {
      supportsCustomTools: true,
      nativeDeferredProtocol: "openai_deferred",
    }
  }
  if (normalized === "anthropic") {
    return {
      supportsCustomTools: false,
      nativeDeferredProtocol: "anthropic_deferred",
    }
  }
  if (normalized === "faux") {
    return { supportsCustomTools: true, eagerTools: true }
  }
  return { supportsCustomTools: false }
}
