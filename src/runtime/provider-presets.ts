import type { InstructionProfileId } from "./model-catalog.ts"

export type ConfiguredModel = Readonly<{
  id: string
  displayName?: string
  contextWindowTokens?: number
  contextWindowScope?: "input" | "total"
  maxOutputTokens?: number
  inputModalities?: readonly ("text" | "image" | "video")[]
  efforts?: readonly string[]
  defaultEffort?: string
  instructionProfileId?: InstructionProfileId
  pricing?: Readonly<{
    inputPerMillion: number
    outputPerMillion: number
    cacheReadPerMillion?: number
    cacheWritePerMillion?: number
  }>
}>

export type ProviderPreset = Readonly<{
  id: string
  name: string
  baseURL: string
  wireApi:
    | "openai_responses"
    | "openai_chat_completions"
    | "anthropic_messages"
    | "gemini_generate_content"
  envKey?: string
  kind?: "vendor" | "relay" | "local" | "subscription"
  noKey?: boolean
  flavor?: "generic" | "deepseek" | "gemini" | "qwen" | "mistral"
  catalogProvider?: string
  models: readonly ConfiguredModel[]
  documentationURL: string
}>

// Presets are editable starting points. Optional model facts are included only
// when first-party documentation states them; omitted capacities remain unknown.
export const providerPresets: readonly ProviderPreset[] = [
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
    wireApi: "openai_chat_completions",
    envKey: "MOONSHOT_API_KEY",
    models: [
      {
        id: "kimi-k3",
        contextWindowTokens: 1_000_000,
        // The Chat Completions adapter currently sends still images only.
        inputModalities: ["text", "image"],
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
    ],
    // Kimi API credentials/models are separate from the Kimi Code subscription.
    documentationURL: "https://platform.kimi.ai/docs/overview",
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
    catalogProvider: "kimi",
    models: [{ id: "kimi-for-coding" }],
    documentationURL: "https://www.kimi.com/code/docs/en/",
  },
]
