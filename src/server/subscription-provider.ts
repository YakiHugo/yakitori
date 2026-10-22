import type { ProviderConfiguration } from "../protocol/providers.ts"
import {
  readCodexLogin,
  resolveCodexAccessToken,
  resolveCodexAccountIdentity,
} from "../runtime/codex-credentials.ts"
import { createCodexProvider } from "../runtime/codex-provider.ts"
import { resolveGrokModelCredentials } from "../runtime/grok-credentials.ts"
import { createGrokProvider } from "../runtime/grok-provider.ts"
import {
  CODEX_CATALOG_CLIENT_VERSION,
  discoverCodexModels,
} from "../runtime/model-discovery.ts"
import {
  createModelProvider,
  type ModelProvider,
} from "../runtime/model-provider.ts"
import { createFileModelsCacheStore } from "../runtime/models-cache-store.ts"
import { createDiscoveringModelsManager } from "../runtime/models-manager.ts"
import { ConfigurationError } from "./config-errors.ts"

// External credentials are a bound source, never a fallback to an environment
// key. Reconnecting is required when that source starts naming another account.
export async function createSubscriptionProvider(
  id: string,
  configuration: ProviderConfiguration,
  cacheDirectory: string,
): Promise<ModelProvider | undefined> {
  const path = configuration.credentialPath
  const owner = configuration.credentialOwner
  if (!path || !owner)
    throw new ConfigurationError(
      "A CLI account needs its credential source and owner.",
    )
  if (configuration.authentication === "grok_cli") {
    try {
      const credentials = await resolveGrokModelCredentials({ path })
      if (credentials.ownerIdentity !== owner) return undefined
    } catch (error) {
      if (
        error instanceof Error &&
        (/^Grok |^The Grok CLI/.test(error.message) ||
          error instanceof SyntaxError)
      )
        return undefined
      throw error
    }
    return createGrokProvider(cacheDirectory, {
      id,
      credentialsPath: path,
      ownerIdentity: owner,
    })
  }
  const login = await readCodexLogin({ path })
  if (
    login?.kind !== "chatgpt" ||
    (await resolveCodexAccountIdentity({ path })) !== owner
  )
    return undefined
  return createModelProvider({
    info: {
      id,
      serviceId: "codex",
      wireApi: "openai_responses",
      capabilities: { remoteCompaction: "codex_remote", nativePdf: false },
    },
    createTurnStream: () =>
      createCodexProvider({
        credentialsPath: path,
        ownerIdentity: owner,
      }),
    models: createDiscoveringModelsManager({
      provider: id,
      catalogProvider: "codex",
      catalogVersion: CODEX_CATALOG_CLIENT_VERSION,
      async identity() {
        const current = await resolveCodexAccountIdentity({ path })
        if (current !== owner)
          throw new ConfigurationError(
            "The Codex account changed. Reconnect it before use.",
          )
        return owner
      },
      async discover() {
        const token = await resolveCodexAccessToken({
          path,
          ownerIdentity: owner,
        })
        if ((await resolveCodexAccountIdentity({ path })) !== owner)
          throw new ConfigurationError(
            "The Codex account changed during model discovery.",
          )
        const models = await discoverCodexModels({
          baseUrl: configuration.baseURL,
          accessToken: token.accessToken,
          ...(token.accountId === undefined
            ? {}
            : { accountId: token.accountId }),
        })
        return models.map((model) => ({ ...model, provider: id }))
      },
      cacheStore: createFileModelsCacheStore({
        provider: id,
        directory: cacheDirectory,
      }),
    }),
  })
}
