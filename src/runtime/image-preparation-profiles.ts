import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import { AssetMediaError } from "./asset-media.ts"
import {
  deepseekImagePolicy,
  isDeepseekVisionModel,
} from "./deepseek-image-policy.ts"
import { createDoubaoImagePolicy } from "./doubao-image-policy.ts"
import { createGlmImagePolicy } from "./glm-image-policy.ts"
import { createMetaImagePolicy, isMetaEndpoint } from "./meta-image-policy.ts"
import { createMiniMaxImagePolicy } from "./minimax-image-policy.ts"
import { createQwenImagePolicy } from "./qwen-image-policy.ts"
import { createTencentImagePolicy } from "./tencent-image-policy.ts"
import { isDoubaoVisionModel } from "./doubao-models.ts"
import {
  createLongCatImagePolicy,
  isLongCatEndpoint,
  longcatVisionModel,
} from "./longcat-vision.ts"
import { isMetaVisionModel } from "./meta-models.ts"
import {
  createMimoImagePolicy,
  isMimoEndpoint,
  isMimoVisionModel,
} from "./mimo-image-policy.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
  ModelWireApi,
} from "./model.ts"
import {
  createNvidiaImagePolicy,
  isNvidiaEndpoint,
  nvidiaVisionModel,
} from "./nvidia-image-policy.ts"
import type { ResolvedModel } from "./model-catalog.ts"
import {
  openAIImageTokenEstimator,
  type ImageTokenEstimator,
} from "./openai-image-budget.ts"
import { hasOpenAIImagePreparation } from "./openai-vision-models.ts"
import { isQwenVisionModel } from "./qwen-models.ts"
import {
  createRekaVisionPolicy,
  isRekaEndpoint,
  rekaVisionModel,
} from "./reka-vision.ts"
import {
  isSenseNovaEndpoint,
  prepareSenseNovaImage,
  sensenovaVisionModel,
} from "./sensenova-vision.ts"
import {
  createStepfunImagePolicy,
  isStepfunEndpoint,
} from "./stepfun-image-policy.ts"
import { isStepfunVisionModel } from "./stepfun-models.ts"
import { tencentVisionModel } from "./tencent-chat-only.ts"

type ChatImagePolicy = Readonly<{
  prepareImage?(bytes: Buffer, image: ModelImageBlock): Promise<ModelImageBlock>
  inlineImageUrls?: boolean
  validateBody?(
    body: { messages: ChatCompletionMessageParam[] },
    messages: readonly ModelMessage[],
  ): void
}>

type ImagePreparationProfile = Readonly<{
  wireApi: ModelWireApi
  // Absent means the adapter owns preparation and rejection for every model,
  // not that unknown models gain image capabilities.
  model?: string | ((model: string) => boolean)
  imageTokens?: number
  // Direct adapter callers historically have different endpoint fallbacks.
  // Keep those checks here rather than granting every flavor native behavior.
  chat?(
    input: Readonly<{
      request: ModelRequest
      model: string
      baseURL: string
      nativeModel: boolean
    }>,
  ): ChatImagePolicy | undefined
}>

