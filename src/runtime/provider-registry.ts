import type { ProviderModelSettings } from "../protocol/providers.ts"
import { createModelSettingsManager } from "./model-settings-manager.ts"
import type { ModelRequest, StreamFn } from "./model.ts"
import {
  createInjectedModelProvider,
  type ModelClient,
  type ModelClientSession,
  type ModelProvider,
} from "./model-provider.ts"
import {
  ModelStreamCleanupError,
  type ModelRequestPolicy,
} from "./model-request.ts"
import { captureModelsManager, type ModelsManager } from "./models-manager.ts"
import {
  ModelRequestPlanError,
  prepareModelRequestPlan,
} from "./model-request-plan.ts"
import { ModelRequestControlsError } from "./model-request-controls.ts"

type ProviderDefinitions = Readonly<Record<string, ModelProvider | StreamFn>>

export type ProviderRegistration = Readonly<{
  // Publication is synchronous; the Promise joins retirement of replaced entries.
  replace(providers: ProviderDefinitions): Promise<void>
  close(): Promise<void>
}>

export type ProviderRegistry = {
  readonly providers: readonly string[]
  register(owner: string, providers: ProviderDefinitions): ProviderRegistration
  createClient(): ModelClient
  models(
    provider: string,
    options?: Readonly<{ defaults?: boolean }>,
  ): ModelsManager
  readonly stream: StreamFn
  close(): Promise<void>
}

type ProviderEntry = {
  definition: ModelProvider | StreamFn
  provider: ModelProvider
  uses: number
  retired: boolean
  closing: boolean
  errors: unknown[]
  settled: Promise<void>
  finish(): void
  unsubscribe?: (() => void) | undefined
}

