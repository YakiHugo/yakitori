import { createHash } from "node:crypto"
import type { ImageDetail, ModelImageBlock } from "../kernel/events.ts"
import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"

// Local attachment/encoding safety, not a claim about any provider's quota.
// Keep one image within the existing 50 MB attachment snapshot boundary.
const MODEL_IMAGE_SAFETY_BYTES = 50_000_000
// Only fallback re-encoding: at most 64 MiB of 8-bit RGBA pixels in one native
// operation, in addition to bounded source/output buffers. Not a model limit.
const MODEL_IMAGE_CONVERSION_SAFETY_PIXELS = 16 * 1024 * 1024
// Cache only successful validation identities, never image buffers or pixels.
// Bound retained metadata while avoiding a full decode of unchanged history on
// every turn. Failed/cancelled work is not cached.
const VALIDATED_IMAGE_CACHE_ENTRIES = 128
const validatedImages = new Map<string, true>()
let imageDecodeTail = Promise.resolve()

// Compatibility preparation is only used after capability admission. It cannot
// establish whether an unknown model supports vision. Model-specific resizing
// belongs to its verified adapter: a universal 2048px resize loses small text
// and UI coordinates before a higher-resolution model can inspect them.
export async function prepareModelImage(
  bytes: Buffer,
  detail: ImageDetail,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  signal?.throwIfAborted()
  if (bytes.length > MODEL_IMAGE_SAFETY_BYTES)
    throw new InvalidImageDataError(
      "Image was not sent: exceeds Yakitori's 50 MB local compatibility image safety boundary. Export a smaller copy or use a verified provider image policy; the original has not been changed.",
    )
  const metadata = inspectImageBytes(bytes)
  await validateModelImage(bytes, signal)
  const { default: sharp } = await import("sharp")
  const decoded = await sharp(bytes).metadata()
  signal?.throwIfAborted()
  // libvips exposes APNG as one static PNG. Inspect chunks as well as pages so
  // a successful decode never silently authorizes dropping animation frames.
  const pngMetadata =
    metadata.mediaType === "image/png"
      ? pngConversionMetadata(bytes)
      : { animated: false, color: false }
  if ((decoded.pages ?? 1) !== 1 || pngMetadata.animated)
    throw new InvalidImageDataError(
      "Image was not sent: animation handling is not configured for this provider. Export a static frame or use a verified provider image policy; no frames were discarded and the original has not been changed.",
    )
  const oriented = (decoded.orientation ?? 1) !== 1
  if (
    !oriented &&
    (metadata.mediaType === "image/png" || metadata.mediaType === "image/jpeg")
  )
    return {
      type: "image",
      mediaType: metadata.mediaType,
      detail,
      data: bytes.toString("base64"),
    }
  // PNG/JPEG are the narrow compatibility encoding, not evidence that every
  // custom endpoint accepts them. Never add JPEG loss, flatten transparency,
  // upsample small images, crop, or guess a model's visual-token budget.
  // Re-encoding metadata-bearing images can change gamut, gamma or HDR. Only
  // convert ordinary 8-bit sRGB pixels; otherwise ask for an explicit copy.
  if (
    decoded.depth !== "uchar" ||
    (decoded.space !== "srgb" && decoded.space !== "b-w") ||
    decoded.icc !== undefined ||
    decoded.gainMap !== undefined ||
    pngMetadata.color
  )
    throw new InvalidImageDataError(
      "Image was not sent: compatibility conversion would change color metadata or high-bit-depth pixels. Export a correctly oriented static 8-bit sRGB PNG/JPEG copy or use a verified provider image policy; the original has not been changed.",
    )
  if (metadata.width * metadata.height > MODEL_IMAGE_CONVERSION_SAFETY_PIXELS)
    throw new InvalidImageDataError(
      "Image was not sent: compatibility conversion exceeds Yakitori's local 16-megapixel transcoding safety boundary. Export a correctly oriented static PNG/JPEG copy or use a verified provider image policy; the original has not been changed.",
    )
  // Sharp allocates its encoded buffer even when used as a stream. Bound the
  // raster before encoding, serialize native work, then check output bytes
  // before allocating base64. Do not claim streaming avoids that allocation.
  const prepared = await runImageDecoder(
    () => sharp(bytes).rotate().png({ palette: false }).toBuffer(),
    signal,
  )
  signal?.throwIfAborted()
  if (prepared.length > MODEL_IMAGE_SAFETY_BYTES)
    throw new InvalidImageDataError(
      "Image was not sent: lossless compatibility conversion exceeds Yakitori's 50 MB local image safety boundary. Export a smaller static PNG/JPEG copy; the original has not been changed.",
    )
  return {
    type: "image",
    mediaType: "image/png",
    detail,
    data: prepared.toString("base64"),
  }
}

function pngConversionMetadata(bytes: Buffer): {
  animated: boolean
  color: boolean
} {
  let animated = false
  let color = false
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset)
    if (end > bytes.length) break
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (type === "acTL") animated = true
    if (["gAMA", "cHRM", "cICP", "mDCV", "cLLI", "iCCP"].includes(type))
      color = true
    if (type === "IEND" || (animated && color)) break
    offset = end
  }
  return { animated, color }
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
  return runImageDecoder(async () => {
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
  }, signal)
}

async function runImageDecoder<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const validation = imageDecodeTail.then(() => {
    signal?.throwIfAborted()
    return work()
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
