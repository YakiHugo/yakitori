import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import {
  InvalidImageDataError,
  inspectImageBytes,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelMessage, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export type ChatImagePolicy = Readonly<{
  inlineImageUrls?: boolean
  prepareImage?(bytes: Buffer, image: ModelImageBlock): Promise<ModelImageBlock>
  validateBody?(
    body: { messages: ChatCompletionMessageParam[] },
    messages: readonly ModelMessage[],
  ): void
}>

type Limit = Readonly<{ bytes: number; exclusive?: boolean; message: string }>
type ImageMetadata = ReturnType<typeof inspectImageBytes>

export type ImageAdmissionSpec = Readonly<{
  visionModel?: { matches(model: string): boolean; message: string }
  maxImages?: { value: number; message: string }
  inlineImageUrls?: boolean
  onlyWithImages?: boolean
  allowedMediaTypes?: { values: readonly string[]; message: string }
  maxPixelsPerSide?: { value: number; message: string }
  dimensions?: { accepts(metadata: ImageMetadata): boolean; message: string }
  maxImageBytes?: Limit & {
    sizeMeasure: "raw" | "base64" | "data_uri"
    invalidImage?: boolean
  }
  requestBudget?: {
    bytes: number
    sizeMeasure?: "base64" | "data_uri"
    encodedMessage: string
    bodyMessage: string
    onlyWithImages?: boolean
  }
}>

type DeclarativeChatImagePolicy = Readonly<{
  inlineImageUrls?: boolean
  prepareImage(bytes: Buffer, image: ModelImageBlock): Promise<ModelImageBlock>
  validateBody(body: unknown): void
}>

export function createDeclarativeChatImagePolicy(
  spec: ImageAdmissionSpec,
  request: ModelRequest,
  model: string,
): DeclarativeChatImagePolicy | undefined {
  const count = request.messages.reduce(
    (total, message) =>
      total +
      (message.role === "user" || message.role === "tool"
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  )
  if (count === 0 && spec.onlyWithImages) return undefined
  if (count > 0 && spec.visionModel && !spec.visionModel.matches(model))
    throw new AssetMediaError(spec.visionModel.message)
  if (spec.maxImages && count > spec.maxImages.value)
    throw new AssetMediaError(spec.maxImages.message)
  let encodedBytes = 0
  return {
    ...(spec.inlineImageUrls ? { inlineImageUrls: true } : {}),
    async prepareImage(bytes, image) {
      const base64Bytes = 4 * Math.ceil(bytes.length / 3)
      const maxImage = spec.maxImageBytes
      const budget = spec.requestBudget
      const metadata =
        spec.allowedMediaTypes ||
        spec.maxPixelsPerSide ||
        maxImage?.sizeMeasure === "data_uri" ||
        budget?.sizeMeasure === "data_uri"
          ? inspectImageBytes(bytes)
          : undefined
      if (
        metadata &&
        spec.allowedMediaTypes &&
        !spec.allowedMediaTypes.values.includes(metadata.mediaType)
      )
        throw new InvalidImageDataError(spec.allowedMediaTypes.message)
      if (
        metadata &&
        spec.maxPixelsPerSide &&
        Math.max(metadata.width, metadata.height) > spec.maxPixelsPerSide.value
      )
        throw new InvalidImageDataError(spec.maxPixelsPerSide.message)
      const dataUriBytes =
        metadata === undefined
          ? base64Bytes
          : base64Bytes + `data:${metadata.mediaType};base64,`.length
      if (maxImage) {
        const size =
          maxImage.sizeMeasure === "raw"
            ? bytes.length
            : maxImage.sizeMeasure === "data_uri"
              ? dataUriBytes
              : base64Bytes
        if (maxImage.exclusive ? size >= maxImage.bytes : size > maxImage.bytes)
          throw maxImage.invalidImage
            ? new InvalidImageDataError(maxImage.message)
            : new AssetMediaError(maxImage.message)
      }
      if (budget) {
        encodedBytes +=
          budget.sizeMeasure === "data_uri" ? dataUriBytes : base64Bytes
        if (encodedBytes > budget.bytes)
          throw new AssetMediaError(budget.encodedMessage)
      }
      const inspected = metadata ?? inspectImageBytes(bytes)
      if (spec.dimensions && !spec.dimensions.accepts(inspected))
        throw new AssetMediaError(spec.dimensions.message)
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: inspected.mediaType,
        detail: image.detail ?? "high",
        data: bytes.toString("base64"),
      }
    },
    validateBody(body) {
      const budget = spec.requestBudget
      if (
        budget &&
        (!budget.onlyWithImages || count > 0) &&
        jsonRequestByteLength(body, budget.bytes) === undefined
      )
        throw new AssetMediaError(budget.bodyMessage)
    },
  }
}
