import type { ConfiguredModel } from "../protocol/providers.ts"
import {
  type EffectiveModel,
  effectiveModelCapacity,
  effectiveModelDirectory,
  mergeEffectiveModel,
  validateEffectiveModel,
} from "./effective-model.ts"
import { DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS } from "./model.ts"
import {
  type CatalogModel,
  catalogModelCapacity,
  listCatalogModels,
  type ModelCapabilities,
  type ModelCapacity,
  type ModelToolOutputTruncation,
  type ResolvedModel,
  resolveModel,
} from "./model-catalog.ts"
import { isChatModel, NonChatModelError } from "./model-kind.ts"
import { modelVisibleByDefault } from "./model-policy.ts"

export type ModelSelectionInput = Readonly<{
  provider: string
  model: string
  effort?: string
  speed?: string
}>

// Mirrors Codex's ModelsManager boundary: callers read one provider-scoped
// catalog owner instead of consulting the bundled catalog independently.
// Cached catalogs revalidate in the background; cold or explicitly forced
// refreshes wait for discovery. Static managers need no network refresh.
export type ModelsManager = {
  readonly provider: string
  // Dynamic metadata owners fix published execution facts in their capture.
  // Wrappers overriding facts must capture their own view, rather than inherit
  // another owner's snapshot. A cold capture may initialize before its first read.
  capture?(): ModelsManager
  refresh(options?: Readonly<{ force?: boolean }>): Promise<void>
  listModels(
    options?: Readonly<{ includeHidden?: boolean }>,
  ): Promise<readonly CatalogModel[]>
  subscribe?(listener: () => void): () => void
  status?(): Readonly<{ fetchedAt?: number; error?: string }>
  resolve(selection: ModelSelectionInput): ResolvedModel
  validate(selection: ModelSelectionInput): void
  capacity(selection: ModelSelectionInput): ModelCapacity | undefined
}

export type DiscoveredModel = Omit<
  ConfiguredModel,
  "visible" | "instructionProfileId"
> &
  Readonly<{
    toolOutputTruncation?: ModelToolOutputTruncation
    capabilities?: ModelCapabilities
    instructions?: string
    autoCompactTokenLimit?: number
    compactionHash?: string
    effectiveContextWindowPercent?: number
  }>

