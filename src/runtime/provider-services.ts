import { anthropicCodeModels } from "./anthropic-models.ts"
import { qwenEndpointPolicy } from "./qwen-endpoints.ts"
import { qwenModels } from "./qwen-models.ts"
import type {
  ProviderConfiguration,
  ProviderPreset,
} from "../protocol/providers.ts"

export type { ConfiguredModel, ProviderPreset } from "../protocol/providers.ts"

// Service definitions own documented endpoints and vendor behavior. Account
// labels and UI templates do not select a runtime protocol profile.
export const providerServices: readonly ProviderPreset[] = [
  {
    id: "amazon-nova",
    name: "Amazon Nova (Bedrock API key)",
    baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
    wireApi: "bedrock_converse",
    envKey: "AWS_BEARER_TOKEN_BEDROCK",
    models: [
      {
        id: "us.amazon.nova-2-lite-v1:0",
        displayName: "Nova 2 Lite (US inference profile)",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        maxOutputTokens: 65_000,
        efforts: ["none"],
        defaultEffort: "none",
      },
    ],
    documentationURL:
      "https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-converse-api.html",
  },
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
    models: anthropicCodeModels,
    documentationURL: "https://code.claude.com/docs/en/model-config",
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
    id: "meta",
    name: "Meta",
    baseURL: "https://api.meta.ai/v1",
    wireApi: "openai_chat_completions",
    envKey: "MODEL_API_KEY",
    flavor: "meta",
    models: [
      {
        id: "muse-spark-1.3",
        contextWindowTokens: 1_048_576,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      {
        id: "muse-wonder-1.0",
        contextWindowTokens: 1_048_576,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ],
    documentationURL: "https://dev.meta.ai/docs/image-understanding",
  },
  {
    id: "nvidia",
    name: "NVIDIA Nemotron",
    baseURL: "https://integrate.api.nvidia.com/v1",
    wireApi: "openai_chat_completions",
    envKey: "NVIDIA_API_KEY",
    flavor: "nvidia",
    models: [
      {
        id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        displayName: "Nemotron 3.5 Super VL",
        // Build's hosted configuration advertises 262144, not the weights' 1M.
        contextWindowTokens: 262_144,
        maxOutputTokens: 131_072,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        efforts: ["none", "low", "high"],
        defaultEffort: "high",
      },
    ],
    documentationURL:
      "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer",
  },
  {
    id: "reka",
    name: "Reka",
    baseURL: "https://api.reka.ai/v1",
    wireApi: "openai_chat_completions",
    envKey: "REKA_API_KEY",
    flavor: "reka",
    models: [
      {
        id: "reka-edge-2603",
        displayName: "Reka Edge 2603",
        contextWindowTokens: 16_384,
        contextWindowScope: "total",
        maxOutputTokens: 16_384,
        // Only still images are adapted here, not the model's video input.
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        efforts: [],
      },
    ],
    documentationURL: "https://docs.reka.ai/chat/models",
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
        inputModalities: ["text", "image"],
        imageDetailModes: ["high", "original"],
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
    models: qwenModels,
    documentationURL:
      "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
  },
  {
    id: "doubao",
    name: "Doubao (Volcengine Ark)",
    // Standard Ark API credentials, not the separate Coding Plan endpoint.
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    wireApi: "openai_chat_completions",
    envKey: "ARK_API_KEY",
    flavor: "doubao",
    models: [
      {
        id: "doubao-seed-2-1-pro-260915",
        displayName: "Doubao Seed 2.1 Pro",
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 262_144,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ],
    documentationURL:
      "https://console.volcengine.com/ark/region:cn-beijing/docs/model-list",
  },
  {
    id: "moonshot",
    name: "Kimi API",
    baseURL: "https://api.moonshot.ai/v1",
    wireApi: "openai_responses",
    envKey: "MOONSHOT_API_KEY",
    models: [
      {
        id: "kimi-k3.1-pro",
        displayName: "Kimi K3.1 Pro",
        contextWindowTokens: 1_048_576,
        // The Responses adapter currently sends still images only.
        inputModalities: ["text", "image"],
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
      {
        id: "kimi-k3.1-pro-highspeed",
        displayName: "Kimi K3.1 Pro Highspeed",
        contextWindowTokens: 1_048_576,
        // The Responses adapter currently sends still images only.
        inputModalities: ["text", "image"],
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
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
    flavor: "glm",
    models: [
      { id: "glm-5.3" },
      {
        id: "glm-5.3-flash",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        efforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
    ],
    documentationURL: "https://docs.z.ai/guides/overview/quick-start",
  },
  {
    id: "longcat",
    name: "LongCat (Meituan)",
    baseURL: "https://api.longcat.chat/openai/v1",
    wireApi: "openai_chat_completions",
    envKey: "LONGCAT_API_KEY",
    flavor: "longcat",
    models: [
      {
        id: "LongCat-2.5",
        displayName: "LongCat 2.5 (image chat only)",
        contextWindowTokens: 1_048_576,
        // The dedicated model-params page specifies 256K; Quick Start still
        // says 128K. Use the endpoint's linked parameter reference.
        maxOutputTokens: 262_144,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ],
    documentationURL:
      "https://longcat.chat/platform/docs/image-video-understanding",
  },
  {
    id: "sensenova",
    name: "SenseNova",
    baseURL: "https://token.sensenova.cn/v1",
    wireApi: "openai_chat_completions",
    envKey: "SENSENOVA_API_KEY",
    flavor: "sensenova",
    models: [
      {
        id: "sensenova-6.8-flash-lite",
        displayName: "SenseNova 6.8 Flash Lite Preview (chat only)",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ],
    documentationURL:
      "https://github.com/OpenSenseNova/SenseNova6.8/blob/main/API.md",
  },
  {
    id: "tencent",
    name: "Tencent TokenHub",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    wireApi: "openai_chat_completions",
    envKey: "TOKENHUB_API_KEY",
    flavor: "tencent",
    models: [
      {
        id: "hy-vision-2.0-instruct",
        displayName: "HY Vision 2.0 Instruct",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        contextWindowTokens: 24_000,
        contextWindowScope: "input",
        maxOutputTokens: 16_000,
      },
    ],
    documentationURL: "https://cloud.tencent.com/document/product/1823/130078",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    wireApi: "openai_chat_completions",
    envKey: "MINIMAX_API_KEY",
    flavor: "minimax",
    models: [
      {
        id: "MiniMax-M3.1-Flash",
        contextWindowTokens: 1_000_000,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "max",
      },
      {
        id: "MiniMax-M3",
        contextWindowTokens: 1_000_000,
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      { id: "MiniMax-M2.7", contextWindowTokens: 204_800 },
    ],
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
    id: "mimo",
    name: "Xiaomi MiMo",
    baseURL: "https://api.xiaomimimo.com/v1",
    wireApi: "openai_chat_completions",
    envKey: "MIMO_API_KEY",
    flavor: "mimo",
    models: [
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro-ultraspeed",
    ].map((id) => ({
      id,
      contextWindowTokens: 1_000_000,
      contextWindowScope: "total" as const,
      maxOutputTokens: 131072,
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
    })),
    documentationURL:
      "https://mimo.mi.com/docs/en-US/quick-start/summary/model",
  },
  {
    id: "stepfun",
    name: "StepFun",
    baseURL: "https://api.stepfun.com/v1",
    wireApi: "openai_chat_completions",
    envKey: "STEPFUN_API_KEY",
    flavor: "stepfun",
    models: [
      {
        id: "step-5-preview",
        displayName: "Step 5 Preview",
        contextWindowTokens: 1_000_000,
        contextWindowScope: "total",
        maxOutputTokens: 64_000,
        // Only still-image input is adapted here, not the model's video API.
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    ],
    documentationURL:
      "https://platform.stepfun.ai/docs/en/guides/models/step-5-preview",
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
    // Subscription IDs are intentionally different from public API IDs.
    models: [
      { id: "k3.1-pro" },
      { id: "k3.1-pro-highspeed" },
      { id: "kimi-for-coding" },
    ],
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
  if (service.id === "qwen")
    return configuration.wireApi === "openai_chat_completions" &&
      qwenEndpointPolicy(configuration.baseURL) !== undefined
      ? service
      : undefined
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
  stepfun: [
    {
      baseURL: "https://api.stepfun.ai/v1",
      wireApi: "openai_chat_completions",
    },
  ],
  // Official regional setup; credentials must belong to the selected region.
  // https://github.com/OpenSenseNova/SenseNova-Skills/blob/main/INSTALL.md
  sensenova: [
    {
      baseURL: "https://token.sensenova.ai/v1",
      wireApi: "openai_chat_completions",
    },
  ],
  tencent: [
    // Keys and service activation must match the selected region.
    {
      baseURL: "https://tokenhub-intl.tencentmaas.com/v1",
      wireApi: "openai_chat_completions",
    },
    {
      baseURL: "https://tokenhub.tencentmaas.cn/v1",
      wireApi: "openai_chat_completions",
    },
    {
      baseURL: "https://tokenhub-intl.tencentmaas.cn/v1",
      wireApi: "openai_chat_completions",
    },
  ],
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
