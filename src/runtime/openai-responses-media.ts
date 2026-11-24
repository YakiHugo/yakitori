import { AssetMediaError, type prepareProviderMedia } from "./asset-media.ts"
import {
  CODEX_IMAGE_REQUEST_SAFETY_BYTES,
  CodexImageRequestSizeError,
  prepareCodexImage,
  validateCodexImageRequest,
} from "./codex-image-policy.ts"
import {
  GROK_IMAGE_REQUEST_SAFETY_BYTES,
  GrokImageRequestSizeError,
  prepareGrokImage,
} from "./grok-image-policy.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import { prepareKimiImageBytes } from "./kimi-image-policy.ts"
import type { ModelDocumentBlock, ModelMessage, ModelRequest } from "./model.ts"
import {
  OPENAI_IMAGE_REQUEST_SAFETY_BYTES,
  OpenAIImageRequestSizeError,
  prepareOpenAIImage,
  validateOpenAIImageRequest,
} from "./openai-image-policy.ts"
import {
  hasOpenAIImagePreparation,
  openAIVisionPolicy,
} from "./openai-vision-models.ts"

type MediaOptions = NonNullable<Parameters<typeof prepareProviderMedia>[1]>
type BuildResponsesBody = (
  messages: readonly ModelMessage[],
  uploads: ReadonlyMap<ModelDocumentBlock, string>,
) => unknown
export type ResponsesMediaContext = Readonly<{
  request: ModelRequest
  model: string
  baseURL: string
}>
export type ResponsesMediaPolicy = Readonly<{
  prepare?(buildBody: BuildResponsesBody): MediaOptions
  validateBody?(body: unknown): void
}>

function hasImages(request: ModelRequest) {
  return request.messages.some(
    (message) =>
      (message.role === "user" || message.role === "tool") &&
      message.content.some((block) => block.type === "image"),
  )
}

function placeholderBudget(
  request: ModelRequest,
  buildBody: BuildResponsesBody,
  budget: number,
  error: new () => AssetMediaError,
  includeDocuments = false,
): number {
  const messages = request.messages.map(
    (message): ModelMessage =>
      message.role === "user" || message.role === "tool"
        ? {
            ...message,
            content: message.content.map((block) =>
              block.type === "image"
                ? {
                    type: "image",
                    mediaType: "image/png",
                    data: "",
                    detail: block.detail ?? "high",
                  }
                : includeDocuments &&
                    block.type === "document" &&
                    block.data === undefined &&
                    !("url" in block.file)
                  ? { ...block, data: "" }
                  : block,
            ),
          }
        : message,
  )
  const size = jsonRequestByteLength(buildBody(messages, new Map()), budget)
  if (size === undefined) throw new error()
  return size
}

export function openAIResponsesMedia({
  request,
  model,
  baseURL,
}: ResponsesMediaContext): ResponsesMediaPolicy | undefined {
  if (
    !hasOpenAIImagePreparation(model) ||
    URL.parse(baseURL)?.href.replace(/\/$/, "") !== "https://api.openai.com/v1"
  )
    return undefined
  const validateBody = (body: unknown) =>
    validateOpenAIImageRequest(body, openAIVisionPolicy(model) !== undefined)
  return {
    validateBody,
    prepare(buildBody) {
      let bytesReserved = placeholderBudget(
        request,
        (messages, uploads) => {
          const body = buildBody(messages, uploads)
          validateBody(body)
          return body
        },
        OPENAI_IMAGE_REQUEST_SAFETY_BYTES,
        OpenAIImageRequestSizeError,
        true,
      )
      let inlineBytes = bytesReserved
      for (const message of request.messages) {
        if (message.role !== "user" && message.role !== "tool") continue
        for (const block of message.content) {
          if (block.type === "image" && block.data !== undefined)
            inlineBytes += block.data.length + 1
          if (inlineBytes > OPENAI_IMAGE_REQUEST_SAFETY_BYTES)
            throw new OpenAIImageRequestSizeError()
        }
      }
      return {
        async prepareImage(bytes, image) {
          bytesReserved += 4 * Math.ceil(bytes.length / 3) + 1
          if (bytesReserved > OPENAI_IMAGE_REQUEST_SAFETY_BYTES)
            throw new OpenAIImageRequestSizeError()
          return prepareOpenAIImage(bytes, image, model, request.signal)
        },
      }
    },
  }
}