// The persisted form of a discovery result, written after each successful
// refresh so a cold process starts with the last good catalog (codex-rs keeps
// the same models_cache.json per identity). Expired entries can serve while
// revalidating; entries for a different identity are evicted before use.
export type PersistedModelsCache = Readonly<{
  catalogVersion?: string
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
  catalogProvider?: string
  discover(): Promise<readonly DiscoveredModel[]>
  identity(): Promise<string | undefined>
  cacheStore?: ModelsCacheStore
  catalogVersion?: string
  now?: () => number
  ttlMs?: number
}): ModelsManager {
  const fallback = createStaticModelsManager(
    input.provider,
    input.catalogProvider,
  )
  const listeners = new Set<() => void>()
  let error: string | undefined
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 5 * 60 * 1_000
  let cache:
    | Readonly<{
        identity: string | undefined
        fetchedAt: number
        models: Map<string, DiscoveredModel>
        effective: Map<string, EffectiveModel>
      }>
    | undefined
  const refreshTasks = new Map<
    string | undefined,
    Promise<{ saveTask: Promise<void> } | undefined>
  >()
  let diskLoadTask: Promise<void> | undefined
  let saveTask = Promise.resolve()

  // Identity probes only read local credential state; a failure means the
  // login is mid-rotation or gone, so the safe reading is "unknown".
  const currentIdentity = () => input.identity().catch(() => undefined)

  const staticModels = new Map(
    listCatalogModels(input.catalogProvider ?? input.provider).map((model) => [
      model.model.toLowerCase(),
      model,
    ]),
  )
  const indexModels = (discovered: readonly DiscoveredModel[]) => {
    const models = structuredClone(discovered)
    return {
      models: new Map(models.map((model) => [model.id.toLowerCase(), model])),
      effective: new Map(
        models.filter(isChatModel).map((model) => {
          const selection = { provider: input.provider, model: model.id }
          const base = fallback.resolve(selection)
          const effective = mergeEffectiveModel(
            {
              ...staticModels.get(model.id.toLowerCase()),
              ...base,
              ...fallback.capacity(selection),
              visible: modelVisibleByDefault(
                input.catalogProvider ?? input.provider,
                model.id,
                model.defaultVisible,
              ),
              usedFallbackModelMetadata:
                model.capabilities === undefined &&
                base.usedFallbackModelMetadata,
            },
            model,
          )
          return [model.id.toLowerCase(), effective]
        }),
      ),
    }
  }

  const loadDiskCache = () =>
    (diskLoadTask ??= (async () => {
      if (input.cacheStore === undefined) return
      // A cache that cannot be read degrades to a cold fetch. All first
      // readers await the same load before any of them can refresh.
      const persisted = await input.cacheStore.load().catch(() => undefined)
      if (persisted === undefined) return
      if (persisted.catalogVersion !== input.catalogVersion) return
      const identity = await currentIdentity()
      if (identity === undefined || persisted.identity !== identity) return
      cache = {
        identity: persisted.identity,
        fetchedAt: persisted.fetchedAt,
        ...indexModels(persisted.models),
      }
    })())

  const refreshRemotely = async (before: string | undefined) => {
    let models: readonly DiscoveredModel[]
    try {
      models = await input.discover()
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause
      error = cause.message
      return
    }
    const after = await currentIdentity()
    if (before === undefined || before !== after) {
      // The account changed mid-flight; the result belongs to the old account.
      if (cache !== undefined && cache.identity !== after) cache = undefined
      return
    }
    const previous = JSON.stringify([...(cache?.models.values() ?? [])])
    error = undefined
    const fetchedAt = now()
    cache = {
      identity: before,
      fetchedAt,
      ...indexModels(models),
    }
    if (previous !== JSON.stringify(models))
      for (const listener of listeners) listener()
    // Account-specific fetches may overlap. Serialize writes to their shared
    // cache file so the later result cannot be overwritten by an older save.
    saveTask = saveTask
      .then(() =>
        input.cacheStore?.save({
          identity: before,
          fetchedAt,
          models,
          ...(input.catalogVersion === undefined
            ? {}
            : { catalogVersion: input.catalogVersion }),
        }),
      )
      .catch(() => undefined)
    // Discovery is shareable only until publication. A pending disk write
    // must not satisfy a new cold fetch after this identity was evicted.
    return { saveTask }
  }

  const ensureFresh = async (options?: Readonly<{ force?: boolean }>) => {
    await loadDiskCache()
    const identity = await currentIdentity()
    if (
      cache !== undefined &&
      (identity === undefined || cache.identity !== identity)
    )
      cache = undefined
    if (identity === undefined) return
    if (
      !options?.force &&
      cache !== undefined &&
      now() - cache.fetchedAt < ttlMs
    )
      return
    let task = refreshTasks.get(identity)
    if (task === undefined) {
      task = refreshRemotely(identity).finally(() => {
        refreshTasks.delete(identity)
      })
      refreshTasks.set(identity, task)
    }
    if (cache === undefined || options?.force) await (await task)?.saveTask
  }
  const readManager = (snapshot: typeof cache): ModelsManager => {
    const resolve = (selection: ModelSelectionInput) => {
      requireProvider(input.provider, selection.provider)
      const discovered = snapshot?.models.get(selection.model.toLowerCase())
      if (discovered && !isChatModel(discovered))
        throw new NonChatModelError(input.provider, selection.model)
      return (
        snapshot?.effective.get(selection.model.toLowerCase()) ??
        fallback.resolve(selection)
      )
    }
    return {
      provider: input.provider,
      async refresh() {},
      status: () => ({
        ...(snapshot ? { fetchedAt: snapshot.fetchedAt } : {}),
        ...(error ? { error } : {}),
      }),
      async listModels(options) {
        const models = snapshot
          ? [...snapshot.effective.values()].map(effectiveModelDirectory)
          : await fallback.listModels({ includeHidden: true })
        return models.filter(
          (model) => options?.includeHidden || model.visible !== false,
        )
      },
      resolve,
      validate: (selection) =>
        validateEffectiveModel(resolve(selection), selection),
      capacity: (selection) => effectiveModelCapacity(resolve(selection)),
    }
  }
  const manager: ModelsManager = {
    provider: input.provider,
    refresh: ensureFresh,
    capture: () =>
      createModelsManagerCapture(manager, () => readManager(cache)),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    status: () => readManager(cache).status?.() ?? {},
    async listModels(options) {
      await ensureFresh()
      return readManager(cache).listModels(options)
    },
    resolve: (selection) => readManager(cache).resolve(selection),
    validate: (selection) => readManager(cache).validate(selection),
    capacity: (selection) => readManager(cache).capacity(selection),
  }
  return manager
}

