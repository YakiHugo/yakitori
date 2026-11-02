import { createHash } from "node:crypto"
import type { ImageDetail, ModelImageBlock } from "../kernel/events.ts"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"

// Codex's high-detail preparation bounds the longest edge; original preserves it.
const HIGH_DETAIL_MAX_DIMENSION = 2048
// Cache only successful validation identities, never image buffers or pixels.
// Bound retained metadata while avoiding a full decode of unchanged history on
// every turn. Failed/cancelled work is not cached.
const VALIDATED_IMAGE_CACHE_ENTRIES = 128
const validatedImages = new Map<string, true>()
let imageDecodeTail = Promise.resolve()

export async function prepareModelImage(
  bytes: Buffer,
  detail: ImageDetail,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  const metadata = inspectImageBytes(bytes)
  await validateModelImage(bytes, signal)
  if (
    detail === "original" ||
    Math.max(metadata.width, metadata.height) <= HIGH_DETAIL_MAX_DIMENSION
  ) {
    return {
      type: "image",
      mediaType: metadata.mediaType,
      detail,
      data: bytes.toString("base64"),
    }
  }
  const { default: sharp } = await import("sharp")
  const resized = await sharp(bytes)
    .rotate()
    .resize({
      width: HIGH_DETAIL_MAX_DIMENSION,
      height: HIGH_DETAIL_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "linear",
    })
    .png()
    .toBuffer()
  signal?.throwIfAborted()
  return {
    type: "image",
    mediaType: "image/png",
    detail,
    data: resized.toString("base64"),
  }
}

// Metadata alone does not prove that compressed pixels can be decoded. Validate
// the frame used for static vision input without re-encoding the stored bytes.
// Sharp's default input-pixel safety limit also applies to passthrough images.
export async function validateModelImage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  inspectImageBytes(bytes)
  const error = await imageDecodeError(
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    signal,
  )
  if (error !== undefined)
    throw new InvalidImageDataError(
      error === "Input image exceeds pixel limit"
        ? "Image was not sent: exceeds the local image decoder's pixel safety limit. Resize a copy and retry; the original has not been changed."
        : `Image was not sent: unable to decode image. ${error}`,
    )
}

export async function imageDecodeError(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  const key = createHash("sha256").update(bytes).digest("hex")
  if (validatedImages.has(key)) return undefined
  const { default: sharp } = await import("sharp")
  // A burst of attachments must not decode many large rasters concurrently.
  // Keep only one validation decoder active; callers own their existing bytes.
  const validation = imageDecodeTail.then(async () => {
    signal?.throwIfAborted()
    if (validatedImages.has(key)) return undefined
    let error: string | undefined
    try {
      await sharp(bytes).stats()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    signal?.throwIfAborted()
    if (error !== undefined) return error
    if (validatedImages.size >= VALIDATED_IMAGE_CACHE_ENTRIES) {
      const oldest = validatedImages.keys().next().value
      if (oldest !== undefined) validatedImages.delete(oldest)
    }
    validatedImages.set(key, true)
    return undefined
  })
  // A cancelled caller can stop waiting immediately, but the next decoder must
  // still wait for native work already in flight to settle.
  imageDecodeTail = validation.then(
    () => {},
    () => {},
  )
  if (signal === undefined) return validation
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([validation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