export function codexResponsesMedia({
  request,
}: ResponsesMediaContext): ResponsesMediaPolicy {
  const images = hasImages(request)
  if (
    images &&
    request.messages.some(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.some(
          (block) =>
            block.type === "image" &&
            block.data === undefined &&
            "url" in block.file,
        ),
    )
  )
    throw new AssetMediaError(
      "Codex image URLs are not supported. Import the image as an attachment before sending; no remote image was fetched.",
    )
  return {
    ...(images ? { validateBody: validateCodexImageRequest } : {}),
    prepare(buildBody) {
      let bytesReserved = images
        ? placeholderBudget(
            request,
            buildBody,
            CODEX_IMAGE_REQUEST_SAFETY_BYTES,
            CodexImageRequestSizeError,
          )
        : 0
      return {
        inlineImageUrls: true,
        async prepareImage(bytes, image) {
          const prepared = await prepareCodexImage(bytes, image, request.signal)
          bytesReserved +=
            (prepared.data?.length ?? 0) +
            prepared.mediaType.length -
            "image/png".length
          if (bytesReserved > CODEX_IMAGE_REQUEST_SAFETY_BYTES)
            throw new CodexImageRequestSizeError()
          return prepared
        },
      }
    },
  }
}

export function grokResponsesMedia({
  request,
  model,
  baseURL,
}: ResponsesMediaContext): ResponsesMediaPolicy | undefined {
  if (
    model !== "grok-4.7" ||
    URL.parse(baseURL)?.href.replace(/\/$/, "") !== "https://api.x.ai/v1"
  )
    return undefined
  let bytesReserved = 0
  return {
    validateBody(body) {
      if (
        jsonRequestByteLength(body, GROK_IMAGE_REQUEST_SAFETY_BYTES) ===
        undefined
      )
        throw new GrokImageRequestSizeError()
    },
    prepare: () => ({
      async prepareImage(bytes) {
        bytesReserved += 4 * Math.ceil(bytes.length / 3)
        if (bytesReserved > GROK_IMAGE_REQUEST_SAFETY_BYTES)
          throw new GrokImageRequestSizeError()
        return prepareGrokImage(bytes, request.signal)
      },
    }),
  }
}

// Local resource guard, not Moonshot's documented 100M request allowance.
const KIMI_IMAGE_REQUEST_SAFETY_BYTES = 20_000_000
class KimiImageRequestSizeError extends AssetMediaError {
  constructor() {
    super(
      "Image request was not sent: exceeds Yakitori's conservative 20 MB local request budget. Send fewer images, crop or export a smaller copy, or reduce other request content; originals have not been changed.",
    )
  }
}

export function kimiResponsesMedia({
  request,
  baseURL,
}: ResponsesMediaContext): ResponsesMediaPolicy {
  if (
    URL.parse(baseURL)?.href.replace(/\/$/, "") !==
      "https://api.moonshot.ai/v1" ||
    !hasImages(request)
  )
    return { prepare: () => ({ inlineImageUrls: true }) }
  return {
    validateBody(body) {
      if (
        jsonRequestByteLength(body, KIMI_IMAGE_REQUEST_SAFETY_BYTES) ===
        undefined
      )
        throw new KimiImageRequestSizeError()
    },
    prepare(buildBody) {
      let bytesReserved = placeholderBudget(
        request,
        buildBody,
        KIMI_IMAGE_REQUEST_SAFETY_BYTES,
        KimiImageRequestSizeError,
      )
      return {
        inlineImageUrls: true,
        async prepareImage(bytes, image) {
          const prepared = await prepareKimiImageBytes(bytes, request.signal)
          bytesReserved +=
            4 * Math.ceil(prepared.bytes.length / 3) +
            prepared.mediaType.length -
            "image/png".length
          if (bytesReserved > KIMI_IMAGE_REQUEST_SAFETY_BYTES)
            throw new KimiImageRequestSizeError()
          return {
            type: "image",
            mediaType: prepared.mediaType,
            detail: image.detail ?? "high",
            data: prepared.bytes.toString("base64"),
          }
        },
      }
    },
  }
}
