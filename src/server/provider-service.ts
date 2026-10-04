import {
  createProviderContinuationScope,
  providerPresets,
  type ModelProvider,
} from "../runtime/index.ts"
import { ConfigurationError } from "./config-errors.ts"
import { createProviderCredentialStore } from "./provider-credentials.ts"
import {
  type ApiConfiguredProvider,
  providerConfigValue,
  type ProviderConfiguration,
  requireProviderConfiguration,
  requireProviderId,
  type StoredProviderConfiguration,
} from "./provider-configuration.ts"
import type { UserConfigStore } from "./user-config.ts"
import { discoverProviderModels } from "./provider-model-discovery.ts"
import { createProviderModelCatalog } from "./provider-model-catalog.ts"
import { join } from "node:path"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { createConfiguredProvider } from "./configured-provider.ts"
import { createProviderConfigurationHistory } from "./provider-configuration-history.ts"
import type {
  SubscriptionConnection,
  SubscriptionConnections,
} from "./subscription-connections.ts"

export type ProviderConfigurationResponse = Readonly<{
  providers: readonly ApiConfiguredProvider[]
  presets: typeof providerPresets
  subscriptions: readonly SubscriptionConnection[]
  undoId?: string
}>

export type ProviderWriteInput = Readonly<{
  id?: string
  configuration: ProviderConfiguration
  apiKey?: string
}>

export type ProviderService = {
  read(): Promise<ProviderConfigurationResponse>
  write(input: ProviderWriteInput): Promise<ProviderConfigurationResponse>
  delete(id: string): Promise<ProviderConfigurationResponse>
  test(input: ProviderWriteInput): Promise<Readonly<{ ok: true }>>
  discover(
    input: ProviderWriteInput,
  ): Promise<
    readonly import("../runtime/provider-presets.ts").ConfiguredModel[]
  >
  reload(): Promise<Readonly<Record<string, ModelProvider>>>
  refreshModels(id: string): Promise<ProviderConfigurationResponse>
  preview(input: ProviderWriteInput): Promise<
    Readonly<{
      configuration: ProviderConfiguration
      models: readonly ConfiguredModel[]
      credentialChanges: boolean
    }>
  >
  restore(undoId: string): Promise<ProviderConfigurationResponse>
  move(id: string, beforeId?: string): Promise<ProviderConfigurationResponse>
  login(id: string): Promise<readonly SubscriptionConnection[]>
  cancelLogin(id: string): Promise<readonly SubscriptionConnection[]>
  importSubscription(
    id: string,
    text?: string,
  ): Promise<readonly SubscriptionConnection[]>
}

