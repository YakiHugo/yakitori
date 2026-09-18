import catalog from "./model-catalog.json" with { type: "json" }
import instructionManifest from "./prompts/manifest.json" with { type: "json" }

export type InstructionProfileId = keyof typeof instructionManifest

export type ResolvedModel = Readonly<{
  instructions?: string
  autoCompactTokenLimit?: number
  compactionHash?: string
  provider: string
  model: string
  instructionProfileId: InstructionProfileId
  inputModalities: readonly ModelInputModality[]
  imageDetailModes: readonly ModelImageDetailMode[]
  shellToolType: ModelShellToolType
  applyPatchToolType?: ModelApplyPatchToolType
  fileEditingToolType: ModelFileEditingToolType
  supportsNativeToolSearch: boolean
  supportsCustomTools: boolean
  usedFallbackModelMetadata: boolean
}>

export type CatalogModel = Readonly<{
  autoCompactTokenLimit?: number
  compactionHash?: string
  model: string
  instructionProfileId: InstructionProfileId
  shellToolType: ModelShellToolType
  applyPatchToolType?: ModelApplyPatchToolType
  fileEditingToolType: ModelFileEditingToolType
  supportsNativeToolSearch: boolean
  supportsCustomTools?: boolean
  displayName?: string
  effortStyle?: "none" | "levels"
  efforts?: readonly string[]
  defaultEffort?: string
  multiAgentReasoningEffort?: string
  speeds?: readonly string[]
  inputModalities: readonly ModelInputModality[]
  imageDetailModes: readonly ModelImageDetailMode[]
}>

export type ModelInputModality = "image" | "text" | "video"
export type ModelImageDetailMode = "high" | "original"
export type ModelShellToolType = "disabled" | "unified_exec"
export type ModelApplyPatchToolType = "custom"
export type ModelFileEditingToolType = "edit_write" | "none" | "search_replace"

export type ModelCapabilities = Readonly<{
  inputModalities: readonly ModelInputModality[]
  imageDetailModes: readonly ModelImageDetailMode[]
  shellToolType: ModelShellToolType
  applyPatchToolType?: ModelApplyPatchToolType
  fileEditingToolType: ModelFileEditingToolType
  supportsNativeToolSearch: boolean
  supportsCustomTools: boolean
}>

export type ModelCapacity = Readonly<{
  contextWindowTokens: number
  maxContextWindowTokens: number
  effectiveContextWindowPercent: number
}>

export function listCatalogModels(provider: string): CatalogModel[] {
  const normalized = provider.toLowerCase()
  return catalog.models
    .filter((entry) => entry.provider.toLowerCase() === normalized)
    .map((entry) => ({
      model: entry.model,
      ...("autoCompactTokenLimit" in entry &&
      typeof entry.autoCompactTokenLimit === "number"
        ? { autoCompactTokenLimit: entry.autoCompactTokenLimit }
        : {}),
      ...("compactionHash" in entry && typeof entry.compactionHash === "string"
        ? { compactionHash: entry.compactionHash }
        : {}),
      instructionProfileId: requireInstructionProfileId(
        entry.instructionProfileId,
      ),
      shellToolType: requireShellToolType(entry.shellToolType),
      ...("applyPatchToolType" in entry &&
      entry.applyPatchToolType !== undefined
        ? {
            applyPatchToolType: requireApplyPatchToolType(
              entry.applyPatchToolType,
            ),
          }
        : {}),
      fileEditingToolType: requireFileEditingToolType(
        entry.fileEditingToolType,
      ),
      supportsNativeToolSearch: entry.supportsNativeToolSearch,
      ...(entry.supportsCustomTools === undefined
        ? {}
        : { supportsCustomTools: entry.supportsCustomTools }),
      ...("displayName" in entry && entry.displayName !== undefined
        ? { displayName: entry.displayName }
        : {}),
      ...("effortStyle" in entry &&
      (entry.effortStyle === "none" || entry.effortStyle === "levels")
        ? { effortStyle: entry.effortStyle }
        : {}),
      ...("efforts" in entry && entry.efforts !== undefined
        ? { efforts: entry.efforts }
        : {}),
      ...("defaultEffort" in entry && entry.defaultEffort !== undefined
        ? {
            defaultEffort: requireCatalogEffort(
              entry,
              "efforts" in entry ? entry.efforts : undefined,
              entry.defaultEffort,
            ),
          }
        : {}),
      ...("multiAgentReasoningEffort" in entry &&
      entry.multiAgentReasoningEffort !== undefined
        ? {
            multiAgentReasoningEffort: requireCatalogEffort(
              entry,
              "efforts" in entry ? entry.efforts : undefined,
              entry.multiAgentReasoningEffort,
            ),
          }
        : {}),
      ...("speeds" in entry && entry.speeds !== undefined
        ? { speeds: entry.speeds }
        : {}),
      inputModalities: requireInputModalities(entry.inputModalities),
      imageDetailModes: requireImageDetailModes(entry.imageDetailModes),
    }))
}

