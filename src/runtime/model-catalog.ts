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
