import catalog from "./model-catalog.json" with { type: "json" }
import instructionManifest from "./prompts/manifest.json" with { type: "json" }

export type InstructionProfileId = keyof typeof instructionManifest

export type ModelFacts = Readonly<{
  // Opt-in execution restriction, not a claim about vendor tool capabilities.
  toolPolicy?: "chat_only"
  contextWindowTokens?: number
  maxContextWindowTokens?: number
  contextWindowScope?: "input" | "total"
  pricing?: import("../protocol/providers.ts").ConfiguredModel["pricing"]
  maxOutputTokens?: number
  inputModalities: readonly ModelInputModality[]
  imageDetailModes: readonly ModelImageDetailMode[]
  defaultEffort?: string
  efforts?: readonly string[]
  speeds?: readonly string[]
}>

export type HarnessProfile = Readonly<{
  toolOutputTruncation?: ModelToolOutputTruncation
  instructions?: string
  delegationInstructions?: ModelDelegationInstructions
  autoCompactTokenLimit?: number
  compactionHash?: string
  multiAgentReasoningEffort?: string
  // Requested budget and API capability are distinct. The curated Claude
  // request default is Yakitori policy, not an Anthropic API default.
  defaultOutputTokens?: number
  instructionProfileId: InstructionProfileId
  shellToolType: ModelShellToolType
  applyPatchToolType?: ModelApplyPatchToolType
  fileEditingToolType: ModelFileEditingToolType
  supportsNativeToolSearch: boolean
  supportsCustomTools: boolean
}>

type RequestModelFacts = Omit<
  ModelFacts,
  | "contextWindowTokens"
  | "maxContextWindowTokens"
  | "contextWindowScope"
  | "pricing"
>

export type ResolvedModel = RequestModelFacts &
  HarnessProfile &
  Readonly<{
    provider: string
    model: string
    usedFallbackModelMetadata: boolean
  }>

export type CatalogModel = ModelFacts &
  Omit<
    HarnessProfile,
    "instructions" | "delegationInstructions" | "supportsCustomTools"
  > &
  Readonly<{
    model: string
    visible?: boolean
    supportsCustomTools?: boolean
    displayName?: string
    effortStyle?: "none" | "levels"
  }>

type CatalogEntry = (typeof catalog.models)[number]

const defaultHarnessProfile: HarnessProfile = {
  instructionProfileId: "default",
  shellToolType: "unified_exec",
  fileEditingToolType: "edit_write",
  supportsNativeToolSearch: false,
  supportsCustomTools: false,
}

export type ModelInputModality = "image" | "text" | "video"
// Codex mode overrides. Presence, including {}, selects Codex's effort-based
// defaults for discovered models without a bundled instruction profile.
export type ModelDelegationInstructions = Readonly<{
  explicit?: string
  proactive?: string
  hint?: string
}>
export type ModelToolOutputTruncation = Readonly<{
  mode: "bytes" | "tokens"
  limit: number
}>

// Codex's fallback model history budget; this is harness policy, not a
// provider quota. A discovered model's truncation_policy takes precedence.
export const DefaultToolOutputTruncation: ModelToolOutputTruncation = {
  mode: "bytes",
  limit: 10_000,
}
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
  // Carry the execution restriction with the capacity snapshot so settings can
  // preserve its input/total scope without resolving a directory-only model.
  toolPolicy?: "chat_only"
  contextWindowTokens: number
  maxContextWindowTokens: number
  effectiveContextWindowPercent: number
  // Codex's effective window already reserves model output headroom.
  contextWindowScope: "input" | "total"
}>

export function listCatalogModels(provider: string): CatalogModel[] {
  const normalized = provider.toLowerCase()
  return catalog.models
    .filter((entry) => entry.provider.toLowerCase() === normalized)
    .map((entry) => {
      const facts = catalogRequestFacts(entry)
      const { supportsCustomTools, ...profile } = catalogHarnessProfile(
        entry,
        facts,
      )
      return {
        model: entry.model,
        ...facts,
        ...profile,
        ...(entry.supportsCustomTools === undefined
          ? {}
          : { supportsCustomTools }),
        ...("displayName" in entry && entry.displayName !== undefined
          ? { displayName: entry.displayName }
          : {}),
        ...("effortStyle" in entry &&
        (entry.effortStyle === "none" || entry.effortStyle === "levels")
          ? { effortStyle: entry.effortStyle }
          : {}),
      }
    })
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
    const facts = catalogRequestFacts(entry)
    return {
      ...input,
      ...facts,
      ...catalogHarnessProfile(entry, facts),
      usedFallbackModelMetadata: false,
    }
  }
  const fallback = resolveFallbackModel(input)
  const provider = input.provider.toLowerCase()
  // ID-only catalogs omit the Codex editing format. Discovery can override
  // these defaults with the subscription account's actual capabilities.
  // https://github.com/openai/codex/blob/bb5b9c6240136de8ff4d30215e2341c44559aa04/codex-rs/models-manager/models.json
  if (
    (provider === "openai" ||
      provider === "codex" ||
      provider === "chatgpt-plan") &&
    (input.model === "gpt-6.2-sol" || input.model === "gpt-6.2-astra")
  ) {
    return {
      ...fallback,
      applyPatchToolType: "custom",
      fileEditingToolType: "none",
      supportsCustomTools: true,
    }
  }
  // Kimi Code binds one shared agent profile independently of its model alias.
  // New aliases inherit that profile, never another SKU's limits or efforts.
  return provider === "kimi-code"
    ? {
        ...fallback,
        instructionProfileId: "kimi-code",
        usedFallbackModelMetadata: false,
      }
    : fallback
}

