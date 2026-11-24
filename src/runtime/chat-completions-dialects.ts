import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import type { JsonObject } from "../kernel/index.ts"
import type { ProviderPreset } from "../protocol/providers.ts"
import { AssetMediaError } from "./asset-media.ts"
import {
  type ChatImagePolicy,
  createDeclarativeChatImagePolicy,
  type ImageAdmissionSpec,
} from "./chat-image-admission.ts"
import {
  doubaoImageSpec,
  glmImageSpec,
  mimoImageSpec,
  minimaxImageSpec,
} from "./chat-image-specs.ts"
import {
  deepseekImagePolicy,
  isDeepseekVisionModel,
} from "./deepseek-image-policy.ts"
import { glmTextModel } from "./glm-models.ts"
import {
  createLongCatImagePolicy,
  longcatVisionModel,
} from "./longcat-vision.ts"
import { createMetaImagePolicy } from "./meta-image-policy.ts"
import { isMetaContributorModel, isMetaVisionModel } from "./meta-models.ts"
import type { ModelRequest } from "./model.ts"
import { validateChatOnlyRequest } from "./model-request-plan.ts"
import {
  createNvidiaImagePolicy,
  nvidiaVisionModel,
  validateNvidiaRequest,
} from "./nvidia-image-policy.ts"
import { providerServiceForEndpoint } from "./provider-services.ts"
import { createQwenImagePolicy } from "./qwen-image-policy.ts"
import { isQwenVisionModel } from "./qwen-models.ts"
import { createRekaVisionPolicy, rekaVisionModel } from "./reka-vision.ts"
import {
  prepareSenseNovaImage,
  sensenovaVisionModel,
} from "./sensenova-vision.ts"
import {
  validateSparkChatMessages,
  validateSparkChatRequest,
} from "./spark-chat-policy.ts"
import { createStepfunImagePolicy } from "./stepfun-image-policy.ts"
import { isStepfunVisionModel } from "./stepfun-models.ts"
import { tencentVisionModel } from "./tencent-chat-only.ts"
import { createTencentImagePolicy } from "./tencent-image-policy.ts"

export type ChatCompletionsFlavor = NonNullable<ProviderPreset["flavor"]>
type Wire = Readonly<{
  maxOutputTokensField: "max_tokens" | "max_completion_tokens"
  includeStreamUsage: boolean
  omitImageDetail?: readonly ("user" | "tool")[]
}>
type Reasoning = Readonly<{
  extractFields: readonly ("reasoning_content" | "reasoning")[]
  echoMode: "none" | "scoped" | "native_only"
}>
type Media = Readonly<
  {
    deferFor?: (model: string) => boolean
    imageTokens?: number
  } & (
    | {
        spec:
          | ImageAdmissionSpec
          | ((model: string) => ImageAdmissionSpec | undefined)
      }
    | {
        customPolicy(
          request: ModelRequest,
          model: string,
          baseURL: string,
        ): ChatImagePolicy | undefined
      }
  )
>
type RequestBody = Readonly<{
  messages: readonly ChatCompletionMessageParam[]
  thinking?: JsonObject
}>
export type ChatCompletionsDialect = Readonly<{
  matchesEndpoint(baseURL: string): boolean
  wire: Wire | ((model: string) => Wire)
  reasoning: Reasoning
  media?: Media
  validateRequest?(request: ModelRequest, model: string): void
  extendBody?(body: RequestBody, model: string): object
  validateBody?(body: RequestBody, request: ModelRequest): void
  assistantHistory?: "portable"
  thoughtSignatures?: boolean
  encryptedReasoning?: boolean
  emptyFinishReason?: boolean
  cachedTokens?: boolean
  checkStreamCode?: boolean
  functionToolsOnly?: string
  incompleteFinish?: Readonly<{ reason: string; message: string }>
}>

const standardWire = {
  maxOutputTokensField: "max_tokens",
  includeStreamUsage: true,
} as const
const nativeUsage = { ...standardWire, includeStreamUsage: false } as const
const nativeCompletionTokens = {
  ...nativeUsage,
  maxOutputTokensField: "max_completion_tokens",
} as const
const omitAll = ["user", "tool"] as const
const omitUser = ["user"] as const
const compatibleReasoning = {
  extractFields: ["reasoning_content", "reasoning"],
  echoMode: "scoped",
} as const

export const genericChatDialect = {
  wire: standardWire,
  reasoning: compatibleReasoning,
} satisfies Pick<ChatCompletionsDialect, "wire" | "reasoning">

function nativeDialect(
  flavor: ChatCompletionsFlavor,
  settings: Partial<Omit<ChatCompletionsDialect, "matchesEndpoint">> = {},
): ChatCompletionsDialect {
  return {
    ...genericChatDialect,
    ...settings,
    matchesEndpoint(baseURL) {
      return (
        URL.parse(baseURL) !== null &&
        providerServiceForEndpoint({
          service: flavor,
          wireApi: "openai_chat_completions",
          baseURL,
        }) !== undefined
      )
    },
  }
}

