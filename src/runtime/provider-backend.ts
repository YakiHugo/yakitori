import type {
  ProviderConfiguration,
  ProviderPreset,
} from "../protocol/providers.ts"
import type { AnthropicProviderOptions } from "./anthropic-provider.ts"
import type { ChatCompletionsProviderOptions } from "./chat-completions-provider.ts"
import type { ModelProviderCapabilities } from "./model-provider.ts"
import type { OpenAIProviderOptions } from "./openai-provider.ts"
import { providerServiceForEndpoint } from "./provider-services.ts"

export type ProviderBackend = Readonly<{
  id: string
  service?: ProviderPreset
  serviceId?: string
  catalogProvider?: string
  capabilities: ModelProviderCapabilities
  responseProfile: NonNullable<OpenAIProviderOptions["responseProfile"]>
  anthropicProfile: NonNullable<AnthropicProviderOptions["profile"]>
  chatCompletionsFlavor: NonNullable<ChatCompletionsProviderOptions["flavor"]>
}>

// Authentication chooses a credential source; it does not grant protocol
// features. Both API keys and CLI credentials resolve the same backend here.
export function resolveProviderBackend(
  configuration: Pick<ProviderConfiguration, "service" | "baseURL" | "wireApi">,
): ProviderBackend {
  const service = providerServiceForEndpoint(configuration)
  const responses = configuration.wireApi === "openai_responses"
  const messages = configuration.wireApi === "anthropic_messages"
  const codex =
    configuration.service === "codex" &&
    responses &&
    new URL(configuration.baseURL).href.replace(/\/$/, "") ===
      "https://chatgpt.com/backend-api/codex"
  const serviceId = codex ? "codex" : service?.id
  const openai = service?.id === "openai"
  const anthropic = service?.id === "anthropic" && messages
  return {
    id: `${serviceId ?? "generic"}/${configuration.wireApi}`,
    ...(service === undefined ? {} : { service }),
    ...(serviceId === undefined ? {} : { serviceId }),
    ...(codex
      ? { catalogProvider: "codex" }
      : service?.catalogProvider === undefined
        ? {}
        : { catalogProvider: service.catalogProvider }),
    capabilities: {
      remoteCompaction: codex
        ? "codex_remote"
        : openai && responses
          ? "responses_compact"
          : false,
      nativePdf:
        (openai &&
          (responses || configuration.wireApi === "openai_chat_completions")) ||
        anthropic ||
        (service?.id === "gemini" &&
          (configuration.wireApi === "gemini_generate_content" ||
            configuration.wireApi === "gemini_interactions")),
      tools: {
        supportsCustomTools: codex || (openai && responses),
        ...(codex || (openai && responses)
          ? { nativeDeferredProtocol: "openai_deferred" }
          : anthropic
            ? { nativeDeferredProtocol: "anthropic_deferred" }
            : {}),
      },
    },
    responseProfile:
      service?.id === "xai"
        ? "grok"
        : service?.id === "moonshot"
          ? "kimi"
          : "openai",
    anthropicProfile: anthropic
      ? "anthropic"
      : service?.id === "kimi-code" && messages
        ? "kimi-code"
        : "generic",
    chatCompletionsFlavor: service?.flavor ?? "generic",
  }
}