export function createProviderRegistry(
  initial: ProviderDefinitions = {},
  options: Readonly<{
    settings?(provider: string): ProviderModelSettings
    changed?(): void
  }> = {},
): ProviderRegistry {
  const byId = new Map<string, ProviderEntry>()
  const sources = new Map<string, ProviderRegistration>()
  const disposed = new WeakSet<ModelProvider>()
  // Admission and RPC callers retain this view.
  const names: string[] = []
  let closePromise: Promise<void> | undefined
  const publishNames = () => names.splice(0, names.length, ...byId.keys())
  const requireOpen = () => {
    if (closePromise !== undefined)
      throw new Error("Provider registry is closed.")
  }
  const requireEntry = (id: string) => {
    requireOpen()
    const entry = byId.get(id)
    if (entry !== undefined) return entry
    throw new Error(
      `Provider ${id} is not registered. Available providers: ${names.join(", ") || "none"}.`,
    )
  }
  const acquire = (entry: ProviderEntry) => {
    if (entry.retired)
      throw new Error(`Provider ${entry.provider.info.id} is retired.`)
    entry.uses++
    return () => {
      entry.uses--
      settle(entry)
    }
  }
  const settle = (entry: ProviderEntry) => {
    if (!entry.retired || entry.uses !== 0 || entry.closing) return
    entry.closing = true
    entry.unsubscribe?.()
    // A failed Turn close leaves resource ownership unresolved. Do not dispose
    // shared provider resources under that Turn; retain the failure for shutdown.
    void Promise.resolve()
      .then(() =>
        entry.errors.length === 0 ? entry.provider.close?.() : undefined,
      )
      .catch((cause: unknown) => {
        entry.errors.push(cause)
      })
      .finally(entry.finish)
  }
  const retire = (entry: ProviderEntry) => {
    entry.retired = true
    if (entry.provider.close !== undefined) disposed.add(entry.provider)
    settle(entry)
  }
  const join = async (entries: readonly ProviderEntry[]) => {
    await Promise.all(entries.map((entry) => entry.settled))
    const errors = entries.flatMap((entry) => entry.errors)
    if (errors.length > 0)
      throw new AggregateError(errors, "Failed to retire model providers.")
  }
  const configuredModels = (
    entry: ProviderEntry,
    capture = false,
    base: ModelsManager = entry.provider.models,
  ) => {
    const provider = entry.provider.info.id
    const captured = capture ? (options.settings?.(provider) ?? {}) : undefined
    return createModelSettingsManager(
      base,
      () => captured ?? options.settings?.(provider) ?? {},
    )
  }
  const models = (entry: ProviderEntry, defaults = false): ModelsManager => {
    const manager = defaults ? entry.provider.models : configuredModels(entry)
    return {
      provider: entry.provider.info.id,
      // Pure metadata reads stay usable for a catalog result already returned to
      // the caller, even if retirement follows that asynchronous read immediately.
      resolve: (selection) => manager.resolve(selection),
      validate: (selection) => manager.validate(selection),
      capacity: (selection) => manager.capacity(selection),
      ...(manager.status ? { status: manager.status } : {}),
      async refresh(options) {
        const release = acquire(entry)
        try {
          await manager.refresh(options)
        } finally {
          release()
        }
      },
      async listModels(options) {
        const release = acquire(entry)
        try {
          return await manager.listModels(options)
        } finally {
          release()
        }
      },
    }
  }
  const startTurn = (
    entry: ProviderEntry,
    policy?: ModelRequestPolicy,
  ): ModelClientSession => {
    requireOpen()
    const release = acquire(entry)
    let session: ModelClientSession
    try {
      session = entry.provider.startTurn(policy)
    } catch (cause) {
      release()
      throw cause
    }
    let closing: Promise<void> | undefined
    const requireActive = () => {
      if (closing !== undefined) throw new Error("Model Turn is closed.")
    }
    const guarded =
      (stream: StreamFn): StreamFn =>
      (request) => {
        requireActive()
        if (request.target.provider !== entry.provider.info.id)
          throw new Error(
            `Turn transport for ${entry.provider.info.id} cannot stream target ${request.target.provider}/${request.target.model}.`,
          )
        if (
          (request.compaction === "codex_remote" ||
            request.compaction === "responses_compact") &&
          request.compaction !==
            (session.remoteCompaction ??
              entry.provider.info.capabilities.remoteCompaction)
        )
          throw new Error(
            `Provider ${entry.provider.info.id} does not support remote compaction.`,
          )
        const events = stream(request)
        return (async function* () {
          requireActive()
          try {
            yield* events
          } catch (cause) {
            // close() may only stop the transport. A stream that timed out
            // during teardown still owns work even if that callback succeeds.
            if (cause instanceof ModelStreamCleanupError)
              entry.errors.push(cause)
            throw cause
          }
        })()
      }
    const warmup = session.warmup
    const turnModels = captureModelsManager(
      configuredModels(entry, true, session.models),
    )
    const toolCapabilities =
      session.toolCapabilities ?? entry.provider.info.capabilities.tools
    const requestWithPolicy = (request: ModelRequest): ModelRequest =>
      prepareModelRequestPlan(request, {
        model: turnModels.resolve(request.target),
        wireApi: session.wireApi ?? entry.provider.info.wireApi,
        ...(toolCapabilities === undefined ? {} : { toolCapabilities }),
      }).request
    const prepareStream = (stream: StreamFn): StreamFn =>
      async function* (request) {
        await turnModels.refresh()
        requireActive()
        if (request.signal?.aborted) {
          yield { type: "cancelled" }
          return
        }
        let prepared: ModelRequest
        try {
          prepared = requestWithPolicy(request)
        } catch (error) {
          if (
            !(
              error instanceof ModelRequestPlanError ||
              error instanceof ModelRequestControlsError
            )
          )
            throw error
          yield {
            type: "failure",
            failure: {
              kind: "invalid_request",
              stage: "request_build",
              provider: request.target.provider,
              wireApi: session.wireApi ?? entry.provider.info.wireApi,
              message: error.message,
              ...(error instanceof ModelRequestPlanError
                ? { providerCode: error.code }
                : {}),
            },
          }
          return
        }
        yield* stream(prepared)
      }

    return {
      models: turnModels,
      ...(session.serviceId === undefined
        ? {}
        : { serviceId: session.serviceId }),
      wireApi: session.wireApi ?? entry.provider.info.wireApi,
      remoteCompaction:
        session.remoteCompaction ??
        entry.provider.info.capabilities.remoteCompaction,
      nativePdf:
        session.nativePdf ??
        entry.provider.info.capabilities.nativePdf === true,
      ...(toolCapabilities === undefined ? {} : { toolCapabilities }),
      stream: guarded(prepareStream(session.stream)),
      ...(warmup === undefined
        ? {}
        : { warmup: guarded(prepareStream(warmup)) }),
      close() {
        closing ??= Promise.resolve()
          .then(() => session.close())
          .catch((cause: unknown) => {
            entry.errors.push(cause)
            throw cause
          })
          .finally(release)
        return closing
      },
    }
  }
  const register: ProviderRegistry["register"] = (owner, providers) => {
    requireOpen()
    if (owner.trim() === "" || sources.has(owner))
      throw new Error(
        `Provider source ${owner} is empty or already registered.`,
      )
    let current = new Map<string, ProviderEntry>()
    const owned = new Set<ProviderEntry>()
    let closing: Promise<void> | undefined
    const replace = (definitions: ProviderDefinitions) => {
      requireOpen()
      if (closing !== undefined)
        throw new Error(`Provider source ${owner} is closed.`)
      // Validate the entire candidate before changing routing or resource ownership.
      const next = new Map(
        Object.entries(definitions).map(([id, definition]) => {
          const existing = current.get(id)
          if (existing?.definition === definition)
            return [id, existing] as const
          if (byId.has(id) && !current.has(id))
            throw new Error(
              `Provider ${id} is already registered by another source.`,
            )
          const provider =
            typeof definition === "function"
              ? createInjectedModelProvider(id, definition)
              : definition
          if (
            id.trim() === "" ||
            provider.info.id !== id ||
            provider.models.provider !== id
          )
            throw new Error(
              `Provider registry key ${id} does not match provider id ${provider.info.id} and models ${provider.models.provider}.`,
            )
          if (disposed.has(provider))
            throw new Error(`Provider ${id} has already been retired.`)
          const { promise: settled, resolve: finish } =
            Promise.withResolvers<void>()
          return [
            id,
            {
              definition,
              provider,
              uses: 0,
              retired: false,
              closing: false,
              errors: [],
              settled,
              finish,
            } satisfies ProviderEntry,
          ] as const
        }),
      )
      const removed = [...current]
        .filter(([id, entry]) => next.get(id) !== entry)
        .map(([, entry]) => entry)
      for (const id of current.keys()) byId.delete(id)
      current = next
      for (const [id, entry] of next) {
        byId.set(id, entry)
        owned.add(entry)
        entry.unsubscribe ??= entry.provider.models.subscribe?.(() => {
          if (byId.get(id) === entry) options.changed?.()
        })
      }
      publishNames()
      for (const entry of removed) retire(entry)
      return join(removed).finally(() => {
        for (const entry of removed)
          if (entry.errors.length === 0) owned.delete(entry)
      })
    }
    const registration: ProviderRegistration = {
      replace,
      close() {
        if (closing !== undefined) return closing
        for (const id of current.keys()) byId.delete(id)
        current.clear()
        publishNames()
        const entries = [...owned]
        for (const entry of entries) retire(entry)
        closing = join(entries).then(() => {
          sources.delete(owner)
        })
        return closing
      },
    }
    // Initial validation can throw without leaving a partially registered source.
    void replace(providers)
    sources.set(owner, registration)
    return registration
  }
  if (Object.keys(initial).length > 0) register("builtin", initial)
  return {
    providers: names,
    register,
    models(id, options) {
      return models(requireEntry(id), options?.defaults)
    },
    createClient() {
      requireOpen()
      return createRegistryClient(
        (id, policy) => startTurn(requireEntry(id), policy),
        (id) => closePromise === undefined && byId.has(id),
        (id) => models(requireEntry(id)),
      )
    },
    stream(request) {
      const entry = requireEntry(request.target.provider)
      return streamSingleRequest(() => startTurn(entry), request)
    },
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled(
          [...sources.values()].map((source) => source.close()),
        )
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length > 0)
          throw new AggregateError(errors, "Failed to close provider registry.")
      })
      return closePromise
    },
  }
}