export function createStaticModelsManager(
  provider: string,
  catalogProvider = provider,
): ModelsManager {
  const known = new Map(
    listCatalogModels(catalogProvider).map((model) => [
      model.model.toLowerCase(),
      model,
    ]),
  )
  const resolve = (selection: ModelSelectionInput): EffectiveModel => {
    requireProvider(provider, selection.provider)
    return {
      ...known.get(selection.model.toLowerCase()),
      ...resolveModel({ ...selection, provider: catalogProvider }),
      ...catalogModelCapacity({ ...selection, provider: catalogProvider }),
      ...(catalogProvider === "anthropic" || catalogProvider === "kimi-code"
        ? { defaultOutputTokens: DEFAULT_MESSAGES_MAX_OUTPUT_TOKENS }
        : {}),
      provider,
      visible: modelVisibleByDefault(catalogProvider, selection.model),
    }
  }
  const manager: ModelsManager = {
    provider,
    capture: () => manager,
    async refresh() {},
    async listModels(options) {
      return [...known.values()]
        .map((model) =>
          effectiveModelDirectory(resolve({ provider, model: model.model })),
        )
        .filter((model) => options?.includeHidden || model.visible !== false)
    },
    resolve,
    validate: (selection) =>
      validateEffectiveModel(resolve(selection), selection),
    capacity: (selection) => effectiveModelCapacity(resolve(selection)),
  }
  return manager
}

export function captureModelsManager(source: ModelsManager): ModelsManager {
  return source.capture?.() ?? source
}

// A Turn may await its first discovery refresh. Once any execution read has
// observed the catalog, every later read belongs to that same published view.
export function createModelsManagerCapture(
  source: ModelsManager,
  snapshot: () => ModelsManager,
): ModelsManager {
  let captured: ModelsManager | undefined
  let initializing: Promise<void> | undefined
  const current = () => (captured ??= snapshot())
  const refresh = async (options?: Readonly<{ force?: boolean }>) => {
    if (captured) return
    initializing ??= source.refresh(options).then(() => {
      current()
    })
    await initializing
  }
  const manager: ModelsManager = {
    provider: source.provider,
    capture: () => manager,
    refresh,
    async listModels(options) {
      await refresh()
      return current().listModels(options)
    },
    status: () => (captured ?? source).status?.() ?? {},
    resolve: (selection) => current().resolve(selection),
    validate: (selection) => current().validate(selection),
    capacity: (selection) => current().capacity(selection),
  }
  return manager
}

function requireProvider(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(
      `Models manager for ${expected} cannot resolve provider ${actual}.`,
    )
  }
}
