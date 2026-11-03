import { restrictChatOnlyModel } from "./chat-only-model-policy.ts"
import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import type { EffectiveModel } from "./effective-model.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export const longcatVisionModel = "LongCat-2.5"

export function isLongCatEndpoint(baseURL: string): boolean {
  return (
    URL.parse(baseURL)?.href.replace(/\/$/, "") ===
    "https://api.longcat.chat/openai/v1"
  )
}

// Chat documents system messages and inline images, but not tool calls.
// Responses documents tools but requires public image URLs. Do not transfer
// capabilities across protocols or upload private images to bridge the gap.
// https://longcat.chat/platform/docs/api/chat
// https://longcat.chat/platform/docs/api/responses
export function restrictLongCatVision(model: EffectiveModel): EffectiveModel {
  return restrictChatOnlyModel(
    model,
    model.model === longcatVisionModel ? ["text", "image"] : ["text"],
  )
}

// Official image limits, checked 2026-11-03:
// https://longcat.chat/platform/docs/image-video-understanding
// The provider publishes no numeric request-body cap. 32 MB is a LOCAL
// allocation guard for encoded images plus the remaining JSON, not its quota.
const REQUEST_SAFETY_BYTES = 32_000_000

export function createLongCatImagePolicy(request: ModelRequest) {
  const count = request.messages.reduce(
    (total, message) =>
      total +
      (message.role === "user" || message.role === "tool"
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  )
  if (count === 0) return undefined
  if (count > 50)
    throw new AssetMediaError(
      "LongCat supports at most 50 images per request, including history. Send fewer images; originals have not been changed.",
    )
  let encodedBytes = 0
  return {
    async prepareImage(bytes: Buffer): Promise<ModelImageBlock> {
      if (bytes.length > 10_000_000)
        throw new AssetMediaError(
          "LongCat image exceeds 10 MB. Export a smaller copy; the original has not been changed.",
        )
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > REQUEST_SAFETY_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      if (
        Math.max(metadata.width, metadata.height) >
        200 * Math.min(metadata.width, metadata.height)
      )
        throw new AssetMediaError(
          "LongCat image aspect ratio exceeds 200:1. Export a suitable copy; the original has not been changed.",
        )
      await validateModelImage(bytes, request.signal)
      // PNG/JPEG/WebP/GIF retain their exact bytes. GIF frame interpretation
      // is provider-owned; this adapter does not flatten or claim video input.
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: unknown): void {
      if (jsonRequestByteLength(body, REQUEST_SAFETY_BYTES) === undefined)
        throw requestSizeError()
    },
  }
}

function requestSizeError() {
  return new AssetMediaError(
    "LongCat images were not sent: encoded images and text exceed Yakitori's local 32 MB request safety budget (not a published LongCat quota). Send fewer images or shorten other content; originals have not been changed.",
  )
}