async function* streamSingleRequest(
  start: () => ModelClientSession,
  request: ModelRequest,
) {
  const session = start()
  try {
    yield* session.stream(request)
  } finally {
    await session.close()
  }
}

function createRegistryClient(
  startTurn: (
    provider: string,
    policy?: ModelRequestPolicy,
  ) => ModelClientSession,
  hasProvider: ModelClient["hasProvider"],
  models: ModelClient["models"],
): ModelClient {
  const turns = new Set<ModelClientSession>()
  let closing: Promise<void> | undefined
  return {
    hasProvider: (provider) => closing === undefined && hasProvider(provider),
    models(provider) {
      if (closing !== undefined) throw new Error("Model client is closed.")
      return models(provider)
    },
    startTurn(provider, policy) {
      if (closing !== undefined) throw new Error("Model client is closed.")
      const session = startTurn(provider, policy)
      // Keep failed closes so a later client close reports the unresolved owner.
      let turnClosing: Promise<void> | undefined
      const owned = {
        ...session,
        close: () =>
          (turnClosing ??= Promise.resolve(session.close()).then(() => {
            turns.delete(owned)
          })),
      }
      turns.add(owned)
      return owned
    },
    close() {
      closing ??= Promise.allSettled(
        [...turns].map((turn) => turn.close()),
      ).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            "Failed to close model Turn sessions.",
          )
      })
      return closing
    },
  }
}
