import {
  createAnthropicTurnTransport,
  createChatCompletionsProvider,
  createConfiguredModelsManager,
  createGeminiInteractionsProvider,
  createGeminiProvider,
  createModelProvider,
  createOpenAITurnTransport,
  createProviderContinuationScope,
  type ModelProvider,
  type StreamFn,
} from "../runtime/index.ts"
import type { ModelClientSession } from "../runtime/model-provider.ts"
import type { ModelsManager } from "../runtime/models-manager.ts"
import { resolveProviderBackend } from "../runtime/provider-backend.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import type { ProviderConfiguration } from "./provider-configuration.ts"

export function createConfiguredProvider(
  id: string,
  configuration: ProviderConfiguration,
  apiKey: string,
  dynamic?: Readonly<{
    loadModels(force?: boolean): Promise<readonly ConfiguredModel[]>
    status?(): Readonly<{ fetchedAt?: number; error?: string }>
    result(state: "ready" | "error", message?: string): void
  }>,
): ModelProvider {
  const backend = resolveProviderBackend(configuration)
  const { service, catalogProvider } = backend
  const buildModels = (configured: readonly ConfiguredModel[]) =>
    createConfiguredModelsManager({
      provider: id,
      ...(catalogProvider === undefined ? {} : { catalogProvider }),
      models: configured.map((model) => ({
        ...service?.models.find((known) => known.id === model.id),
        ...model,
      })),
      wireApi: configuration.wireApi,
    })
  const listeners = new Set<() => void>()
  let currentModels = buildModels(configuration.models)
  const models: ModelsManager = dynamic
    ? {
        provider: id,
        // The factory already published its initial catalog. A Turn captures
        // it without making optional discovery a prerequisite for inference.
        capture: () => currentModels,
        async refresh(options) {
          const before = JSON.stringify(await currentModels.listModels())
          currentModels = buildModels(await dynamic.loadModels(options?.force))
          if (before !== JSON.stringify(await currentModels.listModels()))
            for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        ...(dynamic.status ? { status: dynamic.status } : {}),
        listModels: (options) => currentModels.listModels(options),
        resolve: (selection) => currentModels.resolve(selection),
        validate: (selection) => currentModels.validate(selection),
        capacity: (selection) => currentModels.capacity(selection),
      }
    : currentModels
  return createModelProvider({
    info: {
      id,
      ...(backend.serviceId === undefined
        ? {}
        : { serviceId: backend.serviceId }),
      wireApi: configuration.wireApi,
      capabilities: backend.capabilities,
    },
    models,
    continuationScope: createProviderContinuationScope(
      id,
      configuration.baseURL,
      apiKey,
    ),
    createTurnTransport() {
      const options = {
        apiKey:
          configuration.authentication === "none" &&
          (configuration.wireApi === "gemini_generate_content" ||
            configuration.wireApi === "gemini_interactions")
            ? ""
            : apiKey,
        ...(configuration.authentication === "none"
          ? {
              defaultHeaders:
                configuration.wireApi === "anthropic_messages"
                  ? { "x-api-key": null }
                  : { Authorization: null },
            }
          : {}),
        model: configuration.models.at(0)?.id ?? "",
        baseURL: configuration.baseURL,
      }
      const transport:
        | Pick<ModelClientSession, "stream" | "warmup" | "close">
        | undefined =
        configuration.wireApi === "openai_responses"
          ? createOpenAITurnTransport({
              ...options,
              warmup: configuration.requestWarmup === true,
              responseProfile: backend.responseProfile,
            })
          : configuration.wireApi === "anthropic_messages"
            ? createAnthropicTurnTransport({
                ...options,
                profile: backend.anthropicProfile,
              })
            : undefined
      const stream =
        transport?.stream ??
        (configuration.wireApi === "gemini_generate_content"
          ? createGeminiProvider(options)
          : configuration.wireApi === "gemini_interactions"
            ? createGeminiInteractionsProvider(options)
            : createChatCompletionsProvider({
                ...options,
                flavor: backend.chatCompletionsFlavor,
              }))
      const configureStream = (stream: StreamFn): StreamFn =>
        async function* (request) {
          if (
            request.providerOptions !== undefined &&
            request.providerOptions.provider !== request.target.provider
          ) {
            yield {
              type: "failure",
              failure: {
                provider: id,
                wireApi: configuration.wireApi,
                stage: "request_build",
                kind: "invalid_request",
                message:
                  "Provider request controls belong to another connection.",
              },
            }
            return
          }
          for await (const event of stream(request)) {
            if (event.type === "response") dynamic?.result("ready")
            else if (event.type === "failure")
              dynamic?.result(
                "error",
                `${event.failure.kind}${event.failure.status === undefined ? "" : ` (HTTP ${event.failure.status})`}`,
              )
            yield event.type === "failure"
              ? { ...event, failure: { ...event.failure, provider: id } }
              : event
          }
        }
      return {
        stream: configureStream(stream),
        ...(transport?.warmup === undefined
          ? {}
          : { warmup: configureStream(transport.warmup) }),
        close() {
          return transport?.close()
        },
      }
    },
  })
}