export function catalogModelCapabilities(input: {
  readonly provider: string
  readonly model: string
}): ModelCapabilities {
  const model = resolveModel(input)
  return {
    inputModalities: model.inputModalities,
    imageDetailModes: model.imageDetailModes,
    shellToolType: model.shellToolType,
    ...(model.applyPatchToolType === undefined
      ? {}
      : { applyPatchToolType: model.applyPatchToolType }),
    fileEditingToolType: model.fileEditingToolType,
    supportsNativeToolSearch: model.supportsNativeToolSearch,
    supportsCustomTools: model.supportsCustomTools,
  }
}

export function resolveModel(input: {
  readonly provider: string
  readonly model: string
}): ResolvedModel {
  const entry = findCatalogEntry(input)
  if (entry !== undefined) {
    return {
      ...input,
      ...("autoCompactTokenLimit" in entry &&
      typeof entry.autoCompactTokenLimit === "number"
        ? { autoCompactTokenLimit: entry.autoCompactTokenLimit }
        : {}),
      ...("compactionHash" in entry && typeof entry.compactionHash === "string"
        ? { compactionHash: entry.compactionHash }
        : {}),
      instructionProfileId: requireInstructionProfileId(
        entry.instructionProfileId,
      ),
      inputModalities: requireInputModalities(entry.inputModalities),
      imageDetailModes: requireImageDetailModes(entry.imageDetailModes),
      shellToolType: requireShellToolType(entry.shellToolType),
      ...(entry.applyPatchToolType === undefined
        ? {}
        : {
            applyPatchToolType: requireApplyPatchToolType(
              entry.applyPatchToolType,
            ),
          }),
      fileEditingToolType: requireFileEditingToolType(
        entry.fileEditingToolType,
      ),
      supportsNativeToolSearch: entry.supportsNativeToolSearch,
      supportsCustomTools: entry.supportsCustomTools ?? false,
      usedFallbackModelMetadata: false,
    }
  }
  return {
    ...input,
    instructionProfileId: "default",
    inputModalities: ["text"],
    imageDetailModes: [],
    shellToolType: "unified_exec",
    fileEditingToolType: "none",
    supportsNativeToolSearch: false,
    supportsCustomTools: false,
    usedFallbackModelMetadata: true,
  }
}

export function validateModelSelection(input: {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}): void {
  const entry = findCatalogEntry(input)
  if (entry === undefined) return
  if (
    input.effort !== undefined &&
    "efforts" in entry &&
    entry.efforts !== undefined &&
    !entry.efforts.includes(input.effort)
  ) {
    throw new Error(
      `Reasoning effort ${input.effort} is not supported by ${input.provider}/${input.model}.`,
    )
  }
  if (
    input.speed !== undefined &&
    "speeds" in entry &&
    entry.speeds !== undefined &&
    !entry.speeds.includes(input.speed)
  ) {
    throw new Error(
      `Speed ${input.speed} is not supported by ${input.provider}/${input.model}.`,
    )
  }
}

export function catalogContextWindowTokens(input: {
  readonly provider: string
  readonly model: string
}): number | undefined {
  const entry = findCatalogEntry(input)
  if (entry === undefined || !("contextWindowTokens" in entry)) return undefined
  return entry.contextWindowTokens
}

