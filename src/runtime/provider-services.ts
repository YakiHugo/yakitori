import type {
  ProviderConfiguration,
  ProviderPreset,
} from "../protocol/providers.ts"

export type { ConfiguredModel, ProviderPreset } from "../protocol/providers.ts"

// Service definitions own documented endpoints and vendor behavior. Account
// labels and UI templates do not select a runtime protocol profile.
export const providerServices: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    wireApi: "openai_responses",
    envKey: "OPENAI_API_KEY",
    catalogProvider: "openai",
    models: [
      {
        id: "gpt-6-sol",
        displayName: "GPT-6 Sol",
        contextWindowTokens: 1_050_000,
        maxOutputTokens: 128_000,
        inputModalities: ["text", "image"],
        efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
    ],
    documentationURL: "https://developers.openai.com/api/docs/models/gpt-6-sol",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseURL: "https://api.anthropic.com",
    wireApi: "anthropic_messages",
    envKey: "ANTHROPIC_API_KEY",
    catalogProvider: "anthropic",
    models: [
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
        inputModalities: ["text", "image"],
      },
    ],
    documentationURL:
      "https://platform.claude.com/docs/en/models/sonnet-4-6/overview",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    wireApi: "gemini_generate_content",
    envKey: "GEMINI_API_KEY",
    flavor: "gemini",
    models: [{ id: "gemini-3.8-flash", inputModalities: ["text", "image"] }],
    documentationURL: "https://ai.google.dev/gemini-api/docs/text-generation",
  },
  {
    id: "xai",
    name: "xAI",
    baseURL: "https://api.x.ai/v1",
    wireApi: "openai_responses",
    envKey: "XAI_API_KEY",
    catalogProvider: "grok",
    models: [{ id: "grok-4.7" }],
    documentationURL: "https://docs.x.ai/developers/quickstart",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    wireApi: "openai_chat_completions",
    envKey: "DEEPSEEK_API_KEY",
    flavor: "deepseek",
    models: [
      {
        id: "deepseek-flash",
        efforts: ["low", "high", "max"],
        defaultEffort: "high",
      },
    ],
    documentationURL: "https://api-docs.deepseek.com/guides/thinking_mode/",
  },
  {
    id: "qwen",
    name: "Qwen",
    // The fixed DashScope URL remains supported. Region/workspace URLs can be
    // entered in the connection when the API key belongs to another region.
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    wireApi: "openai_chat_completions",
    envKey: "DASHSCOPE_API_KEY",
    flavor: "qwen",
    models: [{ id: "qwen3.8-max" }],
    documentationURL:
      "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
  },
  {
    id: "moonshot",
    name: "Kimi API",
    baseURL: "https://api.moonshot.ai/v1",
    wireApi: "openai_responses",
    envKey: "MOONSHOT_API_KEY",
    models: [
      {
        id: "kimi-k3",
        contextWindowTokens: 1_048_576,
        // The Responses adapter currently sends still images only.
        inputModalities: ["text", "image"],
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
    ],
    // Kimi API credentials/models are separate from the Kimi Code subscription.
    documentationURL: "https://platform.kimi.ai/docs/api/responses",
  },
  {
    id: "glm",
    name: "GLM (Z.AI)",
    baseURL: "https://api.z.ai/api/paas/v4/",
    wireApi: "openai_chat_completions",
    envKey: "ZAI_API_KEY",
    models: [{ id: "glm-5.3" }],
    documentationURL: "https://docs.z.ai/guides/overview/quick-start",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    wireApi: "openai_chat_completions",
    envKey: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M2.7", contextWindowTokens: 204_800 }],
    documentationURL:
      "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    wireApi: "openai_chat_completions",
    envKey: "MISTRAL_API_KEY",
    flavor: "mistral",
    models: [{ id: "mistral-medium-latest" }],
    documentationURL: "https://docs.mistral.ai/vibe/code/cli/configuration",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "relay",
    baseURL: "https://openrouter.ai/api/v1",
    wireApi: "openai_chat_completions",
    envKey: "OPENROUTER_API_KEY",
    models: [],
    documentationURL: "https://openrouter.ai/docs/quickstart",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    kind: "relay",
    baseURL: "https://api.siliconflow.cn/v1",
    wireApi: "openai_chat_completions",
    envKey: "SILICONFLOW_API_KEY",
    models: [],
    documentationURL: "https://docs.siliconflow.cn/docs/api/models-get",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    noKey: true,
    baseURL: "http://localhost:11434/v1",
    wireApi: "openai_chat_completions",
    models: [],
    documentationURL: "https://docs.ollama.com/api/openai-compatibility",
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    kind: "local",
    noKey: true,
    baseURL: "http://localhost:1234/v1",
    wireApi: "openai_chat_completions",
    models: [],
    documentationURL: "https://lmstudio.ai/docs/developer/openai-compat/models",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    kind: "subscription",
    baseURL: "https://api.kimi.com/coding",
    wireApi: "anthropic_messages",
    envKey: "KIMI_API_KEY",
    catalogProvider: "kimi-code",
    models: [{ id: "kimi-for-coding" }],
    documentationURL: "https://www.kimi.com/code/docs/en/",
  },
]

// Native capabilities belong to an explicit service at its documented endpoint,
// not to an editable account name or a template label on a relay.
export function providerServiceForEndpoint(
  configuration: Pick<ProviderConfiguration, "service" | "baseURL" | "wireApi">,
): ProviderPreset | undefined {
  const service = providerServices.find(
    (entry) => entry.id === configuration.service,
  )
  if (service === undefined) return undefined
  const endpoints = [
    { baseURL: service.baseURL, wireApi: service.wireApi },
    ...(serviceEndpointVariants[service.id] ?? []),
  ]
  const url = new URL(configuration.baseURL).href.replace(/\/$/, "")
  return endpoints.some(
    (endpoint) =>
      endpoint.wireApi === configuration.wireApi &&
      new URL(endpoint.baseURL).href.replace(/\/$/, "") === url,
  )
    ? service
    : undefined
}

// API variants are explicit contracts. A different protocol or path on the
// same origin must not inherit native features from the creation template.
const serviceEndpointVariants: Readonly<
  Record<string, readonly Pick<ProviderConfiguration, "baseURL" | "wireApi">[]>
> = {
  openai: [
    {
      baseURL: "https://api.openai.com/v1",
      wireApi: "openai_chat_completions",
    },
  ],
  xai: [
    {
      baseURL: "https://api.x.ai/v1",
      wireApi: "openai_chat_completions",
    },
  ],
  gemini: [
    {
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      wireApi: "gemini_interactions",
    },
    {
      baseURL: "https://generativelanguage.googleapis.com/v1",
      wireApi: "gemini_interactions",
    },
    {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      wireApi: "openai_chat_completions",
    },
  ],
  "kimi-code": [
    {
      baseURL: "https://api.kimi.com/coding/v1",
      wireApi: "anthropic_messages",
    },
  ],
}
