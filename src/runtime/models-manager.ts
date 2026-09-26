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
// refresh() revalidates an expired cache in the background and never blocks a
// Turn on the network for it. Static managers are the fallback for providers
// without a discovery API.
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

// The persisted form of a discovery result, written after each successful
// refresh so a cold process starts with the last good catalog (codex-rs keeps
// the same models_cache.json per identity). Entries older than the manager
// TTL are treated as absent, and identity mismatches are evicted on load.
export type PersistedModelsCache = Readonly<{
  identity: string | undefined
  fetchedAt: number
  models: readonly DiscoveredModel[]
}>

export type ModelsCacheStore = {
  load(): Promise<PersistedModelsCache | undefined>
  save(entry: PersistedModelsCache): Promise<void>
}

// Discovery results are scoped to the account that produced them: every cache
// entry carries the credential identity observed when it was fetched, entries
// from another account are evicted on sight, and a fetch whose account changed
// mid-flight is discarded (codex-rs models-manager does the same identity
// double-check around refresh). Callers never wait for an expired cache: a
// stale entry is served while a background fetch revalidates it. Only a cold
// cache (first use, or just evicted) blocks on the in-flight fetch — Codex's
// OnlineIfUncached — because discovered instruction profiles must be present
// in the first sampled prompt.
export function createDiscoveringModelsManager(input: {
  provider: string
  discover(): Promise<readonly DiscoveredModel[]>
  identity(): Promise<string | undefined>
  cacheStore?: ModelsCacheStore
  now?: () => number
  ttlMs?: number
}): ModelsManager {
  const fallback = createStaticModelsManager(input.provider)
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 5 * 60 * 1_000
  let cache:
    | {
        readonly identity: string | undefined
        readonly fetchedAt: number
        readonly models: Map<string, DiscoveredModel>
      }
    | undefined
  const refreshTasks = new Map<string | undefined, Promise<void>>()
  let diskLoadTask: Promise<void> | undefined
  let saveTask = Promise.resolve()

  // Identity probes only read local credential state; a failure means the
  // login is mid-rotation or gone, so the safe reading is "unknown".
  const currentIdentity = () => input.identity().catch(() => undefined)

  const indexModels = (
    models: readonly DiscoveredModel[],
  ): Map<string, DiscoveredModel> =>
    new Map(models.map((model) => [model.id.toLowerCase(), model]))

  const loadDiskCache = () =>
    (diskLoadTask ??= (async () => {
      if (input.cacheStore === undefined) return
      // A cache that cannot be read degrades to a cold fetch. All first
      // readers await the same load before any of them can refresh.
      const persisted = await input.cacheStore.load().catch(() => undefined)
      if (persisted === undefined || now() - persisted.fetchedAt >= ttlMs)
        return
      cache = {
        identity: persisted.identity,
        fetchedAt: persisted.fetchedAt,
        models: indexModels(persisted.models),
      }
    })())

  const refreshRemotely = async (before: string | undefined) => {
    let models: readonly DiscoveredModel[]
    try {
      models = await input.discover()
    } catch {
      // The last good cache and the bundled catalog keep serving offline.
      return
    }
    const after = await currentIdentity()
    if (before !== after) {
      // The account changed mid-flight; the result belongs to the old account.
      if (cache !== undefined && cache.identity !== after) cache = undefined
      return
    }
    const fetchedAt = now()
    cache = {
      identity: before,
      fetchedAt,
      models: indexModels(models),
    }
    // Account-specific fetches may overlap. Serialize writes to their shared
    // cache file so the later result cannot be overwritten by an older save.
    saveTask = saveTask
      .then(() =>
        input.cacheStore?.save({
          identity: before,
          fetchedAt,
          models,
        }),
      )
      .catch(() => undefined)
    await saveTask
  }

  const ensureFresh = async () => {
    await loadDiskCache()
    const identity = await currentIdentity()
    if (cache !== undefined && cache.identity !== identity) cache = undefined
    if (cache !== undefined && now() - cache.fetchedAt < ttlMs) return
    let task = refreshTasks.get(identity)
    if (task === undefined) {
      task = refreshRemotely(identity).finally(() => {
        refreshTasks.delete(identity)
      })
      refreshTasks.set(identity, task)
    }
    if (cache === undefined) await task
  }
  const discovered = (model: string) => cache?.models.get(model.toLowerCase())

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
        ...[...(cache?.models.values() ?? [])]
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
          (model) => !(cache?.models.has(model.model.toLowerCase()) ?? false),
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
