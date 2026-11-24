import type {
  ProviderConfiguration,
  ProviderPreset,
} from "../protocol/providers.ts"
import {
  type AnthropicMessagesProfile,
  anthropicMessagesProfile,
  genericMessagesProfile,
  kimiCodeMessagesProfile,
} from "./anthropic-messages-profiles.ts"
import {
  type ChatCompletionsDialect,
  genericChatDialect,
  selectChatCompletionsDialect,
} from "./chat-completions-dialects.ts"
import type { ModelProviderCapabilities } from "./model-provider.ts"
import {
  codexResponsesProfile,
  grokResponsesProfile,
  kimiResponsesProfile,
  type OpenAIResponsesProfile,
  openAIResponsesProfile,
} from "./openai-responses-profiles.ts"
import { providerServiceForEndpoint } from "./provider-services.ts"

export type ProviderBackend = Readonly<{
  id: string
  service?: ProviderPreset
  serviceId?: string
  catalogProvider?: string
  capabilities: ModelProviderCapabilities
  responseProfile: OpenAIResponsesProfile
  anthropicProfile: AnthropicMessagesProfile
  chatDialect: ChatCompletionsDialect
}>

// Authentication chooses a credential source; it does not grant protocol
// features. Both API keys and CLI credentials resolve the same backend here.
export function resolveProviderBackend(
  configuration: Pick<ProviderConfiguration, "service" | "baseURL" | "wireApi">,
): ProviderBackend {
  const service = providerServiceForEndpoint(configuration)
  const codex =
    configuration.service === "codex" &&
    configuration.wireApi === "openai_responses" &&
    new URL(configuration.baseURL).href.replace(/\/$/, "") ===
      "https://chatgpt.com/backend-api/codex"
  const serviceId = codex ? "codex" : service?.id
  const id = `${serviceId ?? "generic"}/${configuration.wireApi}` as const
  const protocol = providerProtocols[id]
  return {
    id,
    ...(service === undefined ? {} : { service }),
    ...(serviceId === undefined ? {} : { serviceId }),
    ...(codex
      ? { catalogProvider: "codex" }
      : service?.catalogProvider === undefined
        ? {}
        : { catalogProvider: service.catalogProvider }),
    capabilities: {
      nativePdf: false,
      ...protocol?.capabilities,
      tools: {
        supportsCustomTools: false,
        ...protocol?.capabilities?.tools,
      },
    },
    responseProfile: protocol?.responseProfile ?? openAIResponsesProfile,
    anthropicProfile: protocol?.anthropicProfile ?? genericMessagesProfile,
    chatDialect:
      configuration.wireApi === "openai_chat_completions"
        ? selectChatCompletionsDialect(
            service?.flavor ?? "generic",
            configuration.baseURL,
          )
        : genericChatDialect,
  }
}

// These are protocol contracts, not model capabilities or account settings.
// Only an explicit service at a validated endpoint above can select a row;
// matching a vendor name, model name or API shape alone grants no features.
const providerProtocols: Readonly<
  Record<
    `${string}/${ProviderConfiguration["wireApi"]}`,
    Readonly<{
      capabilities?: Partial<ModelProviderCapabilities>
      responseProfile?: ProviderBackend["responseProfile"]
      anthropicProfile?: ProviderBackend["anthropicProfile"]
    }>
  >
> = {
  "codex/openai_responses": {
    responseProfile: codexResponsesProfile,
    capabilities: {
      compactionStrategy: { replacement: "checkpoint_only", maxAttempts: 3 },
      tools: {
        supportsCustomTools: true,
        nativeDeferredProtocol: "openai_deferred",
      },
    },
  },
  "openai/openai_responses": {
    capabilities: {
      compactionStrategy: { replacement: "native_window" },
      nativePdf: true,
      tools: {
        supportsCustomTools: true,
        nativeDeferredProtocol: "openai_deferred",
      },
    },
  },
  "openai/openai_chat_completions": {
    capabilities: { nativePdf: true },
  },
  "anthropic/anthropic_messages": {
    capabilities: {
      nativePdf: true,
      tools: {
        supportsCustomTools: false,
        nativeDeferredProtocol: "anthropic_deferred",
      },
    },
    anthropicProfile: anthropicMessagesProfile,
  },
  "gemini/gemini_generate_content": {
    capabilities: { nativePdf: true },
  },
  "gemini/gemini_interactions": {
    capabilities: { nativePdf: true },
  },
  "xai/openai_responses": { responseProfile: grokResponsesProfile },
  "xai/openai_chat_completions": { responseProfile: grokResponsesProfile },
  "moonshot/openai_responses": { responseProfile: kimiResponsesProfile },
  "kimi-code/anthropic_messages": { anthropicProfile: kimiCodeMessagesProfile },
}