// Mirrors Codex's ModelInfo::resolve_reasoning_effort: "ultra" is a picker
// alias for delegation mode and never reaches the wire. It resolves to the
// model's multi-agent effort when declared, then to "max", then to the last
// listed non-ultra stop. An unset effort resolves to the catalog default so
// codex requests always carry the model's default reasoning level.
export function resolveModelWireEffort(target: {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}): string | undefined {
  const entry = findCatalogEntry(target)
  if (entry === undefined) return target.effort
  const efforts = "efforts" in entry ? entry.efforts : undefined
  if (target.effort === "ultra" && efforts?.includes("ultra")) {
    const multiAgent =
      "multiAgentReasoningEffort" in entry
        ? entry.multiAgentReasoningEffort
        : undefined
    if (
      typeof multiAgent === "string" &&
      multiAgent !== "ultra" &&
      efforts.includes(multiAgent)
    ) {
      return multiAgent
    }
    if (efforts.includes("max")) return "max"
    return (
      [...efforts].reverse().find((effort) => effort !== "ultra") ?? "medium"
    )
  }
  if (target.effort === undefined && "defaultEffort" in entry) {
    return entry.defaultEffort
  }
  return target.effort
}

export function catalogModelCapacity(input: {
  readonly provider: string
  readonly model: string
}): ModelCapacity | undefined {
  const entry = findCatalogEntry(input)
  if (
    entry === undefined ||
    !("contextWindowTokens" in entry) ||
    !("maxContextWindowTokens" in entry) ||
    !("effectiveContextWindowPercent" in entry)
  ) {
    return undefined
  }
  return {
    contextWindowTokens: entry.contextWindowTokens,
    maxContextWindowTokens: entry.maxContextWindowTokens,
    effectiveContextWindowPercent: entry.effectiveContextWindowPercent,
  }
}

export function requireInstructionProfileId(
  value: string,
): InstructionProfileId {
  if (Object.hasOwn(instructionManifest, value))
    return value as InstructionProfileId
  throw new Error(`Unknown instruction profile ID in model catalog: ${value}`)
}

function requireCatalogEffort(
  entry: { readonly provider: string; readonly model: string },
  efforts: readonly string[] | undefined,
  effort: string,
): string {
  if (efforts === undefined || !efforts.includes(effort)) {
    throw new Error(
      `Model catalog effort ${effort} is not in the effort list of ${entry.provider}/${entry.model}.`,
    )
  }
  if (effort === "ultra") {
    throw new Error(
      `Model catalog default for ${entry.provider}/${entry.model} cannot be the ultra alias.`,
    )
  }
  return effort
}

function requireShellToolType(value: string): ModelShellToolType {
  if (value === "disabled" || value === "unified_exec") return value
  throw new Error(`Unknown shell tool type in model catalog: ${value}`)
}

function requireApplyPatchToolType(value: string): ModelApplyPatchToolType {
  if (value === "custom") return value
  throw new Error(`Unknown apply_patch tool type in model catalog: ${value}`)
}

function requireFileEditingToolType(value: string): ModelFileEditingToolType {
  if (
    value === "edit_write" ||
    value === "none" ||
    value === "search_replace"
  ) {
    return value
  }
  throw new Error(`Unknown file editing tool type in model catalog: ${value}`)
}

function findCatalogEntry(input: {
  readonly provider: string
  readonly model: string
}) {
  const provider = input.provider.toLowerCase()
  const model = input.model.toLowerCase()
  return catalog.models.find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider &&
      candidate.model.toLowerCase() === model,
  )
}

function requireInputModalities(
  values: readonly string[] | undefined,
): readonly ModelInputModality[] {
  const modalities = values ?? ["text"]
  if (
    modalities.length === 0 ||
    modalities.some(
      (value) => value !== "image" && value !== "text" && value !== "video",
    )
  ) {
    throw new Error("Model catalog contains invalid input modalities.")
  }
  return modalities as readonly ModelInputModality[]
}

function requireImageDetailModes(
  values: readonly string[] | undefined,
): readonly ModelImageDetailMode[] {
  const modes = values ?? []
  if (modes.some((value) => value !== "high" && value !== "original")) {
    throw new Error("Model catalog contains invalid image detail modes.")
  }
  return modes as readonly ModelImageDetailMode[]
}
