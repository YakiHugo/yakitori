import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// https://docs.x.ai/developers/model-capabilities/images/understanding
// Checked 2026-11-02: JPEG/PNG, 20 MiB/image. Keep source pixels; xAI owns
// tokenization. This is not Codex's 2048px high-detail preparation contract.
export async function prepareGrokImage(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  if (bytes.length > 20 * 1024 * 1024)
    throw new InvalidImageDataError(
      "xAI image exceeds 20 MiB. Export a smaller copy; the original has not been changed.",
    )
  const { mediaType } = inspectImageBytes(bytes)
  if (mediaType !== "image/jpeg" && mediaType !== "image/png")
    throw new InvalidImageDataError(
      "xAI documents JPEG and PNG image inputs only. Export a copy; the original has not been changed.",
    )
  await validateModelImage(bytes, signal)
  return {
    type: "image",
    mediaType,
    detail: "high",
    data: bytes.toString("base64"),
  }
}

// Local allocation/serialization guard, not an xAI quota. Fits one maximum
// 20 MiB image after base64 plus request framing; bounds accumulated history.
export const GROK_IMAGE_REQUEST_SAFETY_BYTES = 32 * 1024 * 1024
export class GrokImageRequestSizeError extends AssetMediaError {
  constructor() {
    super(
      "Request was not sent: exceeds Yakitori's 32 MiB local xAI request budget. Send fewer images or reduce other request content; originals have not been changed.",
    )
  }
}
