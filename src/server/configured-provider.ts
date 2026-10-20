import {
  createAnthropicTurnTransport,
  createChatCompletionsProvider,
  createConfiguredModelsManager,
  createGeminiProvider,
  createModelProvider,
  createOpenAITurnTransport,
  createProviderContinuationScope,
  type ModelProvider,
  providerPresets,
  type StreamFn,
} from "../runtime/index.ts"
import type { ModelClientSession } from "../runtime/model-provider.ts"
import type { ModelsManager } from "../runtime/models-manager.ts"
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
      models: configured.map((model) => ({
        ...preset?.models.find((known) => known.id === model.id),
        ...model,
      })),
      wireApi: configuration.wireApi,
    })
  const listeners = new Set<() => void>()
  let currentModels = buildModels(configuration.models)
  const models: ModelsManager = dynamic
    ? {
        provider: id,
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
      wireApi: configuration.wireApi,
      capabilities: {
        remoteCompaction:
          knownPresetEndpoint &&
          catalogProvider === "openai" &&
          configuration.wireApi === "openai_responses"
            ? "responses_compact"
            : false,
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
      const transport:
        | Pick<ModelClientSession, "stream" | "warmup" | "close">
        | undefined =
        configuration.wireApi === "openai_responses"
          ? createOpenAITurnTransport({
              ...options,
              warmup: configuration.requestWarmup === true,
            })
          : configuration.wireApi === "anthropic_messages"
            ? createAnthropicTurnTransport(options)
            : undefined
      const stream =
        transport?.stream ??
        (configuration.wireApi === "gemini_generate_content"
          ? createGeminiProvider(options)
          : createChatCompletionsProvider({
              ...options,
              ...(preset?.flavor === undefined
                ? {}
                : { flavor: preset.flavor }),
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
          const providerOptions =
            request.providerOptions?.provider === request.target.provider
              ? { ...request.providerOptions, provider: target.provider }
              : request.providerOptions
          for await (const event of stream({
            ...request,
            target,
            ...(providerOptions === undefined ? {} : { providerOptions }),
          })) {
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
