import { createModelSettingsManager } from "../runtime/model-settings-manager.ts"
import type {
  ModelCatalogResponse,
  ModelSettingsConfiguration,
  ProviderConfigurationResponse,
  ProviderModelSettings,
  ProviderWriteInput,
} from "../protocol/providers.ts"
import type { ProviderRegistry } from "../runtime/provider-registry.ts"
import {
  requireModelSettingsProvider,
  requireProviderModelSettings,
} from "./model-settings.ts"

export type {
  ProviderConfigurationResponse,
  ProviderWriteInput,
} from "../protocol/providers.ts"

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { ModelNotConfiguredError } from "../runtime/configured-models-manager.ts"
import {
  createProviderContinuationScope,
  type ModelProvider,
  providerPresets,
} from "../runtime/index.ts"
import { NonChatModelError } from "../runtime/model-kind.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { ConfigurationError } from "./config-errors.ts"
import { createConfiguredProvider } from "./configured-provider.ts"
import {
  type ApiConfiguredProvider,
  type ProviderConfiguration,
  providerConfigValue,
  requireProviderConfiguration,
  requireProviderId,
  type StoredProviderConfiguration,
} from "./provider-configuration.ts"
import { createProviderConfigurationHistory } from "./provider-configuration-history.ts"
import { createProviderCredentialStore } from "./provider-credentials.ts"
import { createProviderModelCatalog } from "./provider-model-catalog.ts"
import { discoverProviderModels } from "./provider-model-discovery.ts"
import type {
  SubscriptionConnection,
  SubscriptionConnections,
} from "./subscription-connections.ts"
import { createSubscriptionProvider } from "./subscription-provider.ts"
import type { UserConfigStore } from "./user-config.ts"

