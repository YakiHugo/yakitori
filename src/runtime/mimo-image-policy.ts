import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Official image and Chat contracts, checked 2026-11-02:
// https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding
// https://mimo.mi.com/docs/en-US/api/chat/openai-api
// 50 MB applies to each base64 string, not raw image bytes. URLs are fetched and
// checked by MiMo. Image count is context-limited, not a fixed vendor quota.
const IMAGE_BASE64_BYTES = 50_000_000
// Local allocation safety boundary: accommodates one maximum-size inline image
// while bounding encoded history, UTF-8 text and tools. NOT a MiMo body quota.
const REQUEST_SAFETY_BYTES = 64_000_000

export function isMimoVisionModel(model: string): boolean {
  return [
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro-ultraspeed",
  ].includes(model)
}

export function isMimoEndpoint(baseURL: string): boolean {
  return (
    URL.parse(baseURL)?.href.replace(/\/$/, "") ===
    "https://api.xiaomimimo.com/v1"
  )
}

export function createMimoImagePolicy(request: ModelRequest, model: string) {
  const hasImages = request.messages.some(
    (message) =>
      (message.role === "user" || message.role === "tool") &&
      message.content.some((block) => block.type === "image"),
  )
  if (!hasImages) return undefined
  if (!isMimoVisionModel(model))
    throw new AssetMediaError(
      "MiMo images were not sent: select a documented MiMo V2.6 vision model. Unknown and retired models are not assumed compatible; originals have not been changed.",
    )
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      const size = 4 * Math.ceil(bytes.length / 3)
      if (size > IMAGE_BASE64_BYTES)
        throw new AssetMediaError(
          "MiMo image was not sent: its base64 string exceeds 50 MB. Compress a copy; the original has not been changed.",
        )
      encodedBytes += size
      if (encodedBytes > REQUEST_SAFETY_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
        detail: image.detail ?? "high",
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
    "MiMo images were not sent: images, text and tools exceed Yakitori's local 64 MB request safety budget (not a published MiMo quota). Send fewer images or reduce content; originals have not been changed.",
  )
}