export function resolveFallbackModel(
  input: Pick<ResolvedModel, "provider" | "model">,
): ResolvedModel {
  return {
    provider: input.provider,
    model: input.model,
    ...defaultHarnessProfile,
    inputModalities: ["text"],
    imageDetailModes: [],
    usedFallbackModelMetadata: true,
  }
}

function catalogRequestFacts(entry: CatalogEntry): RequestModelFacts {
  const efforts = "efforts" in entry ? entry.efforts : undefined
  return {
    inputModalities: requireInputModalities(entry.inputModalities),
    imageDetailModes: requireImageDetailModes(entry.imageDetailModes),
    ...(efforts === undefined ? {} : { efforts }),
    ...("defaultEffort" in entry && entry.defaultEffort !== undefined
      ? {
          defaultEffort: requireCatalogEffort(
            entry,
            efforts,
            entry.defaultEffort,
          ),
        }
      : {}),
    ...("speeds" in entry && entry.speeds !== undefined
      ? { speeds: entry.speeds }
      : {}),
    ...(entry.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: entry.maxOutputTokens }),
  }
}

// Claude limits: https://platform.claude.com/docs/en/models/overview and the
// linked model specification pages. Yakitori uses 32k for curated Claude
// requests, following the documented Claude Code fallback request budget:
// https://code.claude.com/docs/en/env-vars#variables
function catalogHarnessProfile(
  entry: CatalogEntry,
  facts: RequestModelFacts,
): HarnessProfile {
  return {
    ...defaultHarnessProfile,
    instructionProfileId: requireInstructionProfileId(
      entry.instructionProfileId,
    ),
    shellToolType: requireShellToolType(entry.shellToolType),
    fileEditingToolType: requireFileEditingToolType(entry.fileEditingToolType),
    supportsNativeToolSearch: entry.supportsNativeToolSearch,
    supportsCustomTools:
      entry.supportsCustomTools ?? defaultHarnessProfile.supportsCustomTools,
    ...(entry.applyPatchToolType === undefined
      ? {}
      : {
          applyPatchToolType: requireApplyPatchToolType(
            entry.applyPatchToolType,
          ),
        }),
    ...(entry.defaultOutputTokens === undefined
      ? {}
      : { defaultOutputTokens: entry.defaultOutputTokens }),
    ...("toolOutputTruncation" in entry
      ? {
          toolOutputTruncation: requireToolOutputTruncation(
            entry.toolOutputTruncation,
          ),
        }
      : {}),
    ...("autoCompactTokenLimit" in entry &&
    typeof entry.autoCompactTokenLimit === "number"
      ? { autoCompactTokenLimit: entry.autoCompactTokenLimit }
      : {}),
    ...("compactionHash" in entry && typeof entry.compactionHash === "string"
      ? { compactionHash: entry.compactionHash }
      : {}),
    ...("multiAgentReasoningEffort" in entry &&
    entry.multiAgentReasoningEffort !== undefined
      ? {
          multiAgentReasoningEffort: requireCatalogEffort(
            entry,
            facts.efforts,
            entry.multiAgentReasoningEffort,
          ),
        }
      : {}),
  }
}

function requireToolOutputTruncation(
  value: unknown,
): ModelToolOutputTruncation {
  if (
    typeof value !== "object" ||
    value === null ||
    !("mode" in value) ||
    !("limit" in value) ||
    (value.mode !== "bytes" && value.mode !== "tokens") ||
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 0
  )
    throw new Error("Invalid model tool-output truncation policy.")
  return { mode: value.mode, limit: value.limit }
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

// Mirrors Codex's ModelInfo::resolve_reasoning_effort: "ultra" is a picker
// alias for delegation mode and never reaches the wire. It resolves to the
// model's multi-agent effort when declared, then to "max", then to the last
// listed non-ultra stop. An unset effort resolves to the catalog default so
// codex requests always carry the model's default reasoning level.
export function resolveModelWireEffort(
  target: {
    readonly provider: string
    readonly model: string
    readonly effort?: string
  },
  metadata?: Pick<
    ResolvedModel,
    "efforts" | "defaultEffort" | "multiAgentReasoningEffort"
  >,
): string | undefined {
  // xAI's grok-4.20 SKUs reject `reasoning.effort` entirely — both the
  // non-reasoning and reasoning variants return HTTP 400 when it is set.
  if (
    metadata === undefined &&
    target.provider.toLowerCase() === "grok" &&
    /^grok-4\.20(?:-|$)/i.test(target.model)
  ) {
    return undefined
  }
  const entry = metadata ?? findCatalogEntry(target)
  if (entry === undefined) return target.effort
  if ("effortStyle" in entry && entry.effortStyle === "none") return undefined
  const efforts = "efforts" in entry ? entry.efforts : undefined
  if (efforts !== undefined && efforts.length === 0) return undefined
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
  if (entry === undefined || !("contextWindowTokens" in entry)) {
    return undefined
  }
  return {
    contextWindowTokens: entry.contextWindowTokens,
    maxContextWindowTokens:
      "maxContextWindowTokens" in entry
        ? entry.maxContextWindowTokens
        : entry.contextWindowTokens,
    effectiveContextWindowPercent:
      "effectiveContextWindowPercent" in entry
        ? entry.effectiveContextWindowPercent
        : 100,
    contextWindowScope: entry.provider === "codex" ? "input" : "total",
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
