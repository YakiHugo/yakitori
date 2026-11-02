import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Z.AI international API, checked 2026-11-02 (not open.bigmodel.cn):
// https://docs.z.ai/openapi.json — VisionMultimodalContentItem
// https://docs.z.ai/guides/vlm/glm-5.3-flash
// The schema says under 5M/image without specifying raw versus encoded size.
// Conservatively admit only data URIs below 5,000,000 bytes, not 5 MiB/raw.
const IMAGE_DATA_URI_BYTES = 5_000_000
// Local allocation/work bounds, NOT advertised Z.AI service quotas. 32 MB
// bounds encoded history plus tools/text; 150 caps repeated tiny-image work
// and does not exceed the schema's older GLM-5V family image-count guidance.
const REQUEST_SAFETY_BYTES = 32_000_000
const IMAGE_COUNT_SAFETY = 150

export function createGlmImagePolicy(request: ModelRequest) {
  const count = request.messages.reduce(
    (total, message) =>
      total +
      (message.role === "user" || message.role === "tool"
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  )
  if (count > IMAGE_COUNT_SAFETY)
    throw new AssetMediaError(
      "GLM images were not sent: exceeds Yakitori's local 150-image safety bound. Send fewer images; originals have not been changed.",
    )
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      const metadata = inspectImageBytes(bytes)
      if (
        metadata.mediaType !== "image/png" &&
        metadata.mediaType !== "image/jpeg"
      )
        throw new InvalidImageDataError(
          "GLM-5.3-Flash supports PNG and JPEG images. Export a PNG or JPEG copy; the original has not been changed.",
        )
      if (metadata.width > 6000 || metadata.height > 6000)
        throw new InvalidImageDataError(
          "GLM image exceeds 6000 pixels on a side. Resize a copy; the original has not been changed.",
        )
      const size =
        `data:${metadata.mediaType};base64,`.length +
        4 * Math.ceil(bytes.length / 3)
      if (size >= IMAGE_DATA_URI_BYTES)
        throw new InvalidImageDataError(
          "GLM image was not sent: exceeds Yakitori's conservative under-5-MB encoded image admission bound. Compress a copy; the original has not been changed.",
        )
      encodedBytes += size
      if (encodedBytes > REQUEST_SAFETY_BYTES)
        throw new AssetMediaError(
          "GLM images were not sent: encoded images exceed Yakitori's local 32 MB request safety budget. Send fewer images; originals have not been changed.",
        )
      await validateModelImage(bytes, request.signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        detail: image.detail ?? "high",
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: {
      messages: readonly ChatCompletionMessageParam[]
    }): void {
      if (
        count > 0 &&
        jsonRequestByteLength(body, REQUEST_SAFETY_BYTES) === undefined
      )
        throw new AssetMediaError(
          "GLM images were not sent: text, tools and images exceed Yakitori's local 32 MB request safety budget. Reduce request content; originals have not been changed.",
        )
    },
  }
}
