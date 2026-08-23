import catalog from "./model-catalog.json" with { type: "json" }

export type InstructionProfileId =
  | "anthropic"
  | "codex"
  | "default"
  | "grok"
  | "kimi"

export type ResolvedModel = {
  readonly provider: string
  readonly model: string
  readonly instructionProfileId: InstructionProfileId
}

export type CatalogModel = {
  readonly model: string
  readonly instructionProfileId: InstructionProfileId
  readonly displayName?: string
  readonly efforts?: readonly string[]
  readonly speeds?: readonly string[]
}

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
      instructionProfileId: requireInstructionProfileId(
        entry.instructionProfileId,
      ),
      ...("displayName" in entry && entry.displayName !== undefined
        ? { displayName: entry.displayName }
        : {}),
      ...("efforts" in entry && entry.efforts !== undefined
        ? { efforts: entry.efforts }
        : {}),
      ...("speeds" in entry && entry.speeds !== undefined
        ? { speeds: entry.speeds }
        : {}),
    }))
}

export function resolveModel(input: {
  readonly provider: string
  readonly model: string
}): ResolvedModel {
  const provider = input.provider.toLowerCase()
  const model = input.model.toLowerCase()
  const exact = catalog.models.find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider &&
      candidate.model.toLowerCase() === model,
  )
  if (exact)
    return {
      ...input,
      instructionProfileId: requireInstructionProfileId(
        exact.instructionProfileId,
      ),
    }
  return { ...input, instructionProfileId: "default" }
}

export function validateModelSelection(input: {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}): void {
  const provider = input.provider.toLowerCase()
  const model = input.model.toLowerCase()
  const entry = catalog.models.find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider &&
      candidate.model.toLowerCase() === model,
  )
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
  const provider = input.provider.toLowerCase()
  const model = input.model.toLowerCase()
  const entry = catalog.models.find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider &&
      candidate.model.toLowerCase() === model,
  )
  if (entry === undefined || !("contextWindowTokens" in entry)) return undefined
  return entry.contextWindowTokens
}

export function catalogModelCapacity(input: {
  readonly provider: string
  readonly model: string
}): ModelCapacity | undefined {
  const provider = input.provider.toLowerCase()
  const model = input.model.toLowerCase()
  const entry = catalog.models.find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider &&
      candidate.model.toLowerCase() === model,
  )
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
  if (
    value === "anthropic" ||
    value === "codex" ||
    value === "default" ||
    value === "grok" ||
    value === "kimi"
  ) {
    return value
  }
  throw new Error(`Unknown instruction profile ID in model catalog: ${value}`)
}
