import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// MiniMax OpenAI API: 10 MB/image, 64 MB/body. Preserve source pixels;
// detail high delegates visual processing to the service (not OpenAI auto).
// https://platform.minimax.io/docs/api-reference/text-openai-api
// These byte bounds are not context-token bounds. MiniMax publishes only
// rough visual token ranges (high can exceed 15k); the harness's generic
// image estimate can undercount them. Do not invent a local token ceiling
// or silently reduce detail: provider context rejection remains visible.
export function createMiniMaxImagePolicy(request: ModelRequest, model: string) {
  if (
    !["MiniMax-M3", "MiniMax-M3.1-Flash"].includes(model) &&
    request.messages.some(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.some((block) => block.type === "image"),
    )
  )
    throw new AssetMediaError(
      "Image input is only supported for documented MiniMax M3 and M3.1-Flash models.",
    )
  let imageBytes = 0
  return {
    inlineImageUrls: true,
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      if (bytes.length > 10_000_000)
        throw new AssetMediaError(
          "MiniMax image exceeds 10 MB. Resize a copy; the original has not been changed.",
        )
      imageBytes += 4 * Math.ceil(bytes.length / 3)
      if (imageBytes > 64_000_000)
        throw new AssetMediaError(
          "MiniMax request exceeds 64 MB including encoded images.",
        )
      const metadata = inspectImageBytes(bytes)
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
          "MiniMax request exceeds 64 MB including text, tools and encoded images.",
        )
    },
  }
}
