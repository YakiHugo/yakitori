import type { ModelTarget, ToolWireProtocol } from "../model.ts"
import type { ResolvedModel } from "../model-catalog.ts"
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
}>

export function captureStepContext(input: {
  readonly registry: ToolRegistry
  readonly configuration: ResolvedStepConfiguration
}): StepContext {
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
    input.configuration.enabledTools.filter(
      (name) =>
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
