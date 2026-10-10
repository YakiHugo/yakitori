import { Agent as UndiciAgent } from "undici"
import {
  GROK_API_BASE_URL,
  resolveGrokAccessToken,
  resolveGrokAccountIdentity,
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

export function createGrokProvider(modelsCacheDir: string): ModelProvider {
  // XAI_API_KEY wins; otherwise reuse the Grok CLI's OIDC login. OAuth
  // tokens expire, so resolve per model call rather than freezing one token at
  // application startup. The same lazy stream supports primary and switched
  // Grok Turns.
  return createModelProvider({
    info: {
      id: "grok",
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
            const envKey = process.env.XAI_API_KEY
            if (envKey !== undefined) {
              apiKey = envKey
              ownerIdentity = `api_key:${envKey}`
            } else {
              const credentials = await resolveGrokModelCredentials()
              apiKey = credentials.accessToken
              ownerIdentity = credentials.ownerIdentity
            }
          } catch (cause) {
            yield {
              type: "failure",
              failure: {
                kind: "authentication",
                stage: "request_build",
                provider: "grok",
                wireApi: "openai_responses",
                providerCode: "grok_login_unavailable",
                message:
                  "Grok login is unavailable. Run `grok` and log in again, or set XAI_API_KEY, then retry.",
              },
              cause,
            }
            return
          }
          const scope = createProviderContinuationScope(
            "grok",
            GROK_API_BASE_URL,
            ownerIdentity,
          )
          if (expectedOwner !== undefined && expectedOwner !== scope) {
            yield {
              type: "failure",
              failure: {
                kind: "authentication",
                stage: "request_build",
                provider: "grok",
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
      provider: "grok",
      identity: () => resolveGrokAccountIdentity(),
      async discover() {
        const accessToken =
          process.env.XAI_API_KEY ?? (await resolveGrokAccessToken())
        return discoverOpenAiCompatibleModels({
          provider: "grok",
          baseUrl: GROK_API_BASE_URL,
          accessToken,
        })
      },
      cacheStore: createFileModelsCacheStore({
        provider: "grok",
        directory: modelsCacheDir,
      }),
    }),
  })
}
