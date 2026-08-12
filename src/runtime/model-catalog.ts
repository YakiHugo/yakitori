import catalog from "./model-catalog.json" with { type: "json" }

export type PromptId = "anthropic" | "default" | "gpt" | "kimi"

export type ResolvedModel = {
  readonly provider: string
  readonly model: string
  readonly promptId: PromptId
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
