import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Direct DashScope OpenAI-compatible image contract, checked 2026-11-02:
// https://docs.bailian.console.aliyun.com/en/model-studio/vision
// Keep original bytes; Qwen owns visual tokenization/resizing, not Codex's
// generic 2048px preparation. No OpenAI detail field is documented by Qwen.
export async function prepareQwenImage(
  bytes: Buffer,
  image: ModelImageBlock,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  await validateModelImage(bytes, signal)
  const metadata = inspectImageBytes(bytes)
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

export function validateQwenImageRequest(body: {
  messages: readonly ChatCompletionMessageParam[]
}): void {
  const images = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  )
  if (images.length === 0) return
  const inline = images.filter((image) =>
    image.image_url.url.startsWith("data:"),
  )
  // 250 is the documented base64 count. Use it as a conservative local
  // admission bound for mixed/URL requests too, rather than guessing a model.
  if (images.length > 250)
    throw new AssetMediaError(
      "Qwen images were not sent: exceeds Yakitori's conservative 250-image request bound. Send fewer images; originals have not been changed.",
    )
  if (
    inline.some(
      (image) => Buffer.byteLength(image.image_url.url, "utf8") > 20_000_000,
    )
  )
    throw new AssetMediaError(
      "Qwen image was not sent: its data URI exceeds 20 MB. Compress a copy; the original has not been changed.",
    )
  // The currently registered Qwen endpoint is DashScope, not a workspace
  // domain. Count final JSON, including text, tools, escaping and base64.
  if (jsonRequestByteLength(body, 16 * 1024 * 1024) === undefined)
    throw new AssetMediaError(
      "Qwen images were not sent: the complete DashScope request exceeds 16 MiB. Send fewer images or reduce other request content; originals have not been changed.",
    )
}
