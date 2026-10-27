import {
  type ChatGPTPlanAccess,
  chatGPTPlanIdentity,
  createChatGPTPlanProvider,
  discoverChatGPTPlanModels,
} from "../runtime/chatgpt-plan-provider.ts"
import { createConfiguredModelsManager } from "../runtime/configured-models-manager.ts"
import { ModelFailureError } from "../runtime/errors.ts"
import {
  createModelProvider,
  type ModelProvider,
} from "../runtime/model-provider.ts"
import {
  createModelsManagerCapture,
  type ModelsManager,
} from "../runtime/models-manager.ts"
import { ChatGPTCredentialStoreError } from "./chatgpt-credential-store.ts"

export class ChatGPTModelCatalogError extends Error {
  constructor() {
    super("ChatGPT models are unavailable. Retry or reconnect this account.")
    this.name = "ChatGPTModelCatalogError"
  }
}

type ChatGPTIdentity = Pick<ChatGPTPlanAccess, "clientId" | "subject">

export function createChatGPTModelConnections(input: {
  resolve(identity: ChatGPTIdentity): Promise<ChatGPTPlanAccess>
  fetchFn?: typeof fetch
}): {
  provider(identity: ChatGPTIdentity, providerId: string): ModelProvider
} {
  return {
    provider(identity, providerId) {
      // Registration lifetime belongs to the connection service. Capture values
      // here so neither caller mutation nor account selection can retarget it.
      const account = { clientId: identity.clientId, subject: identity.subject }
      const scope = chatGPTPlanIdentity(account)
      const auth = {
        async resolve() {
          const access = await input.resolve(account)
          if (chatGPTPlanIdentity(access) !== scope) {
            throw new ModelFailureError({
              kind: "authentication",
              stage: "request_build",
              provider: providerId,
              wireApi: "openai_responses",
              providerCode: "chatgpt_account_changed",
              message: "The selected ChatGPT account is no longer connected.",
            })
          }
          access.signal?.throwIfAborted()
          return access
        },
      }
      const options = {
        auth,
        ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
      }
      let current = createConfiguredModelsManager({
        provider: providerId,
        wireApi: "openai_responses",
        models: [],
      })
      const listeners = new Set<() => void>()
      let fetchedAt: number | undefined
      let refreshing: Promise<void> | undefined
      const refresh = async (policy?: Readonly<{ force?: boolean }>) => {
        await auth.resolve()
        if (
          !policy?.force &&
          fetchedAt !== undefined &&
          Date.now() - fetchedAt < 300_000
        )
          return
        refreshing ??= (async () => {
          const access = await auth.resolve()
          const catalog = await discoverChatGPTPlanModels({
            ...options,
            auth: { resolve: async () => access },
          })
          access.signal?.throwIfAborted()
          // Revalidate after an in-flight fetch, including disconnect/reconnect.
          await auth.resolve()
          // SIWC documents model identity/order, not the Codex capability
          // catalog. Keep unknown modalities, efforts and capacity conservative.
          // https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
          const previous = JSON.stringify(await current.listModels())
          current = createConfiguredModelsManager({
            provider: providerId,
            wireApi: "openai_responses",
            models: catalog.models,
          })
          fetchedAt = Date.now()
          if (previous !== JSON.stringify(await current.listModels()))
            for (const listener of listeners) listener()
        })()
          .catch((error: unknown) => {
            fetchedAt = undefined
            throw error
          })
          .finally(() => {
            refreshing = undefined
          })
        return refreshing
      }
      const models: ModelsManager = {
        provider: providerId,
        refresh,
        capture: () => createModelsManagerCapture(models, () => current),
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        status: () => (fetchedAt === undefined ? {} : { fetchedAt }),
        async listModels(options) {
          try {
            await refresh()
            return await current.listModels(options)
          } catch (error) {
            // Expected account/auth/network failures stay local to this catalog.
            // Never replace it with another account or a bundled API-key catalog.
            if (
              error instanceof ChatGPTCredentialStoreError ||
              error instanceof ModelFailureError ||
              error instanceof TypeError ||
              (error instanceof DOMException &&
                ["AbortError", "TimeoutError"].includes(error.name)) ||
              (error instanceof Error &&
                /^ChatGPT (model catalog failed|returned an invalid)/.test(
                  error.message,
                ))
            )
              throw new ChatGPTModelCatalogError()
            throw error
          }
        },
        resolve: (selection) => current.resolve(selection),
        validate: (selection) => current.validate(selection),
        capacity: (selection) => current.capacity(selection),
      }
      return createModelProvider({
        info: {
          id: providerId,
          serviceId: "chatgpt-plan",
          wireApi: "openai_responses",
          capabilities: {
            remoteCompaction: false,
            nativePdf: false,
            tools: { supportsCustomTools: false },
          },
        },
        models,
        continuationScope: scope,
        // The preview has no remote compaction, warmup or native tool_search.
        // Yakitori keeps its own loop and emits ordinary local function tools.
        // https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
        createTurnStream() {
          const stream = createChatGPTPlanProvider(options)
          return async function* (request) {
            try {
              yield* stream(request)
            } catch (error) {
              if (!(error instanceof ModelFailureError)) throw error
              yield { type: "failure", failure: error.failure }
            }
          }
        },
      })
    },
  }
}