export function createProviderService(
  input: Readonly<{
    userConfig: UserConfigStore
    credentialDirectory: string
    now?: () => number
    catalogTtlMs?: number
    changed?(): void
    subscriptions?: () => SubscriptionConnections | undefined
    apply(
      providers: Readonly<Record<string, ModelProvider>>,
      configurations: Readonly<Record<string, StoredProviderConfiguration>>,
    ): void
  }>,
): ProviderService {
  const credentials = createProviderCredentialStore(input.credentialDirectory)
  const history = createProviderConfigurationHistory(
    join(input.credentialDirectory, "..", "provider-history"),
  )
  const catalogs = new Map<
    string,
    ReturnType<typeof createProviderModelCatalog>
  >()
  const connections = new Map<
    string,
    {
      identity: string
      status: NonNullable<ApiConfiguredProvider["connection"]>
    }
  >()
  let reloadGeneration = 0
  let activeProviders: Readonly<Record<string, ModelProvider>> = {}
  let activeIdentities = new Map<string, string>()
  const catalogFor = (
    id: string,
    configuration: ProviderConfiguration,
    key: string,
  ) => {
    const identity = `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`
    let catalog = catalogs.get(identity)
    if (!catalog) {
      catalog = createProviderModelCatalog({
        directory: join(input.credentialDirectory, "..", "provider-models"),
        identity,
        discover: () => discover(configuration, key),
        changed: () => input.changed?.(),
        ...(input.now ? { now: input.now } : {}),
        ...(input.catalogTtlMs === undefined
          ? {}
          : { ttlMs: input.catalogTtlMs }),
      })
      catalogs.set(identity, catalog)
    }
    return catalog
  }
  const resolveKey = async (configuration: StoredProviderConfiguration) => {
    const stored =
      configuration.credentialRef === undefined
        ? undefined
        : await credentials.read(configuration.credentialRef)
    return (
      stored ??
      (configuration.envKey === undefined
        ? undefined
        : process.env[configuration.envKey]?.trim() || undefined) ??
      (configuration.noKey ? "local-no-key" : undefined)
    )
  }
  const reload = async () => {
    const generation = ++reloadGeneration
    await input.subscriptions?.()?.refresh()
    const configurations =
      (await input.userConfig.readConfiguration()).modelProviders ?? {}
    const entries = await Promise.all(
      Object.entries(configurations).map(async ([id, configuration]) => {
        const key = await resolveKey(configuration)
        if (key === undefined || configuration.enabled === false) return []
        const catalog = catalogFor(id, configuration, key)
        let discovered: readonly ConfiguredModel[]
        try {
          discovered = await catalog.models()
        } catch (error) {
          if (!(error instanceof ConfigurationError)) throw error
          if (!configuration.models.length) return []
          discovered = []
        }
        const resolved = {
          ...configuration,
          models: exposedModels(configuration, discovered),
        }
        return [
          [
            id,
            createConfiguredProvider(id, resolved, key, {
              async loadModels() {
                await catalog.revalidate()
                return exposedModels(configuration, await catalog.models())
              },
              result(state, message) {
                if (
                  activeIdentities.get(id) !==
                  `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`
                )
                  return
                connections.set(id, {
                  identity: `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`,
                  status: {
                    state,
                    checkedAt: (input.now ?? Date.now)(),
                    ...(message ? { message } : {}),
                  },
                })
                input.changed?.()
              },
            }),
          ] as const,
        ]
      }),
    )
    const providers = Object.fromEntries(entries.flat())
    const identities = new Map(
      await Promise.all(
        Object.entries(configurations).map(async ([id, configuration]) => {
          const key = await resolveKey(configuration)
          return [
            id,
            key
              ? `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`
              : "",
          ] as const
        }),
      ),
    )
    if (generation !== reloadGeneration) return activeProviders
    activeIdentities = identities
    activeProviders = providers
    input.apply(providers, configurations)
    return providers
  }
  const read = async (): Promise<ProviderConfigurationResponse> => {
    const configurations =
      (await input.userConfig.readConfiguration()).modelProviders ?? {}
    return {
      presets: providerPresets,
      subscriptions: (await input.subscriptions?.()?.read()) ?? [],
      providers: await Promise.all(
        Object.entries(configurations).map(async ([id, stored]) => {
          const { credentialRef, ...configuration } = stored
          const storedKey =
            credentialRef === undefined
              ? undefined
              : await credentials.read(credentialRef)
          const key = await resolveKey(stored)
          const catalog =
            key === undefined
              ? undefined
              : catalogFor(id, configuration, key).snapshot()
          const observed = connections.get(id)
          const connection =
            key !== undefined &&
            observed?.identity ===
              `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`
              ? observed.status
              : undefined
          return {
            id,
            configuration,
            ...(catalog ? { catalog } : {}),
            ...(connection ? { connection } : {}),
            credential:
              storedKey !== undefined
                ? "stored"
                : configuration.envKey !== undefined &&
                    process.env[configuration.envKey]?.trim()
                  ? "environment"
                  : configuration.noKey
                    ? "optional"
                    : "missing",
          }
        }),
      ),
    }
  }
  const validateInput = (value: ProviderWriteInput) => {
    const id = value.id === undefined ? undefined : requireProviderId(value.id)
    const configuration = requireProviderConfiguration(value.configuration)
    if (
      configuration.preset !== undefined &&
      !providerPresets.some((preset) => preset.id === configuration.preset)
    )
      throw new ConfigurationError("Unknown provider preset.")
    if (
      value.apiKey !== undefined &&
      (typeof value.apiKey !== "string" ||
        value.apiKey.trim() === "" ||
        /[\r\n]/.test(value.apiKey))
    )
      throw new ConfigurationError("API key must be a non-empty single line.")
    return { id, configuration, apiKey: value.apiKey }
  }
  const discoverInput = async (value: ProviderWriteInput) => {
    const { id, configuration, apiKey } = validateInput(value)
    const previous =
      id === undefined
        ? undefined
        : (await input.userConfig.readConfiguration()).modelProviders?.[id]
    const key =
      apiKey ??
      (await resolveKey({
        ...configuration,
        ...(previous?.credentialRef === undefined
          ? {}
          : { credentialRef: previous.credentialRef }),
      }))
    if (key === undefined)
      throw new ConfigurationError(
        "Enter an API key or choose a local service that needs no key.",
      )
    return discover(configuration, key)
  }
  const discover = async (
    configuration: ProviderConfiguration,
    key: string,
  ) => {
    const found = await discoverProviderModels(configuration, key)
    const preset = providerPresets.find(
      (entry) => entry.id === configuration.preset,
    )
    return found.map((model) => ({
      ...preset?.models.find((known) => known.id === model.id),
      ...model,
    }))
  }
  return {
    read,
    reload,
    discover: discoverInput,
    async move(id, beforeId) {
      if (beforeId !== undefined) requireProviderId(beforeId)
      const snapshot = await input.userConfig.readSnapshot()
      const entries = Object.entries(
        snapshot.configuration.modelProviders ?? {},
      )
      const source = entries.find((entry) => entry[0] === requireProviderId(id))
      if (
        !source ||
        (beforeId !== undefined &&
          !entries.some((entry) => entry[0] === beforeId))
      )
        throw new ConfigurationError("Provider connection does not exist.")
      const next = entries.filter((entry) => entry[0] !== id)
      const index =
        beforeId === undefined
          ? next.length
          : next.findIndex((entry) => entry[0] === beforeId)
      if (id === beforeId) return read()
      next.splice(index, 0, source)
      await input.userConfig.writeValue({
        keyPath: ["model_providers"],
        value: Object.fromEntries(
          next.map(([name, provider]) => [name, providerConfigValue(provider)]),
        ),
        expectedVersion:
          snapshot.layers.find((layer) => layer.source === "user")?.version ??
          "",
      })
      await reload()
      return read()
    },
    async preview(value) {
      const validated = validateInput(value)
      const models = validated.configuration.models.length
        ? validated.configuration.models
        : await discoverInput(value)
      return {
        configuration: validated.configuration,
        models,
        credentialChanges: value.apiKey !== undefined,
      }
    },
    async restore(undoId) {
      const snapshot = await input.userConfig.readSnapshot()
      const current = snapshot.configuration.modelProviders ?? {}
      const change = await history.read(undoId, current)
      const next = { ...current }
      if (change.before) next[change.id] = change.before
      else delete next[change.id]
      const redoId = await history.record(
        change.id,
        current[change.id],
        change.before,
      )
      await input.userConfig.writeValue({
        keyPath: ["model_providers"],
        value: Object.fromEntries(
          Object.entries(next).map(([id, provider]) => [
            id,
            providerConfigValue(provider),
          ]),
        ),
        expectedVersion:
          snapshot.layers.find((layer) => layer.source === "user")?.version ??
          "",
      })
      connections.delete(change.id)
      await reload()
      return { ...(await read()), undoId: redoId }
    },
    async refreshModels(id) {
      const configuration = (await input.userConfig.readConfiguration())
        .modelProviders?.[requireProviderId(id)]
      if (!configuration)
        throw new ConfigurationError("Provider connection does not exist.")
      const key = await resolveKey(configuration)
      if (!key)
        throw new ConfigurationError("This connection needs an API key.")
      await catalogFor(id, configuration, key).refresh()
      await reload()
      return read()
    },
    async login(id) {
      const subscriptions = input.subscriptions?.()
      if (!subscriptions)
        throw new ConfigurationError(
          "Subscription login is unavailable in this host.",
        )
      return subscriptions.login(id)
    },
    async cancelLogin(id) {
      const subscriptions = input.subscriptions?.()
      if (!subscriptions)
        throw new ConfigurationError(
          "Subscription login is unavailable in this host.",
        )
      return subscriptions.cancel(id)
    },
    async importSubscription(id, text) {
      const subscriptions = input.subscriptions?.()
      if (!subscriptions)
        throw new ConfigurationError("Subscription login is unavailable.")
      return subscriptions.importAccount(id, text)
    },
    async write(value) {
      const validated = validateInput(value)
      const configuration = validated.configuration
      const discovered = configuration.models.length
        ? undefined
        : await discoverInput(value)
      const apiKey = validated.apiKey
      const snapshot = await input.userConfig.readSnapshot()
      const previous = snapshot.configuration.modelProviders ?? {}
      const id =
        validated.id ??
        availableProviderId(
          configuration.preset ?? configuration.name,
          Object.keys(previous),
        )
      const newReference =
        apiKey === undefined ? undefined : await credentials.write(apiKey)
      const credentialRef = newReference ?? previous[id]?.credentialRef
      const stored = {
        ...configuration,
        ...(credentialRef === undefined ? {} : { credentialRef }),
      }
      const next = { ...previous, [id]: stored }
      let undoId: string
      try {
        undoId = await history.record(id, previous[id], stored)
        if (discovered) {
          const key = apiKey ?? (await resolveKey(stored))
          if (key) await catalogFor(id, configuration, key).seed(discovered)
        }
        await input.userConfig.writeValue({
          keyPath: ["model_providers"],
          value: Object.fromEntries(
            Object.entries(next).map(([id, provider]) => [
              id,
              providerConfigValue(provider),
            ]),
          ),
          expectedVersion:
            snapshot.layers.find((layer) => layer.source === "user")?.version ??
            "",
        })
      } catch (error) {
        if (newReference !== undefined) await credentials.delete(newReference)
        throw error
      }
      await reload()
      connections.delete(id)
      return { ...(await read()), undoId }
    },
    async delete(value) {
      const id = requireProviderId(value)
      const snapshot = await input.userConfig.readSnapshot()
      const previous = snapshot.configuration.modelProviders ?? {}
      const removed = previous[id]
      if (removed === undefined)
        throw new ConfigurationError("Provider connection does not exist.")
      const next = Object.fromEntries(
        Object.entries(previous)
          .filter(([name]) => name !== id)
          .map(([name, provider]) => [name, providerConfigValue(provider)]),
      )
      const undoId = await history.record(id, removed, undefined)
      await input.userConfig.writeValue({
        keyPath: ["model_providers"],
        value: next,
        expectedVersion:
          snapshot.layers.find((layer) => layer.source === "user")?.version ??
          "",
      })
      await reload()
      connections.delete(id)
      return { ...(await read()), undoId }
    },
    async test(value) {
      const validated = validateInput(value)
      const id = validated.id ?? "preview"
      const apiKey = validated.apiKey
      const configuration = validated.configuration.models.length
        ? validated.configuration
        : { ...validated.configuration, models: await discoverInput(value) }
      const previous = (await input.userConfig.readConfiguration())
        .modelProviders?.[id]
      const key =
        apiKey ??
        (await resolveKey({
          ...configuration,
          ...(previous?.credentialRef === undefined
            ? {}
            : { credentialRef: previous.credentialRef }),
        }))
      if (key === undefined)
        throw new ConfigurationError(
          "Enter an API key or configure the environment variable.",
        )
      const recordResult = (state: "ready" | "error", message?: string) => {
        if (
          !validated.id ||
          activeIdentities.get(id) !==
            `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`
        )
          return
        connections.set(id, {
          identity: `${createProviderContinuationScope(id, configuration.baseURL, key)}:${configuration.wireApi}`,
          status: {
            state,
            checkedAt: (input.now ?? Date.now)(),
            ...(message ? { message } : {}),
          },
        })
        input.changed?.()
      }
      const provider = createConfiguredProvider(id, configuration, key)
      const client = provider.createClient()
      const turn = client.startTurn({ maxAttempts: 1, rateLimitMaxAttempts: 1 })
      try {
        for await (const event of turn.stream({
          target: {
            provider: id,
            model: configuration.models.at(0)?.id ?? "",
            instructionProfileId: "default",
          },
          system: [],
          messages: [
            { role: "user", content: [{ type: "text", text: "Reply OK." }] },
          ],
          tools: [],
          toolWireProtocol: "eager",
          maxOutputTokens: 16,
          signal: AbortSignal.timeout(30_000),
        })) {
          if (event.type === "failure") {
            recordResult("error", event.failure.kind)
            throw new ConfigurationError(
              `Connection test failed: ${event.failure.kind}${event.failure.status === undefined ? "" : ` (HTTP ${event.failure.status})`}.`,
            )
          }
          if (event.type === "response") {
            recordResult("ready")
            return { ok: true }
          }
          if (event.type === "cancelled")
            throw new ConfigurationError("Connection test timed out.")
        }
        throw new ConfigurationError(
          "The endpoint did not complete a model response.",
        )
      } finally {
        await turn.close()
        await client.close()
      }
    },
  }
}

function availableProviderId(name: string, ids: readonly string[]) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom"
  let base = /^[a-z]/.test(slug) ? slug : `provider-${slug}`
  if (["faux", "codex", "kimi", "constructor", "prototype"].includes(base))
    base = `provider-${base}`
  let id = base
  let suffix = 2
  while (ids.includes(id)) id = `${base}-${suffix++}`
  return id
}

function exposedModels(
  configuration: ProviderConfiguration,
  catalog: readonly ConfiguredModel[],
): readonly ConfiguredModel[] {
  const all =
    configuration.modelSelection === "all" ||
    (configuration.modelSelection !== "selected" &&
      !configuration.models.length)
  const entries = all ? catalog : configuration.models
  return entries.map((model) => ({
    ...catalog.find((entry) => entry.id === model.id),
    ...model,
    ...configuration.models.find((entry) => entry.id === model.id),
  }))
}
