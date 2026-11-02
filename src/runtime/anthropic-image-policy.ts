import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import type { ModelImageBlock, ModelMessage } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// These catalog models use Claude's standard vision tier. Do not automatically
// opt future high-resolution models into a higher visual-token default.
// https://platform.claude.com/docs/en/build-with-claude/vision
const standardVisionModels = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
])
const MAX_BASE64_BYTES = 10_000_000

export function isStandardAnthropicImageModel(model: string): boolean {
  return standardVisionModels.has(model)
}

export function anthropicImageCount(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      (message.role === "user" || message.role === "tool"
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  )
}

// Preserve source encoding, transparency, orientation and first-frame semantics;
// let the native service perform its one model-specific resize. Necessary
// bounded conversion uses this model tier, never a cross-provider size policy.
export async function prepareAnthropicImage(
  bytes: Buffer,
  image: ModelImageBlock,
  imageCount: number,
  signal?: AbortSignal,
  preferSmaller = false,
  allowStandardResize = true,
): Promise<ModelImageBlock> {
  await validateModelImage(bytes, signal)
  const metadata = inspectImageBytes(bytes)
  const maxDimension = imageCount > 20 ? 3000 : 8000
  if (
    Math.max(metadata.width, metadata.height) <= maxDimension &&
    4 * Math.ceil(bytes.length / 3) <= MAX_BASE64_BYTES
  ) {
    const original: ModelImageBlock = {
      type: "image",
      mediaType: metadata.mediaType,
      detail: image.detail ?? "high",
      data: bytes.toString("base64"),
    }
    if (preferSmaller && allowStandardResize) {
      const smaller = await prepareStandardTierImage(bytes, signal)
      if (
        smaller?.data !== undefined &&
        smaller.data.length < original.data.length
      )
        return smaller
    }
    return original
  }
  if (!allowStandardResize)
    throw new InvalidImageDataError(
      `Image was not sent: exceeds the direct Claude image admission bounds used by Yakitori (${maxDimension} pixels per side${imageCount > 20 ? ", conservatively for many-image requests," : ""} and 10 MB base64). Automatic resizing is not configured for this model. Resize or compress a copy and retry; the original has not been changed.`,
    )
  const prepared = await prepareStandardTierImage(bytes, signal)
  if (prepared === undefined)
    throw new InvalidImageDataError(
      "Image was not sent: it exceeds Claude image limits and automatic conversion is not enabled for animated, high-bit-depth, or color-metadata-bearing images. Export a static 8-bit sRGB copy and retry; the original has not been changed.",
    )
  if (prepared.data === undefined || prepared.data.length > MAX_BASE64_BYTES)
    throw new InvalidImageDataError(
      "Image was not sent: it exceeds the Claude API's 10 MB base64 image limit even after bounded preparation. Resize or compress a copy and retry; the original has not been changed.",
    )
  return prepared
}

// Largest aspect-preserving dimensions fitting Claude's documented standard
// tier. The limits apply to padded 28px patches, not just the longest edge.
// https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
export function anthropicStandardImageSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const fits = (w: number, h: number) =>
    Math.ceil(w / 28) * 28 <= 1568 &&
    Math.ceil(h / 28) * 28 <= 1568 &&
    Math.ceil(w / 28) * Math.ceil(h / 28) <= 1568
  if (fits(width, height)) return { width, height }
  if (height > width) {
    const rotated = anthropicStandardImageSize(height, width)
    return { width: rotated.height, height: rotated.width }
  }
  const ratio = width / height
  let low = 1
  let high = width
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle, Math.max(1, Math.round(middle / ratio)))) low = middle
    else high = middle
  }
  return { width: low, height: Math.max(1, Math.round(low / ratio)) }
}

async function prepareStandardTierImage(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ModelImageBlock | undefined> {
  signal?.throwIfAborted()
  const { default: sharp } = await import("sharp")
  const metadata = await sharp(bytes).metadata()
  signal?.throwIfAborted()
  if (
    metadata.depth !== "uchar" ||
    (metadata.pages ?? 1) !== 1 ||
    metadata.icc !== undefined ||
    (metadata.format === "png" && hasPngConversionMetadata(bytes)) ||
    (metadata.space !== "srgb" && metadata.space !== "b-w")
  )
    return undefined
  const swapped =
    metadata.orientation !== undefined &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8
  const size = anthropicStandardImageSize(
    swapped ? metadata.height : metadata.width,
    swapped ? metadata.width : metadata.height,
  )
  const converted = await sharp(bytes)
    .rotate()
    .resize({
      ...size,
      fit: "fill",
      withoutEnlargement: true,
      kernel: "linear",
    })
    .png({ palette: false })
    .toBuffer()
  signal?.throwIfAborted()
  return {
    type: "image",
    mediaType: "image/png",
    detail: "high",
    data: converted.toString("base64"),
  }
}

// libvips may expose APNG as static and omit PNG gamma/HDR metadata on output.
// Inspect real chunk types (not payload text) rather than silently flattening
// animation or changing color interpretation during conversion.
function hasPngConversionMetadata(bytes: Buffer): boolean {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (["acTL", "gAMA", "cHRM", "cICP", "mDCV", "cLLI", "iCCP"].includes(type))
      return true
    if (type === "IEND") return false
    offset = end
  }
  return false
}