// The Turn must not apply generic resizing before these native adapters see
// the source bytes. Service identity is resolved from the exact endpoint by
// the backend; an editable connection name or model prefix is not evidence.
// Keep model facts in their existing model/policy modules where available.
const profiles: Readonly<Record<string, ImagePreparationProfile>> = {
  nvidia: {
    wireApi: "openai_chat_completions",
    model: nvidiaVisionModel,
    chat: ({ request, baseURL }) =>
      isNvidiaEndpoint(baseURL) ? createNvidiaImagePolicy(request) : undefined,
  },
  codex: { wireApi: "openai_responses" },
  openai: { wireApi: "openai_responses", model: hasOpenAIImagePreparation },
  xai: { wireApi: "openai_responses", model: "grok-4.7" },
  meta: {
    wireApi: "openai_chat_completions",
    model: isMetaVisionModel,
    chat: ({ request, model, baseURL }) =>
      isMetaEndpoint(baseURL)
        ? createMetaImagePolicy(request, model)
        : undefined,
  },
  anthropic: { wireApi: "anthropic_messages" },
  "kimi-code": { wireApi: "anthropic_messages" },
  gemini: { wireApi: "gemini_generate_content" },
  moonshot: { wireApi: "openai_responses" },
  longcat: {
    wireApi: "openai_chat_completions",
    model: longcatVisionModel,
    chat: ({ request, baseURL }) =>
      isLongCatEndpoint(baseURL)
        ? createLongCatImagePolicy(request)
        : undefined,
  },
  sensenova: {
    wireApi: "openai_chat_completions",
    model: sensenovaVisionModel,
    chat: ({ request, baseURL }) =>
      isSenseNovaEndpoint(baseURL)
        ? {
            inlineImageUrls: true,
            prepareImage: (bytes, image) =>
              prepareSenseNovaImage(bytes, image, request.signal),
          }
        : undefined,
  },
  tencent: {
    wireApi: "openai_chat_completions",
    model: tencentVisionModel,
    chat: ({ request, nativeModel }) => {
      if (!nativeModel) {
        if (
          request.messages.some(
            (message) =>
              (message.role === "user" || message.role === "tool") &&
              message.content.some((block) => block.type === "image"),
          )
        )
          throw new AssetMediaError(
            "TokenHub image input is only enabled for the documented HY Vision 2.0 Instruct model.",
          )
        return undefined
      }
      return {
        ...createTencentImagePolicy(request.signal),
        inlineImageUrls: true,
      }
    },
  },
  // These existing direct-call contracts are flavor-scoped. Production service
  // resolution still requires a verified endpoint before assigning the flavor.
  minimax: {
    wireApi: "openai_chat_completions",
    chat: ({ request, model }) => createMiniMaxImagePolicy(request, model),
  },
  doubao: {
    wireApi: "openai_chat_completions",
    model: isDoubaoVisionModel,
    // Seed 2.1 and Evolving high detail have a fixed 1280-token image cost.
    // The adapter always sends high; never apply this to relay profiles.
    // https://console.volcengine.com/ark/region:cn-beijing/docs/image-understanding
    // https://console.volcengine.com/ark/region:cn-beijing/docs/latest-model
    imageTokens: 1280,
    chat: ({ request, model }) => createDoubaoImagePolicy(request, model),
  },
  qwen: {
    wireApi: "openai_chat_completions",
    model: isQwenVisionModel,
    chat: ({ request, model, baseURL }) =>
      createQwenImagePolicy(request, model, baseURL),
  },
  deepseek: {
    wireApi: "openai_chat_completions",
    model: isDeepseekVisionModel,
    chat: ({ request, model, baseURL }) =>
      deepseekImagePolicy(baseURL, model, request),
  },
  glm: {
    wireApi: "openai_chat_completions",
    model: "glm-5.3-flash",
    chat: ({ request, nativeModel }) =>
      nativeModel ? createGlmImagePolicy(request) : undefined,
  },
  stepfun: {
    wireApi: "openai_chat_completions",
    model: isStepfunVisionModel,
    chat: ({ request, model, baseURL }) =>
      isStepfunEndpoint(baseURL)
        ? createStepfunImagePolicy(request, model)
        : undefined,
  },
  mimo: {
    wireApi: "openai_chat_completions",
    model: isMimoVisionModel,
    chat: ({ request, model, baseURL }) =>
      isMimoEndpoint(baseURL)
        ? createMimoImagePolicy(request, model)
        : undefined,
  },
  reka: {
    wireApi: "openai_chat_completions",
    model: rekaVisionModel,
    chat: ({ request, model, baseURL }) => {
      if (!isRekaEndpoint(baseURL)) return undefined
      const policy = createRekaVisionPolicy(request, model)
      return {
        prepareImage: policy.prepareImage,
        validateBody: (body) => policy.validateBody(body, body.messages),
      }
    },
  },
}

function deferImagePreparation(input: {
  serviceId?: string | undefined
  wireApi?: ModelWireApi | undefined
  model: string
}): boolean {
  // Bedrock's Converse adapter owns image admission regardless of the AWS
  // account's label. This is deliberately a wire-level rule, unlike the rest.
  if (input.wireApi === "bedrock_converse") return true
  if (
    input.serviceId === undefined ||
    !Object.hasOwn(profiles, input.serviceId)
  )
    return false
  const profile = profiles[input.serviceId]
  return (
    profile !== undefined &&
    profile.wireApi === input.wireApi &&
    (profile.model === undefined ||
      (typeof profile.model === "string"
        ? profile.model === input.model
        : profile.model(input.model)))
  )
}

export function resolveImagePreparation(input: {
  serviceId?: string | undefined
  wireApi?: ModelWireApi | undefined
  model: ResolvedModel
}): Readonly<{
  deferImagePreparation: boolean
  imageTokenEstimator: ImageTokenEstimator | undefined
}> {
  const defer = deferImagePreparation({ ...input, model: input.model.model })
  const imageTokens =
    defer && input.serviceId !== undefined
      ? profiles[input.serviceId]?.imageTokens
      : undefined
  return {
    deferImagePreparation: defer,
    imageTokenEstimator:
      input.wireApi === "bedrock_converse"
        ? () => 230
        : imageTokens !== undefined
          ? () => imageTokens
          : openAIImageTokenEstimator(input),
  }
}

// One selected policy owns both byte preparation and final serialized-body
// admission, so adding a factory cannot silently omit its request guard.
export function createChatImagePolicy(input: {
  flavor?: string | undefined
  baseURL: string
  model: string
  request: ModelRequest
}): ChatImagePolicy | undefined {
  if (input.flavor === undefined || !Object.hasOwn(profiles, input.flavor))
    return undefined
  return profiles[input.flavor]?.chat?.({
    ...input,
    nativeModel: deferImagePreparation({
      serviceId: input.flavor,
      wireApi: "openai_chat_completions",
      model: input.model,
    }),
  })
}
