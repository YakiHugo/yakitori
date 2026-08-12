import catalog from "./model-catalog.json" with { type: "json" }

export type PromptId = "anthropic" | "default" | "gpt" | "kimi"

export type ResolvedModel = {
  readonly provider: string
  readonly model: string
  readonly promptId: PromptId
}

export type CatalogModel = {
  readonly model: string
  readonly promptId: PromptId
  readonly displayName?: string
  readonly efforts?: readonly string[]
  readonly speeds?: readonly string[]
}

export function listCatalogModels(provider: string): CatalogModel[] {
  const normalized = provider.toLowerCase()
  return catalog.models
    .filter((entry) => entry.provider.toLowerCase() === normalized)
    .map((entry) => ({
      model: entry.model,
      promptId: requirePromptId(entry.promptId),
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

// Opt-in curation of the models.dev firehose: providers with an entry show
// only these ids, in this order; others show every sanitized model.
export function directoryAllowlist(
  provider: string,
): readonly string[] | undefined {
  return catalog.directoryAllowlist[
    provider.toLowerCase() as keyof typeof catalog.directoryAllowlist
  ]
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
  if (exact) return { ...input, promptId: requirePromptId(exact.promptId) }

  const fallback = catalog.fallbackRules.find((rule) =>
    matchesRule(model, rule),
  )
  if (fallback) {
    return { ...input, promptId: requirePromptId(fallback.promptId) }
  }

  const providerDefault =
    catalog.providerDefaults[provider as keyof typeof catalog.providerDefaults]
  return {
    ...input,
    promptId: requirePromptId(providerDefault ?? catalog.defaultPromptId),
  }
}

type FallbackRule = {
  readonly promptId: string
  readonly modelContainsAny?: readonly string[]
  readonly modelContainsAll?: readonly string[]
  readonly modelMatchesAny?: readonly string[]
}

function matchesRule(model: string, rule: FallbackRule): boolean {
  const containsAny = rule.modelContainsAny ?? []
  const containsAll = rule.modelContainsAll ?? []
  const matchesAny = rule.modelMatchesAny ?? []
  return (
    (containsAny.length > 0 &&
      containsAny.some((part) => model.includes(part))) ||
    (containsAll.length > 0 &&
      containsAll.every((part) => model.includes(part))) ||
    (matchesAny.length > 0 &&
      matchesAny.some((pattern) => new RegExp(pattern, "u").test(model)))
  )
}

export function requirePromptId(value: string): PromptId {
  if (
    value === "anthropic" ||
    value === "default" ||
    value === "gpt" ||
    value === "kimi"
  ) {
    return value
  }
  throw new Error(`Unknown prompt ID in model catalog: ${value}`)
}