export type ProviderService = {
  resolveCredential(id: string): Promise<string | undefined>
  readModels(provider: string): Promise<ModelCatalogResponse>
  writeModels(
    provider: string,
    settings: ProviderModelSettings,
    version: string,
  ): Promise<ModelCatalogResponse>
  refreshCatalog(provider: string): Promise<ModelCatalogResponse>
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
  login(
    id: string,
    reauthenticate?: boolean,
  ): Promise<readonly SubscriptionConnection[]>
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
    registry?: () => ProviderRegistry | undefined
    modelSettingsChanged?(settings: ModelSettingsConfiguration): void
    now?: () => number
    catalogTtlMs?: number
    changed?(): void
    subscriptions?: () => SubscriptionConnections | undefined
    apply(
      providers: Readonly<Record<string, ModelProvider>>,
      configurations: Readonly<Record<string, StoredProviderConfiguration>>,
    ): void | Promise<void>
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
    // Discovery semantics also depend on preset filtering/metadata and whether
    // the no-key placeholder is omitted from request headers.
    const identity = JSON.stringify([
      createProviderContinuationScope(id, configuration.baseURL, key),
      configuration.wireApi,
      configuration.service ?? "generic",
      configuration.authentication === "none",
      "model-kinds-v1",
    ])
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
    const source = configuration.authentication ?? "stored"
    if (source === "none") return "local-no-key"
    if (source === "codex_cli" || source === "grok_cli") return undefined
    if (source === "environment")
      return configuration.envKey === undefined
        ? undefined
        : process.env[configuration.envKey]?.trim() || undefined
    const stored =
      configuration.credentialRef === undefined
        ? undefined
        : await credentials.read(configuration.credentialRef)
    return stored
  }
  const readConfigurations = async () => {
    return (await input.userConfig.readConfiguration()).modelProviders ?? {}
  }
  const reload = async () => {
    const generation = ++reloadGeneration
    await input.subscriptions?.()?.refresh()
    const configurations = await readConfigurations()
    const entries = await Promise.all(
      Object.entries(configurations).map(async ([id, configuration]) => {
        if (configuration.enabled === false) return []
        if (
          configuration.authentication === "codex_cli" ||
          configuration.authentication === "grok_cli"
        ) {
          const provider = await createSubscriptionProvider(
            id,
            configuration,
            join(input.credentialDirectory, "..", "models-cache"),
          )
          if (!provider) return []
          const models = createModelSettingsManager(provider.models, () =>
            Object.fromEntries(
              configuration.models.map(
                ({
                  id,
                  identity: _identity,
                  kind: _kind,
                  defaultVisible: _defaultVisible,
                  ...settings
                }) => [id, settings],
              ),
            ),
          )
          const configured: ModelProvider = {
            ...provider,
            models,
            startTurn(policy) {
              return { ...provider.startTurn(policy), models }
            },
          }
          return [[id, configured] as const]
        }
        const key = await resolveKey(configuration)
        if (key === undefined) return []
        const catalog = catalogFor(id, configuration, key)
        let discovered: readonly ConfiguredModel[]
        try {
          discovered = await catalog.models()
        } catch (error) {
          if (!(error instanceof ConfigurationError)) throw error
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
              status: () => {
                const { fetchedAt, error } = catalog.snapshot()
                return {
                  ...(fetchedAt === undefined ? {} : { fetchedAt }),
                  ...(error === undefined ? {} : { error }),
                }
              },
              async loadModels(force) {
                if (force) await catalog.refresh()
                else await catalog.revalidate()
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
    await input.apply(providers, configurations)
    return providers
  }
  const read = async (): Promise<ProviderConfigurationResponse> => {
    const configurations = await readConfigurations()
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
              configuration.authentication === "codex_cli" ||
              configuration.authentication === "grok_cli"
                ? Object.hasOwn(activeProviders, id)
                  ? "external"
                  : "missing"
                : configuration.authentication === "none"
                  ? "optional"
                  : configuration.authentication === "environment"
                    ? key === undefined
                      ? "missing"
                      : "environment"
                    : storedKey !== undefined
                      ? "stored"
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
      configuration.preset !== "codex" &&
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
    if (value.apiKey !== undefined && configuration.authentication !== "stored")
      throw new ConfigurationError(
        "Choose saved API key authentication before entering a key.",
      )
    return { id, configuration, apiKey: value.apiKey }
  }
  const discoverInput = async (value: ProviderWriteInput) => {
    const { id, configuration, apiKey } = validateInput(value)
    const previous =
      id === undefined
        ? undefined
        : (await input.userConfig.readConfiguration()).modelProviders?.[id]
    if (
      configuration.authentication === "codex_cli" ||
      configuration.authentication === "grok_cli"
    ) {
      if (
        !id ||
        !previous ||
        previous.authentication !== configuration.authentication ||
        previous.credentialPath !== configuration.credentialPath ||
        previous.credentialOwner !== configuration.credentialOwner
      )
        throw new ConfigurationError(
          "Connect this CLI account before loading its models.",
        )
      await modelManager(id).refresh({ force: true })
      return (await readModels(id)).models
    }
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
    return discoverProviderModels(configuration, key)
  }
  const modelManager = (provider: string) => {
    requireModelSettingsProvider(provider)
    const registry = input.registry?.()
    if (!registry?.providers.includes(provider))
      throw new ConfigurationError("Provider is not connected.")
    return registry.models(provider, { defaults: true })
  }
  const readModels = async (
    provider: string,
  ): Promise<ModelCatalogResponse> => {
    const manager = modelManager(provider)
    const [snapshot, listed] = await Promise.all([
      input.userConfig.readSnapshot(),
      manager.listModels({ includeHidden: true }),
    ])
    const models = listed.map((model) => {
      const capacity = manager.capacity({ provider, model: model.model })
      return {
        id: model.model,
        ...(model.displayName === undefined
          ? {}
          : { displayName: model.displayName }),
        ...(capacity === undefined
          ? {}
          : {
              contextWindowTokens: capacity.contextWindowTokens,
              maxContextWindowTokens: capacity.maxContextWindowTokens,
              contextWindowScope: capacity.contextWindowScope,
            }),
        ...(model.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: model.maxOutputTokens }),
        inputModalities: model.inputModalities,
        imageDetailModes: model.imageDetailModes,
        ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
        ...(model.defaultEffort === undefined
          ? {}
          : { defaultEffort: model.defaultEffort }),
        ...(model.speeds === undefined ? {} : { speeds: model.speeds }),
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
        visible: model.visible ?? true,
      }
    })
    return {
      provider,
      models,
      settings: Object.fromEntries(
        Object.entries(snapshot.configuration.models?.[provider] ?? {}).filter(
          ([id]) => {
            try {
              manager.resolve({ provider, model: id })
              return true
            } catch (error) {
              if (error instanceof NonChatModelError) return false
              if (error instanceof ModelNotConfiguredError) return true
              throw error
            }
          },
        ),
      ),
      version:
        snapshot.layers.find((layer) => layer.source === "user")?.version ?? "",
      ...manager.status?.(),
    }
  }
  return {
    async resolveCredential(id) {
      const configuration = (await readConfigurations())[requireProviderId(id)]
      return configuration === undefined ? undefined : resolveKey(configuration)
    },
    read,
    readModels,
    async writeModels(provider, value, version) {
      const manager = modelManager(provider)
      const settings = requireProviderModelSettings(value)
      const models = await manager.listModels({ includeHidden: true })
      for (const [id, override] of Object.entries(settings)) {
        try {
          manager.resolve({ provider, model: id })
        } catch (error) {
          if (error instanceof NonChatModelError)
            throw new ConfigurationError(error.message)
          if (!(error instanceof ModelNotConfiguredError)) throw error
        }
        const base = models.find(
          (model) => model.model.toLowerCase() === id.toLowerCase(),
        )
        const efforts = override.efforts ?? base?.efforts
        if (
          override.defaultEffort !== undefined &&
          efforts !== undefined &&
          !efforts.includes(override.defaultEffort)
        )
          throw new ConfigurationError(
            `Default effort ${override.defaultEffort} is not supported by ${provider}/${id}.`,
          )
      }
      const snapshot = await input.userConfig.writeValue({
        keyPath: ["models", provider],
        value: settings,
        expectedVersion: version,
      })
      input.modelSettingsChanged?.(snapshot.configuration.models ?? {})
      input.changed?.()
      return readModels(provider)
    },
    async refreshCatalog(provider) {
      await modelManager(provider).refresh({ force: true })
      input.changed?.()
      return readModels(provider)
    },
    reload,
    discover: discoverInput,
    async move(id, beforeId) {
      if (beforeId !== undefined) requireProviderId(beforeId)
      const snapshot = await input.userConfig.readSnapshot()
      const entries = Object.entries(await readConfigurations())
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
      const configuration = (await readConfigurations())[requireProviderId(id)]
      if (!configuration)
        throw new ConfigurationError("Provider connection does not exist.")
      if (
        configuration.authentication === "codex_cli" ||
        configuration.authentication === "grok_cli"
      ) {
        await modelManager(id).refresh({ force: true })
        return read()
      }
      const key = await resolveKey(configuration)
      if (!key)
        throw new ConfigurationError("This connection needs an API key.")
      await catalogFor(id, configuration, key).refresh()
      await reload()
      return read()
    },
    async login(id, reauthenticate) {
      const subscriptions = input.subscriptions?.()
      if (!subscriptions)
        throw new ConfigurationError(
          "Subscription login is unavailable in this host.",
        )
      return subscriptions.login(id, reauthenticate)
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
      let snapshot = await input.userConfig.readSnapshot()
      const before =
        validated.id === undefined
          ? undefined
          : snapshot.configuration.modelProviders?.[validated.id]
      const sameSource =
        before !== undefined &&
        validated.apiKey === undefined &&
        (
          [
            "service",
            "wireApi",
            "baseURL",
            "authentication",
            "envKey",
            "credentialPath",
            "credentialOwner",
          ] as const
        ).every((key) => before[key] === configuration[key])
      const discovered =
        sameSource ||
        configuration.models.length ||
        configuration.enabled === false ||
        configuration.authentication === "codex_cli" ||
        configuration.authentication === "grok_cli"
          ? undefined
          : await discoverInput(value)
      const apiKey = validated.apiKey
      if (discovered) snapshot = await input.userConfig.readSnapshot()
      const previous = snapshot.configuration.modelProviders ?? {}
      const id = validated.id ?? `account_${randomUUID()}`
      const newReference =
        apiKey === undefined ? undefined : await credentials.write(apiKey)
      const credentialRef =
        configuration.authentication === "stored"
          ? (newReference ?? previous[id]?.credentialRef)
          : undefined
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
        throw new ConfigurationError("Account does not exist.")
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
      const turn = provider.startTurn({
        maxAttempts: 1,
        rateLimitMaxAttempts: 1,
      })
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
      }
    },
  }
}

function exposedModels(
  configuration: ProviderConfiguration,
  catalog: readonly ConfiguredModel[],
): readonly ConfiguredModel[] {
  const models = new Map(
    catalog.map((model) => [model.id.toLowerCase(), model]),
  )
  for (const model of configuration.models)
    models.set(model.id.toLowerCase(), {
      ...models.get(model.id.toLowerCase()),
      ...model,
    })
  return [...models.values()]
}
