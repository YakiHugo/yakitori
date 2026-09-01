import type { ModelTarget, ToolWireProtocol } from "../model.ts"
import type { ResolvedModel } from "../model-catalog.ts"
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
  target: ModelTarget
  modelInfo: ResolvedModel
  toolRouter: ToolRouter
  toolWireProtocol: ToolWireProtocol
}>

export function captureStepContext(input: {
  readonly registry: ToolRegistry
  readonly target: ModelTarget
  readonly modelInfo: ResolvedModel
  readonly enabledTools: readonly string[]
}): StepContext {
  const target = Object.freeze({ ...input.target })
  const model = Object.freeze({
    ...input.modelInfo,
    inputModalities: Object.freeze([...input.modelInfo.inputModalities]),
    imageDetailModes: Object.freeze([...input.modelInfo.imageDetailModes]),
  })
  if (model.provider !== target.provider || model.model !== target.model) {
    throw new Error("Step model metadata does not match its concrete target.")
  }
  const provider = providerToolCapabilities(target.provider)
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
  const enabledTrustedTools = new Set(
    input.enabledTools.filter(
      (name) =>
        (!FILE_EDITING_TOOLS.has(name) || fileEditingTools.has(name)) &&
        (model.shellToolType !== "disabled" ||
          (name !== "exec_command" && name !== "write_stdin")),
    ),
  )
  return {
    target,
    modelInfo: model,
    toolRouter: input.registry.finalize({
      enabledTrustedTools,
      customToolMode:
        model.supportsCustomTools && provider.supportsCustomTools
          ? "native"
          : "function",
      wireProtocol: toolWireProtocol,
    }),
    toolWireProtocol,
  }
}

function providerToolCapabilities(provider: string): ProviderToolCapabilities {
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
