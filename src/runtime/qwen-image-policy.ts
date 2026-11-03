import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import type { QwenEndpointPolicy } from "./qwen-endpoints.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Qwen OpenAI-compatible image contract, checked 2026-11-03:
// https://docs.bailian.console.aliyun.com/en/model-studio/vision
// Keep original bytes; Qwen owns visual tokenization/resizing, not Codex's
// generic 2048px preparation. No OpenAI detail field is documented by Qwen.
export async function prepareQwenImage(
  bytes: Buffer,
  image: ModelImageBlock,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  const metadata = inspectImageBytes(bytes)
  // Check the encoded URI before decoding or allocating a base64 copy.
  if (
    4 * Math.ceil(bytes.length / 3) +
      `data:${metadata.mediaType};base64,`.length >
    20_000_000
  )
    throw new AssetMediaError(
      "Qwen image was not sent: its data URI exceeds 20 MB. Compress a copy; the original has not been changed.",
    )
  await validateModelImage(bytes, signal)
  const { width, height, mediaType } = metadata
  if (
    width <= 10 ||
    height <= 10 ||
    Math.max(width, height) / Math.min(width, height) > 200
  )
    throw new InvalidImageDataError(
      "Qwen images must be larger than 10 pixels per side and have an aspect ratio at most 200:1. Resize a copy; the original has not been changed.",
    )
  if (
    mediaType === "image/gif" ||
    (mediaType === "image/webp" && width * height >= 3840 * 2160)
  )
    throw new InvalidImageDataError(
      "Qwen does not document this image format/resolution combination. Export a PNG or JPEG copy; the original has not been changed.",
    )
  return {
    type: "image",
    mediaType,
    detail: image.detail ?? "high",
    data: bytes.toString("base64"),
  }
}

export function validateQwenImageRequest(
  body: { messages: readonly ChatCompletionMessageParam[] },
  endpoint: QwenEndpointPolicy,
  model: string,
): void {
  const images = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  )
  if (images.length === 0) return
  const inline = images.filter((image) =>
    image.image_url.url.startsWith("data:"),
  )
  // Mixed requests retain the documented base64 bound. URL-only requests
  // use their exact model's larger allowance without fetching remote pixels.
  const limit =
    inline.length > 0
      ? 250
      : [
            "qwen3.8-max",
            "qwen3.8-max-0902",
            "qwen3.8-flash",
            "qwen3.7-plus",
          ].includes(model)
        ? 2048
        : 256
  if (images.length > limit)
    throw new AssetMediaError(
      `Qwen images were not sent: exceeds the ${limit}-image request bound. Send fewer images; originals have not been changed.`,
    )
  if (
    inline.some(
      (image) => Buffer.byteLength(image.image_url.url, "utf8") > 20_000_000,
    )
  )
    throw new AssetMediaError(
      "Qwen image was not sent: its data URI exceeds 20 MB. Compress a copy; the original has not been changed.",
    )
  // Count final JSON, including text, tools, escaping and base64.
  if (jsonRequestByteLength(body, endpoint.requestBytes) === undefined)
    throw new AssetMediaError(
      `Qwen images were not sent: the complete request exceeds ${endpoint.requestLimit}. Send fewer images or reduce other request content; originals have not been changed.`,
    )
}