const chatDialects = {
  stepfun: nativeDialect("stepfun", {
    wire: nativeUsage,
    emptyFinishReason: true,
    cachedTokens: true,
    media: {
      deferFor: isStepfunVisionModel,
      customPolicy: createStepfunImagePolicy,
    },
  }),
  mimo: nativeDialect("mimo", {
    wire: { ...nativeCompletionTokens, omitImageDetail: omitAll },
    media: { deferFor: mimoImageSpec.visionModel.matches, spec: mimoImageSpec },
    validateRequest(request) {
      if (
        (request.toolChoice !== undefined && request.toolChoice !== "auto") ||
        request.parallelToolCalls !== undefined ||
        request.target.effort !== undefined ||
        request.outputFormat !== undefined
      )
        throw new AssetMediaError(
          "MiMo Chat supports only auto tool choice and does not document parallel-tool, reasoning-effort or JSON-schema controls. Remove those overrides; the request was not sent.",
        )
    },
    validateBody({ messages, thinking }, request) {
      if (
        thinking?.type !== "disabled" &&
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.length &&
            !(
              "reasoning_content" in message &&
              typeof message.reasoning_content === "string"
            ),
        )
      )
        throw new AssetMediaError(
          "MiMo thinking-mode tool history requires its original reasoning_content. Start a new conversation, disable thinking explicitly, or use the original provider; history has not been changed.",
        )
      if (
        request.tools.some(
          (tool) =>
            tool.kind === "custom" && tool.customInputFallbackKey === undefined,
        ) ||
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.some((call) => call.type !== "function"),
        )
      )
        throw new AssetMediaError(
          "MiMo Chat supports function tools, not native custom tools. Configure a function fallback or start a new conversation for incompatible tool history; history has not been changed.",
        )
    },
    incompleteFinish: {
      reason: "repetition_truncation",
      message:
        "MiMo stopped with repetition_truncation: output is incomplete and tool calls were not executed. Reduce repetitive context and retry.",
    },
  }),
  sensenova: nativeDialect("sensenova", {
    ...portableImageChat(),
    emptyFinishReason: true,
    validateRequest(request, model) {
      validateChatOnlyRequest(request)
      if (
        model !== sensenovaVisionModel ||
        request.outputFormat !== undefined ||
        request.target.effort !== undefined
      )
        throw new AssetMediaError(
          "SenseNova chat currently supports sensenova-6.8-flash-lite without output-format or reasoning-effort overrides only.",
        )
    },
    media: {
      deferFor: (model) => model === sensenovaVisionModel,
      customPolicy: (request) => ({
        inlineImageUrls: true,
        prepareImage: (bytes, image) =>
          prepareSenseNovaImage(bytes, image, request.signal),
      }),
    },
  }),
  longcat: nativeDialect("longcat", {
    ...portableImageChat(),
    validateRequest(request, model) {
      validateChatOnlyRequest(request)
      if (
        model !== longcatVisionModel ||
        request.outputFormat !== undefined ||
        request.target.effort !== undefined ||
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some((block) => block.type === "document"),
        )
      )
        throw new AssetMediaError(
          "LongCat image chat supports LongCat-2.5 text/images only, without native documents, output-format or reasoning-effort overrides.",
        )
    },
    media: {
      deferFor: (model) => model === longcatVisionModel,
      customPolicy: createLongCatImagePolicy,
    },
  }),
  reka: nativeDialect("reka", {
    wire: { ...nativeUsage, omitImageDetail: omitAll },
    media: {
      deferFor: (model) => model === rekaVisionModel,
      customPolicy(request, model) {
        const policy = createRekaVisionPolicy(request, model)
        return {
          prepareImage: policy.prepareImage,
          validateBody: (body) => policy.validateBody(body, body.messages),
        }
      },
    },
  }),
  spark: nativeDialect("spark", {
    wire: nativeCompletionTokens,
    checkStreamCode: true,
    functionToolsOnly: "Spark MaaS returned an unsupported native custom tool.",
    validateRequest: validateSparkChatRequest,
    validateBody: ({ messages }) => validateSparkChatMessages(messages),
  }),
  glm: nativeDialect("glm", {
    wire: (model) => ({
      ...(glmTextModel(model) ? nativeUsage : standardWire),
      omitImageDetail: omitAll,
    }),
    media: {
      deferFor: (model) => model === "glm-5.3-flash",
      spec: (model) => (model === "glm-5.3-flash" ? glmImageSpec : undefined),
    },
    validateRequest(request, model) {
      const textModel = glmTextModel(model)
      if (!textModel) return
      validateTextModel(request, model)
      if (
        (request.toolChoice !== undefined && request.toolChoice !== "auto") ||
        request.parallelToolCalls !== undefined ||
        (request.target.effort !== undefined &&
          !textModel.efforts?.includes(request.target.effort))
      )
        throw new AssetMediaError(
          `${model} requires auto tool choice and a documented reasoning control, without a parallel-tool override. The request was not sent.`,
        )
    },
    extendBody: ({ thinking }, model) =>
      glmTextModel(model)
        ? { thinking: { type: "enabled", clear_thinking: false, ...thinking } }
        : {},
  }),
  deepseek: nativeDialect("deepseek", {
    validateRequest(request, model) {
      if (model === "deepseek-v4-pro") validateTextModel(request, model)
    },
    media: {
      deferFor: isDeepseekVisionModel,
      customPolicy: (request, model, baseURL) =>
        deepseekImagePolicy(baseURL, model, request),
    },
  }),
  doubao: nativeDialect("doubao", {
    encryptedReasoning: true,
    media: {
      deferFor: doubaoImageSpec.visionModel.matches,
      imageTokens: 1280,
      spec: doubaoImageSpec,
    },
  }),
  gemini: nativeDialect("gemini", { thoughtSignatures: true }),
  minimax: nativeDialect("minimax", {
    media: { deferFor: () => true, spec: minimaxImageSpec },
  }),
  nvidia: nativeDialect("nvidia", {
    validateRequest: validateNvidiaRequest,
    media: {
      deferFor: (model) => model === nvidiaVisionModel,
      customPolicy: createNvidiaImagePolicy,
    },
  }),
  meta: nativeDialect("meta", {
    validateRequest(_request, model) {
      if (isMetaContributorModel(model))
        throw new AssetMediaError(
          "Meta Contributor models are not enabled: they allow Meta to train on prompts, code, files and responses. Yakitori has no informed data-sharing opt-in for these models yet. Choose the Standard model ID without -contributor; nothing was sent.",
        )
    },
    media: { deferFor: isMetaVisionModel, customPolicy: createMetaImagePolicy },
  }),
  qwen: nativeDialect("qwen", {
    wire: { ...standardWire, omitImageDetail: omitAll },
    media: { deferFor: isQwenVisionModel, customPolicy: createQwenImagePolicy },
  }),
  tencent: nativeDialect("tencent", {
    wire: { ...standardWire, omitImageDetail: omitAll },
    validateRequest(request, model) {
      if (model === tencentVisionModel) validateChatOnlyRequest(request)
    },
    media: {
      deferFor: (model) => model === tencentVisionModel,
      customPolicy(request, model) {
        if (model !== tencentVisionModel) {
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
  }),
} satisfies Partial<Record<ChatCompletionsFlavor, ChatCompletionsDialect>>

function portableImageChat() {
  return {
    wire: { ...nativeUsage, omitImageDetail: omitUser },
    reasoning: { ...compatibleReasoning, echoMode: "none" },
    assistantHistory: "portable",
  } as const
}

function validateTextModel(request: ModelRequest, model: string): void {
  if (
    request.messages.some(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.some(
          (block) => block.type === "image" || block.type === "document",
        ),
    )
  )
    throw new AssetMediaError(
      `${model} accepts text only. Choose a verified vision model or provide extracted text; media was not sent.`,
    )
  if (request.outputFormat !== undefined)
    throw new AssetMediaError(
      `${model} does not document JSON-schema output. Remove the output-format override; the request was not sent.`,
    )
}

export function chatDialectMedia(serviceId: string | undefined, model: string) {
  const media =
    serviceId && Object.hasOwn(chatDialects, serviceId)
      ? chatDialects[serviceId as keyof typeof chatDialects].media
      : undefined
  return media?.deferFor?.(model)
    ? { imageTokens: media.imageTokens }
    : undefined
}

type DialectOptions = Readonly<{
  flavor?: ChatCompletionsFlavor
  baseURL: string
}>
export type ResolvedChatDialect = Readonly<
  Omit<
    Partial<ChatCompletionsDialect>,
    "wire" | "reasoning" | "media" | "matchesEndpoint"
  > & {
    wire: Wire
    reasoning: Reasoning
    prepareMedia?(request: ModelRequest): ChatImagePolicy | undefined
  }
>

export function resolveChatCompletionsDialect(
  options: DialectOptions,
  model: string,
): ResolvedChatDialect {
  const flavor = options.flavor ?? "generic"
  const dialect = Object.hasOwn(chatDialects, flavor)
    ? chatDialects[flavor as keyof typeof chatDialects]
    : undefined
  if (!dialect?.matchesEndpoint(options.baseURL)) return genericChatDialect
  const { media, wire, ...settings } = dialect
  return {
    ...settings,
    wire: typeof wire === "function" ? wire(model) : wire,
    ...(media === undefined
      ? {}
      : {
          prepareMedia(request: ModelRequest) {
            if ("customPolicy" in media)
              return media.customPolicy(request, model, options.baseURL)
            const spec =
              typeof media.spec === "function" ? media.spec(model) : media.spec
            return spec === undefined
              ? undefined
              : createDeclarativeChatImagePolicy(spec, request, model)
          },
        }),
  }
}
