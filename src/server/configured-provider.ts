import {
  createAnthropicProvider,
  createChatCompletionsProvider,
  createConfiguredModelsManager,
  createGeminiProvider,
  createModelProvider,
  createOpenAIProvider,
  createOpenAITurnTransport,
  createProviderContinuationScope,
  providerPresets,
  type ModelProvider,
  type StreamFn,
} from "../runtime/index.ts"
import type { ModelsManager } from "../runtime/models-manager.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import type { ProviderConfiguration } from "./provider-configuration.ts"

export function createConfiguredProvider(
  id: string,
  configuration: ProviderConfiguration,
  apiKey: string,
  dynamic?: Readonly<{
    loadModels(): Promise<readonly ConfiguredModel[]>
    result(state: "ready" | "error", message?: string): void
  }>,
): ModelProvider {
  const preset = providerPresets.find(
    (entry) => entry.id === configuration.preset,
  )
  const catalogProvider = preset?.catalogProvider
  // Presets are editable. Native PDF support requires the documented endpoint;
  // URL syntax normalization and one trailing slash do not change that endpoint.
  const knownPresetEndpoint =
    preset !== undefined &&
    new URL(configuration.baseURL).href.replace(/\/$/, "") ===
      new URL(preset.baseURL).href.replace(/\/$/, "")
  const buildModels = (configured: readonly ConfiguredModel[]) =>
    createConfiguredModelsManager({
      provider: id,
      ...(catalogProvider === undefined ? {} : { catalogProvider }),
      models: configured,
      wireApi: configuration.wireApi,
    })
  let currentModels = buildModels(configuration.models)
  const models: ModelsManager = dynamic
    ? {
        provider: id,
        async refresh() {
          currentModels = buildModels(await dynamic.loadModels())
        },
        listModels: () => currentModels.listModels(),
        resolve: (selection) => currentModels.resolve(selection),
        validate: (selection) => currentModels.validate(selection),
        capacity: (selection) => currentModels.capacity(selection),
      }
    : currentModels
  return createModelProvider({
    info: {
      id,
      wireApi: configuration.wireApi,
      capabilities: {
        remoteCompaction: false,
        nativePdf:
          knownPresetEndpoint &&
          ((catalogProvider === "openai" &&
            (configuration.wireApi === "openai_responses" ||
              configuration.wireApi === "openai_chat_completions")) ||
            (catalogProvider === "anthropic" &&
              configuration.wireApi === "anthropic_messages") ||
            (preset.id === "gemini" &&
              configuration.wireApi === "gemini_generate_content")),
      },
    },
    models,
    continuationScope: createProviderContinuationScope(
      id,
      configuration.baseURL,
      apiKey,
    ),
    createTurnTransport() {
      const options = {
        apiKey,
        model: configuration.models.at(0)?.id ?? "",
        baseURL: configuration.baseURL,
      }
      const transport =
        configuration.requestWarmup === true &&
        configuration.wireApi === "openai_responses"
          ? createOpenAITurnTransport(options)
          : undefined
      const stream =
        transport?.stream ??
        (configuration.wireApi === "openai_responses"
          ? createOpenAIProvider(options)
          : configuration.wireApi === "anthropic_messages"
            ? createAnthropicProvider(options)
            : configuration.wireApi === "gemini_generate_content"
              ? createGeminiProvider(options)
              : createChatCompletionsProvider({
                  ...options,
                  ...(preset?.flavor === undefined
                    ? {}
                    : { flavor: preset.flavor }),
                }))
      const configureStream = (stream: StreamFn): StreamFn =>
        async function* (request) {
          const model = (await models.listModels()).find(
            (entry) => entry.model === request.target.model,
          )
          const effort = request.target.effort ?? model?.defaultEffort
          // Old adapters use the model's canonical catalog identity for native
          // features. Routing remains connection-scoped; opaque history is fenced
          // by the endpoint+credential scope before it reaches the adapter.
          const target = {
            ...request.target,
            ...(catalogProvider === undefined ||
            configuration.wireApi === "openai_chat_completions" ||
            configuration.wireApi === "gemini_generate_content"
              ? {}
              : { provider: catalogProvider }),
            ...(effort === undefined ? {} : { effort }),
          }
          for await (const event of stream({ ...request, target })) {
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
          transport?.close()
        },
      }
    },
  })
}
