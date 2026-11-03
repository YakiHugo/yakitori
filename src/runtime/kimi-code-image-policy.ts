import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Current Node CLI's all-ingestion client policy, NOT an API admission limit.
// The separate 256 KiB ReadMediaFile budget must not apply to attachments.
// https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html#image
const MAX_EDGE = 2000

export async function prepareKimiCodeImage(
  bytes: Buffer,
  image: ModelImageBlock,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  await validateModelImage(bytes, signal)
  const dimensions = inspectImageBytes(bytes)
  if (Math.max(dimensions.width, dimensions.height) <= MAX_EDGE)
    return {
      type: "image",
      mediaType: dimensions.mediaType,
      detail: image.detail ?? "high",
      data: bytes.toString("base64"),
    }

  const { default: sharp } = await import("sharp")
  const metadata = await sharp(bytes).metadata()
  signal?.throwIfAborted()
  // This is a local conversion guarantee, not a claim that the endpoint accepts
  // arbitrary animation/color formats. Never silently replace them with frame 1
  // or strip their color interpretation merely to satisfy a client size policy.
  if (
    (metadata.pages ?? 1) !== 1 ||
    metadata.depth !== "uchar" ||
    metadata.icc !== undefined ||
    (metadata.space !== "srgb" && metadata.space !== "b-w") ||
    (metadata.format === "png" && hasUnsafePngMetadata(bytes))
  )
    throw new InvalidImageDataError(
      "Image was not sent: Kimi Code's client preparation would resize this image, but automatic conversion could discard animation, high-bit-depth pixels, or color metadata. Export a static 8-bit sRGB copy at most 2000 pixels per side and retry; the original has not been changed.",
    )

  // PNG preserves alpha without introducing another lossy encoding. It is not
  // a byte-budget optimization; no unverified API byte cap is inferred here.
  const resized = await sharp(bytes)
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "linear",
    })
    .png({ palette: false })
    .toBuffer()
  signal?.throwIfAborted()
  return {
    type: "image",
    mediaType: "image/png",
    detail: image.detail ?? "high",
    data: resized.toString("base64"),
  }
}

// libvips may report APNG as a single page. Inspect chunk types, not payload
// strings, and preserve gamma/HDR interpretation by refusing this conversion.
function hasUnsafePngMetadata(bytes: Buffer): boolean {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > bytes.length) return false
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (["acTL", "gAMA", "cHRM", "cICP", "mDCV", "cLLI", "iCCP"].includes(type))
      return true
    if (type === "IEND") return false
    offset = end
  }
  return false
}
