import { Agent as UndiciAgent } from "undici"
import {
  GROK_API_BASE_URL,
  resolveGrokModelCredentials,
} from "./grok-credentials.ts"
import { discoverOpenAiCompatibleModels } from "./model-discovery.ts"
import {
  createModelProvider,
  createProviderContinuationScope,
  type ModelProvider,
} from "./model-provider.ts"
import { createFileModelsCacheStore } from "./models-cache-store.ts"
import { createDiscoveringModelsManager } from "./models-manager.ts"
import { createOpenAIProvider } from "./openai-provider.ts"

export function createGrokProvider(
  modelsCacheDir: string,
  account: {
    id: string
    credentialsPath: string
    ownerIdentity: string
  },
): ModelProvider {
  const provider = account.id
  // Resolve the bound CLI source per call so token renewal stays visible, while
  // its authenticated owner must remain the account selected for this Turn.
  return createModelProvider({
    info: {
      id: provider,
      serviceId: "xai",
      wireApi: "openai_responses",
      capabilities: { remoteCompaction: false, nativePdf: false },
    },
    createTurnStream: () => {
      let expectedOwner: string | undefined
      return async function* (request) {
        const attempt = request.attempt ?? { number: 1, maxAttempts: 1 }
        const forceHttp1 =
          attempt.number > 1 &&
          attempt.previousFailure !== undefined &&
          attempt.previousFailure.kind !== "rate_limited"
        const dispatcher = forceHttp1
          ? new UndiciAgent({ allowH2: false })
          : undefined
        try {
          let apiKey: string
          let ownerIdentity: string
          try {
            const credentials = await resolveGrokModelCredentials({
              path: account.credentialsPath,
            })
            apiKey = credentials.accessToken
            ownerIdentity = credentials.ownerIdentity
          } catch (cause) {
            yield {
              type: "failure",
              failure: {
                kind: "authentication",
                stage: "request_build",
                provider,
                wireApi: "openai_responses",
                providerCode: "grok_login_unavailable",
                message:
                  "The selected Grok account is unavailable. Reconnect this account, then retry.",
              },
              cause,
            }
            return
          }
          const scope = createProviderContinuationScope(
            provider,
            GROK_API_BASE_URL,
            ownerIdentity,
          )
          if (
            ownerIdentity !== account.ownerIdentity ||
            (expectedOwner !== undefined && expectedOwner !== scope)
          ) {
            yield {
              type: "failure",
              failure: {
                kind: "authentication",
                stage: "request_build",
                provider,
                wireApi: "openai_responses",
                providerCode: "grok_account_changed",
                message:
                  "Grok login changed accounts during the Turn; no request was sent to the new account.",
              },
            }
            return
          }
          expectedOwner = scope
          yield* createOpenAIProvider({
            responseProfile: "grok",
            apiKey,
            model: request.target.model,
            baseURL: GROK_API_BASE_URL,
            ...(dispatcher === undefined
              ? {}
              : { fetchOptions: { dispatcher } }),
          })({
            ...request,
            continuationScope: scope,
          })
        } finally {
          await dispatcher?.close()
        }
      }
    },
    models: createDiscoveringModelsManager({
      provider,
      catalogProvider: "grok",
      catalogVersion: "model-kinds-v1",
      identity: async () => {
        const credentials = await resolveGrokModelCredentials({
          path: account.credentialsPath,
        })
        if (credentials.ownerIdentity !== account.ownerIdentity)
          throw new Error(
            "The configured Grok account changed. Reconnect it before use.",
          )
        return account.ownerIdentity
      },
      async discover() {
        const credentials = await resolveGrokModelCredentials({
          path: account.credentialsPath,
        })
        if (credentials.ownerIdentity !== account.ownerIdentity)
          throw new Error(
            "The configured Grok account changed during model discovery.",
          )
        const accessToken = credentials.accessToken
        const models = await discoverOpenAiCompatibleModels({
          provider: "grok",
          baseUrl: GROK_API_BASE_URL,
          accessToken,
        })
        return models.map((model) => ({ ...model, provider }))
      },
      cacheStore: createFileModelsCacheStore({
        provider,
        directory: modelsCacheDir,
      }),
    }),
  })
}
