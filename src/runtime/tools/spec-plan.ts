import type { ModelTarget, ModelWireApi, ToolWireProtocol } from "../model.ts"
import type { ResolvedModel } from "../model-catalog.ts"
import type { DocumentReadingCapabilities } from "../prepare-model-document.ts"
import {
  GEMINI_INLINE_REQUEST_MAX_BYTES,
  supportsGeminiToolPdf,
  supportsGeminiUserPdf,
  supportsOpenAIChatToolPdf,
  supportsOpenAIChatUserPdf,
} from "../native-pdf-capabilities.ts"
import {
  type ResolvedStepConfiguration,
  stepExecutionLimits,
} from "../session-configuration.ts"
import type { ToolRegistry, ToolRouter } from "./registry.ts"

const FILE_EDITING_TOOLS = new Set(["apply_patch", "edit_file", "write_file"])

type ProviderToolCapabilities = Readonly<{
  supportsCustomTools: boolean
  nativeDeferredProtocol?: Extract<
    ToolWireProtocol,
    "anthropic_deferred" | "openai_deferred"
  >
  eagerTools?: boolean
}>

export type StepContext = Readonly<{
  configuration: ResolvedStepConfiguration
  target: ModelTarget
  modelInfo: ResolvedModel
  executionPolicy: ReturnType<typeof stepExecutionLimits>
  toolRouter: ToolRouter
  toolWireProtocol: ToolWireProtocol
  documentReading: DocumentReadingCapabilities
  userDocumentReading: DocumentReadingCapabilities
}>

export function captureStepContext(
  input: Readonly<{
    registry: ToolRegistry
    configuration: ResolvedStepConfiguration
    wireApi?: ModelWireApi
    nativePdf?: boolean
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
  const provider = providerToolCapabilities(target.provider, input.wireApi)
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
  const documentReading: DocumentReadingCapabilities = Object.freeze({
    nativePdf,
    // These are first-party PDF transport limits, not model context estimates.
    // https://developers.openai.com/api/docs/guides/file-inputs
    // https://ai.google.dev/gemini-api/docs/generate-content/document-processing
    ...((nativePdf || nativeUserPdf) &&
    input.wireApi === "openai_chat_completions"
      ? {
          nativePdfLimits: {
            maxFileBytes: 50_000_000,
            fileLimitExclusive: true,
            maxRequestBytes: 50_000_000,
          },
        }
      : (nativePdf || nativeUserPdf) &&
          input.wireApi === "gemini_generate_content"
        ? {
            nativePdfLimits: {
              maxFileBytes: 50_000_000,
              maxRequestPages: 1_000,
              maxInlineBytes: GEMINI_INLINE_REQUEST_MAX_BYTES,
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
      enabledTrustedTools,
      customToolMode:
        model.supportsCustomTools && provider.supportsCustomTools
          ? "native"
          : "function",
      wireProtocol: toolWireProtocol,
    }),
    toolWireProtocol,
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
  // supply the protocol captured by their transport owner; direct stream
  // callers retain the existing built-in provider defaults.
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
    wireApi === "gemini_generate_content"
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
