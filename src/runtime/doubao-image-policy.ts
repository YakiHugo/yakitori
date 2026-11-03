import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { isDoubaoVisionModel } from "./doubao-models.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export function createDoubaoImagePolicy(request: ModelRequest, model: string) {
  if (
    !isDoubaoVisionModel(model) &&
    request.messages.some(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.some((block) => block.type === "image"),
    )
  )
    throw new AssetMediaError(
      "Doubao image input is only supported for the documented Seed Evolving, 2.1 Pro and 2.1 Turbo models.",
    )
  let imageBytes = 0
  return {
    // Remote image URLs stay provider-owned; do not fetch them locally.
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      // Ark base64 contract, checked 2026-11-02:
      // https://docs.volcengine.com/docs/ark/image-understanding?lang=zh
      // Preserve originals: Ark owns visual resizing/tokenization.
      if (bytes.length >= 10_000_000)
        throw new AssetMediaError(
          "Doubao image must be smaller than 10 MB. Resize a copy; the original has not been changed.",
        )
      imageBytes += 4 * Math.ceil(bytes.length / 3)
      if (imageBytes > 64_000_000)
        throw new AssetMediaError(
          "Doubao request exceeds 64 MB including encoded images.",
        )
      const metadata = inspectImageBytes(bytes)
      if (
        metadata.width <= 14 ||
        metadata.height <= 14 ||
        metadata.width * metadata.height > 36_000_000 ||
        Math.max(metadata.width, metadata.height) /
          Math.min(metadata.width, metadata.height) >
          150
      )
        throw new AssetMediaError(
          "Doubao images require sides above 14 pixels, at most 36 million pixels and aspect ratio at most 150:1. Resize a copy; the original has not been changed.",
        )
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        detail: image.detail ?? "high",
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: unknown): void {
      if (jsonRequestByteLength(body, 64_000_000) === undefined)
        throw new AssetMediaError(
          "Doubao request exceeds 64 MB including text, tools and encoded images.",
        )
    },
  }
}
