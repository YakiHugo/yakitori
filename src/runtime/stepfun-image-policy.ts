import {
  InvalidImageDataError,
  inspectImageBytes,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock, ModelRequest } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Current Step 5 contract, checked 2026-11-02:
// https://platform.stepfun.ai/docs/en/guides/models/step-5-preview
// https://platform.stepfun.ai/docs/en/guides/developer/image-chat
// Step 5 documents 60 images, static GIF, and high/low (not original).
// It does not publish image/body byte quotas. Bound encoded history + text +
// tools at 32 MB as a LOCAL allocation safety policy, not a provider limit.
const REQUEST_SAFETY_BYTES = 32_000_000

export function isStepfunEndpoint(baseURL: string): boolean {
  return ["https://api.stepfun.com/v1", "https://api.stepfun.ai/v1"].includes(
    URL.parse(baseURL)?.href.replace(/\/$/, "") ?? "",
  )
}

export function createStepfunImagePolicy(request: ModelRequest, model: string) {
  const count = request.messages.reduce(
    (total, message) =>
      total +
      (message.role === "user" || message.role === "tool"
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  )
  if (count === 0) return undefined
  if (model !== "step-5-preview")
    throw new AssetMediaError(
      "StepFun images were not sent: this adapter supports image input only for the documented step-5-preview model. Select that model; originals have not been changed.",
    )
  if (count > 60)
    throw new AssetMediaError(
      "StepFun images were not sent: Step 5 Preview supports at most 60 images per request. Send fewer images; originals have not been changed.",
    )
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > REQUEST_SAFETY_BYTES) throw requestSizeError()
      const metadata = inspectImageBytes(bytes)
      await validateModelImage(bytes, request.signal)
      if (metadata.mediaType === "image/gif") {
        request.signal?.throwIfAborted()
        const { default: sharp } = await import("sharp")
        const gif = await sharp(bytes).metadata()
        request.signal?.throwIfAborted()
        if ((gif.pages ?? 1) !== 1)
          throw new InvalidImageDataError(
            "Step 5 Preview accepts static GIF only. Export a static image copy; the animation was not flattened and the original has not been changed.",
          )
      }
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
    "StepFun images were not sent: encoded images, text and tools exceed Yakitori's local 32 MB request safety budget (not a published StepFun quota). Send fewer images or reduce other content; originals have not been changed.",
  )
}
