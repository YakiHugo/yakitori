import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Codex's standard Responses detail-based preparation, not public API quotas.
// openai/codex @ 2816088b68069dd5ce1f71a653cd956eb367c28e:
// codex-rs/core/src/image_preparation.rs; codex-rs/utils/image/src/lib.rs.
// UnifiedImageBudget/Responses Lite are separate feature-gated transports;
// Yakitori does not negotiate them. Original support is captured from model
// discovery and downgraded by adaptImagesForModel before this wire boundary.
export async function prepareCodexImage(
  bytes: Buffer,
  image: ModelImageBlock,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  const metadata = inspectImageBytes(bytes)
  await validateModelImage(bytes, signal)
  const detail = image.detail ?? "high"
  const maxDimension = detail === "original" ? 6000 : 2048
  const maxPatches = detail === "original" ? 10000 : 2500
  const edgeScale = Math.min(
    1,
    maxDimension / Math.max(metadata.width, metadata.height),
  )
  let width = Math.max(1, Math.round(metadata.width * edgeScale))
  let height = Math.max(1, Math.round(metadata.height * edgeScale))
  if (Math.ceil(width / 32) * Math.ceil(height / 32) > maxPatches) {
    let scale = Math.sqrt((32 * 32 * maxPatches) / (width * height))
    const across = (width * scale) / 32
    const down = (height * scale) / 32
    scale *= Math.min(Math.floor(across) / across, Math.floor(down) / down)
    width = Math.max(1, Math.floor(width * scale))
    height = Math.max(1, Math.floor(height * scale))
  }
  if (
    width === metadata.width &&
    height === metadata.height &&
    metadata.mediaType !== "image/gif"
  )
    return {
      type: "image",
      mediaType: metadata.mediaType,
      detail,
      data: bytes.toString("base64"),
    }
  const { default: sharp } = await import("sharp")
  // Codex converts GIF to a static PNG. Keep the durable animation untouched.
  // Rotate first; transpose the target for EXIF-oriented portrait images.
  const decoded = await sharp(bytes).metadata()
  const transpose = (decoded.orientation ?? 1) >= 5
  let pipeline = sharp(bytes)
    .rotate()
    .resize({
      width: transpose ? height : width,
      height: transpose ? width : height,
      fit: "fill",
      withoutEnlargement: true,
      kernel: "linear",
    })
    .withIccProfile("srgb")
  pipeline =
    metadata.mediaType === "image/jpeg"
      ? pipeline.jpeg({ quality: 85 })
      : metadata.mediaType === "image/webp"
        ? pipeline.webp({ lossless: true })
        : pipeline.png()
  const prepared = await pipeline.toBuffer()
  signal?.throwIfAborted()
  return {
    type: "image",
    mediaType:
      metadata.mediaType === "image/gif" ? "image/png" : metadata.mediaType,
    detail,
    data: prepared.toString("base64"),
  }
}

// Local serialization safety, NOT a Codex endpoint quota. Allows one existing
// 50 MB attachment after base64/framing without accumulating unbounded history.
export const CODEX_IMAGE_REQUEST_SAFETY_BYTES = 80 * 1024 * 1024
export class CodexImageRequestSizeError extends AssetMediaError {
  constructor() {
    super(
      "Request was not sent: exceeds Yakitori's 80 MiB local Codex image request budget. Send fewer images or reduce other request content; originals have not been changed.",
    )
  }
}
export function validateCodexImageRequest(body: unknown): void {
  if (
    jsonRequestByteLength(body, CODEX_IMAGE_REQUEST_SAFETY_BYTES) === undefined
  )
    throw new CodexImageRequestSizeError()
}
