import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Direct Meta Model API, checked 2026-11-02:
// https://dev.meta.ai/docs/models
// https://dev.meta.ai/docs/image-understanding
// https://dev.meta.ai/docs/api-reference/chat-completions/schemas
export function isMetaVisionModel(model: string): boolean {
  return model === "muse-spark-1.3" || model === "muse-wonder-1.0"
}

// Local serialization/allocation guard, not a Meta quota. Fits a documented
// maximum 50 MB image after base64 with framing, while bounding image history.
export const META_REQUEST_SAFETY_BYTES = 80 * 1024 * 1024
export class MetaImageRequestSizeError extends AssetMediaError {
  constructor() {
    super(
      "Meta request was not sent: exceeds Yakitori's 80 MiB local request budget. Send fewer images or reduce other request content; originals have not been changed.",
    )
  }
}

export async function prepareMetaImage(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  if (bytes.length > 50_000_000)
    throw new InvalidImageDataError(
      "Meta inline images must be at most 50 MB. Export a smaller copy; the original has not been changed.",
    )
  const { mediaType } = inspectImageBytes(bytes)
  await validateModelImage(bytes, signal)
  // All four locally supported formats are documented by Meta. Do not apply
  // Codex's 2048px resize; image_url.detail=high delegates processing to Meta.
  return {
    type: "image",
    mediaType,
    detail: "high",
    data: bytes.toString("base64"),
  }
}

export function validateMetaImageRequest(body: {
  messages: readonly ChatCompletionMessageParam[]
}): void {
  const images = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  )
  if (images.length > 50)
    throw new AssetMediaError(
      "Meta accepts at most 50 images per request. Send fewer images; originals have not been changed.",
    )
  if (jsonRequestByteLength(body, META_REQUEST_SAFETY_BYTES) === undefined)
    throw new MetaImageRequestSizeError()
}
