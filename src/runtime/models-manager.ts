import {
  catalogModelCapacity,
  type CatalogModel,
  listCatalogModels,
  type ModelCapacity,
  type ModelInputModality,
  type ResolvedModel,
  resolveModel,
  validateModelSelection,
} from "./model-catalog.ts"

export type ModelSelectionInput = Readonly<{
  provider: string
  model: string
  effort?: string
  speed?: string
}>

// Mirrors Codex's ModelsManager boundary: callers read one provider-scoped
// catalog owner instead of consulting the bundled catalog independently.
// Static managers are the fallback for providers without a discovery API.
export type ModelsManager = {
  readonly provider: string
  refresh(): Promise<void>
  listModels(): Promise<readonly CatalogModel[]>
  resolve(selection: ModelSelectionInput): ResolvedModel
  validate(selection: ModelSelectionInput): void
  capacity(selection: ModelSelectionInput): ModelCapacity | undefined
}

export type DiscoveredModel = Readonly<{
  instructions?: string
  efforts?: readonly string[]
  inputModalities?: readonly ModelInputModality[]
  id: string
  displayName?: string
  autoCompactTokenLimit?: number
  compactionHash?: string
  contextWindowTokens?: number
  maxContextWindowTokens?: number
  effectiveContextWindowPercent?: number
}>

export function createDiscoveringModelsManager(input: {
  provider: string
  discover(): Promise<readonly DiscoveredModel[]>
  now?: () => number
  ttlMs?: number
}): ModelsManager {
  const fallback = createStaticModelsManager(input.provider)
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 5 * 60 * 1_000
  let remote = new Map<string, DiscoveredModel>()
  let refreshedAt: number | undefined
  let refresh: Promise<void> | undefined

  const ensureFresh = async () => {
    if (refreshedAt !== undefined && now() - refreshedAt < ttlMs) return
    refresh ??= input
      .discover()
      .then((models) => {
        remote = new Map(models.map((model) => [model.id.toLowerCase(), model]))
        refreshedAt = now()
      })
      .finally(() => {
        refresh = undefined
      })
    try {
      await refresh
    } catch {
      // The bundled catalog remains usable offline and after credential expiry.
      refreshedAt = now()
    }
  }
  const discovered = (model: string) => remote.get(model.toLowerCase())

  return {
    provider: input.provider,
    refresh: ensureFresh,
    async listModels() {
      await ensureFresh()
      const staticModels = await fallback.listModels()
      const staticById = new Map(
        staticModels.map((model) => [model.model.toLowerCase(), model]),
      )
      return [
        ...[...remote.values()]
          .filter(
            (model) =>
              staticById.has(model.id.toLowerCase()) ||
              model.instructions !== undefined,
          )
          .map((model) => {
            const base = staticById.get(model.id.toLowerCase())
            return {
              ...(base ??
                fallback.resolve({
                  provider: input.provider,
                  model: model.id,
                })),
              model: model.id,
              ...(model.efforts === undefined
                ? {}
                : { efforts: model.efforts, effortStyle: "levels" as const }),
              ...(model.inputModalities === undefined
                ? {}
                : { inputModalities: model.inputModalities }),
              ...(model.displayName === undefined
                ? {}
                : { displayName: model.displayName }),
              ...(model.autoCompactTokenLimit === undefined
                ? {}
                : { autoCompactTokenLimit: model.autoCompactTokenLimit }),
              ...(model.compactionHash === undefined
                ? {}
                : { compactionHash: model.compactionHash }),
            }
          }),
        ...staticModels.filter(
          (model) => !remote.has(model.model.toLowerCase()),
        ),
      ]
    },
    resolve(selection) {
      requireProvider(input.provider, selection.provider)
      const base = fallback.resolve(selection)
      const model = discovered(selection.model)
      if (model === undefined) return base
      return {
        ...base,
        ...(model.inputModalities === undefined
          ? {}
          : { inputModalities: model.inputModalities }),
        ...(model.instructions === undefined
          ? {}
          : { instructions: model.instructions }),
        ...(model.autoCompactTokenLimit === undefined
          ? {}
          : { autoCompactTokenLimit: model.autoCompactTokenLimit }),
        ...(model.compactionHash === undefined
          ? {}
          : { compactionHash: model.compactionHash }),
        usedFallbackModelMetadata: base.usedFallbackModelMetadata,
      }
    },
    validate(selection) {
      requireProvider(input.provider, selection.provider)
      const model = discovered(selection.model)
      if (model?.efforts !== undefined && selection.effort !== undefined) {
        if (!model.efforts.includes(selection.effort)) {
          throw new Error(
            `Reasoning effort ${selection.effort} is not supported by ${input.provider}/${selection.model}.`,
          )
        }
        const { effort: _, ...rest } = selection
        fallback.validate(rest)
      } else fallback.validate(selection)
    },
    capacity(selection) {
      requireProvider(input.provider, selection.provider)
      const model = discovered(selection.model)
      if (model?.contextWindowTokens === undefined)
        return fallback.capacity(selection)
      return {
        contextWindowTokens: model.contextWindowTokens,
        maxContextWindowTokens:
          model.maxContextWindowTokens ?? model.contextWindowTokens,
        effectiveContextWindowPercent:
          model.effectiveContextWindowPercent ?? 100,
      }
    },
  }
}

export function createStaticModelsManager(provider: string): ModelsManager {
  return {
    provider,
    async refresh() {},
    async listModels() {
      return listCatalogModels(provider)
    },
    resolve(selection) {
      requireProvider(provider, selection.provider)
      return resolveModel(selection)
    },
    validate(selection) {
      requireProvider(provider, selection.provider)
      validateModelSelection(selection)
    },
    capacity(selection) {
      requireProvider(provider, selection.provider)
      return catalogModelCapacity(selection)
    },
  }
}

function requireProvider(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(
      `Models manager for ${expected} cannot resolve provider ${actual}.`,
    )
  }
}
