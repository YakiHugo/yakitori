import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelMessage, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// https://api-docs.deepseek.com/guides/vision/ (checked 2026-11-02).
// This policy is for the documented Flash model at the direct Chat endpoint;
// a relay or another model must not inherit these limits from its account label.
const REQUEST_BYTES = 48 * 1024 * 1024
const IMAGE_BYTES = 32 * 1024 * 1024

export function deepseekImagePolicy(
  baseURL: string,
  model: string,
  request: ModelRequest,
) {
  if (
    URL.parse(baseURL)?.href.replace(/\/$/, "") !==
      "https://api.deepseek.com" ||
    model !== "deepseek-flash"
  )
    return undefined
  const images = request.messages.flatMap((message) =>
    message.role === "user" || message.role === "tool"
      ? message.content.flatMap((block) =>
          block.type === "image" ? [block] : [],
        )
      : [],
  )
  if (images.length === 0) return undefined
  if (images.length > 600)
    throw new AssetMediaError(
      "Images were not sent: DeepSeek supports at most 600 images per request. Send fewer images; originals have not been changed.",
    )
  const maxDimension = images.length >= 15 ? 4096 : 8192
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      if (bytes.length > IMAGE_BYTES)
        throw new AssetMediaError(
          "Image was not sent: DeepSeek inline images must not exceed 32 MiB. Attach a smaller copy; the original has not been changed.",
        )
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > REQUEST_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      if (Math.max(metadata.width, metadata.height) > maxDimension)
        throw new AssetMediaError(
          `Image was not sent: DeepSeek allows at most ${maxDimension} pixels per side for this ${images.length}-image request. Resize a copy or send fewer images; the original has not been changed.`,
        )
      await validateModelImage(bytes, request.signal)
      // DeepSeek high is equivalent to original. Keep source bytes, including
      // screenshots larger than the generic 2048px preparation boundary.
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
        detail: image.detail ?? "high",
      }
    },
    validateBody(body: unknown, messages: readonly ModelMessage[]) {
      // Check resolved storage URLs too, not only URLs in the input history.
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "tool") continue
        for (const image of message.content) {
          if (image.type !== "image" || image.data !== undefined) continue
          if ("url" in image.file && image.file.url.length > 8192)
            throw new AssetMediaError(
              "Image was not sent: DeepSeek image URLs must not exceed 8192 characters. Attach a local copy instead; the original has not been changed.",
            )
        }
      }
      if (jsonRequestByteLength(body, REQUEST_BYTES) === undefined)
        throw requestSizeError()
    },
  }
}

function requestSizeError() {
  return new AssetMediaError(
    "Images were not sent: DeepSeek's complete request exceeds 48 MiB, including base64, text and tools. Send fewer or smaller images or shorten the conversation; originals have not been changed.",
  )
}
