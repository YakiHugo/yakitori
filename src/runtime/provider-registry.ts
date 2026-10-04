import type { ModelRequest, StreamFn } from "./model.ts"
import {
  createInjectedModelProvider,
  type ModelClient,
  type ModelProvider,
  type ModelProviderClient,
} from "./model-provider.ts"
import type { ModelsManager } from "./models-manager.ts"

export type ProviderRegistry = {
  readonly providers: readonly string[]
  replace(providers: Readonly<Record<string, ModelProvider | StreamFn>>): void
  readonly createClient: () => ModelClient
  readonly models: (provider: string) => ModelsManager
  // Compatibility port for focused callers. Session execution uses
  // createClient so Turn-scoped transport state has an explicit lifetime.
  readonly stream: StreamFn
}

export function createProviderRegistry(
  providers: Readonly<Record<string, ModelProvider | StreamFn>>,
): ProviderRegistry {
  const resolveEntries = (
    providers: Readonly<Record<string, ModelProvider | StreamFn>>,
  ) =>
    Object.entries(providers).map(([id, provider]) => {
      const resolved =
        typeof provider === "function"
          ? createInjectedModelProvider(id, provider)
          : provider
      if (resolved.info.id !== id) {
        throw new Error(
          `Provider registry key ${id} does not match provider id ${resolved.info.id}.`,
        )
      }
      return [id, resolved] as const
    })
  const entries = resolveEntries(providers)
  const byId = new Map(entries)
  // Keep the list identity stable: admission and RPC callers retain this view.
  const names = entries.map(([provider]) => provider)

  const requireProvider = (provider: string): ModelProvider => {
    const resolved = byId.get(provider)
    if (resolved !== undefined) return resolved
    throw new Error(
      `Provider ${provider} is not registered. Available providers: ${names.join(", ") || "none"}.`,
    )
  }

  return {
    providers: names,
    replace(providers) {
      const next = resolveEntries(providers)
      byId.clear()
      for (const [id, provider] of next) byId.set(id, provider)
      names.splice(0, names.length, ...next.map(([id]) => id))
    },
    models(provider) {
      return requireProvider(provider).models
    },
    createClient() {
      return createRegistryClient(requireProvider, (provider) =>
        byId.has(provider),
      )
    },
    stream(request) {
      return streamSingleRequest(
        requireProvider(request.target.provider),
        request,
      )
    },
  }
}

function createRegistryClient(
  requireProvider: (provider: string) => ModelProvider,
  hasProvider: (provider: string) => boolean,
): ModelClient {
  const clients = new Map<ModelProvider, ModelProviderClient>()
  const turnSessions = new Set<ReturnType<ModelClient["startTurn"]>>()
  let closed = false
  return {
    hasProvider,
    models(provider) {
      return requireProvider(provider).models
    },
    startTurn(provider, policy) {
      if (closed) throw new Error("Model client is closed.")
      // Running Turns retain their provider; a subsequent Turn resolves the
      // replacement configuration even within an already resident Session.
      const resolved = requireProvider(provider)
      let client = clients.get(resolved)
      if (client === undefined) {
        client = resolved.createClient()
        clients.set(resolved, client)
      }
      const session = client.startTurn(policy)
      let closePromise: Promise<void> | undefined
      const ownedSession: ReturnType<ModelClient["startTurn"]> = {
        wireApi: resolved.info.wireApi,
        remoteCompaction: session.remoteCompaction ?? false,
        stream(request) {
          if (request.target.provider !== provider) {
            throw new Error(
              `Turn transport for ${provider} cannot stream target ${request.target.provider}/${request.target.model}.`,
            )
          }
          return session.stream(request)
        },
        close() {
          closePromise ??= Promise.resolve()
            .then(() => session.close())
            .finally(() => turnSessions.delete(ownedSession))
          return closePromise
        },
      }
      turnSessions.add(ownedSession)
      return ownedSession
    },
    async close() {
      if (closed) return
      closed = true
      const sessionResults = await Promise.allSettled(
        [...turnSessions].map((session) => session.close()),
      )
      const clientResults = await Promise.allSettled(
        [...clients.values()].map((client) => client.close()),
      )
      const errors = [...sessionResults, ...clientResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close model clients.")
      }
    },
  }
}

async function* streamSingleRequest(
  provider: ModelProvider,
  request: ModelRequest,
) {
  const client = provider.createClient()
  const session = client.startTurn()
  try {
    yield* session.stream(request)
  } finally {
    await closeRequestOwners(session, client)
  }
}

async function closeRequestOwners(
  session: ReturnType<ModelProviderClient["startTurn"]>,
  client: ModelProviderClient,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await session.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await client.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close model request owners.")
  }
}
