import {
  inspectImageBytes,
  InvalidImageDataError,
} from "../kernel/image-metadata.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// Moonshot recommends up to 4K input. This is Yakitori's preparation target
// for the explicitly selected Kimi model, not an API rejection threshold.
// https://platform.kimi.ai/docs/guide/use-kimi-vision-model
const RECOMMENDED_LONG_EDGE = 4096
const RECOMMENDED_SHORT_EDGE = 2160

export async function prepareKimiImageBytes(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: ModelImageBlock["mediaType"] }> {
  signal?.throwIfAborted()
  const source = inspectImageBytes(bytes)
  const png =
    source.mediaType === "image/png" ? pngProperties(bytes) : undefined
  if (png?.animated)
    throw new InvalidImageDataError(
      "Image was not sent: animated images are not supported by this static Kimi preparation path. Export a static copy and retry; the image is not flattened or sent as video, and the original has not been changed.",
    )
  await validateModelImage(bytes, signal)
  const { default: sharp } = await import("sharp")
  const metadata = await sharp(bytes).metadata()
  signal?.throwIfAborted()
  if ((metadata.pages ?? 1) !== 1)
    throw new InvalidImageDataError(
      "Image was not sent: animated images are not supported by this static Kimi preparation path. Export a static copy and retry; the image is not flattened or sent as video, and the original has not been changed.",
    )
  // Moonshot also accepts single-frame GIF. Do not rewrite its palette or
  // transparency; multi-frame input was rejected before this point.
  if (source.mediaType === "image/gif")
    return { bytes, mediaType: source.mediaType }
  const longEdge = Math.max(metadata.width, metadata.height)
  const shortEdge = Math.min(metadata.width, metadata.height)
  if (longEdge <= RECOMMENDED_LONG_EDGE && shortEdge <= RECOMMENDED_SHORT_EDGE)
    return { bytes, mediaType: source.mediaType }
  if (
    metadata.depth !== "uchar" ||
    metadata.icc !== undefined ||
    png?.colorMetadata ||
    (metadata.space !== "srgb" && metadata.space !== "b-w")
  )
    return { bytes, mediaType: source.mediaType }
  const swapped =
    metadata.orientation !== undefined &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8
  const width = swapped ? metadata.height : metadata.width
  const height = swapped ? metadata.width : metadata.height
  const output = await sharp(bytes)
    .rotate()
    .resize({
      width: width >= height ? RECOMMENDED_LONG_EDGE : RECOMMENDED_SHORT_EDGE,
      height: width >= height ? RECOMMENDED_SHORT_EDGE : RECOMMENDED_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "linear",
    })
    .png({ palette: false })
    .toBuffer()
  signal?.throwIfAborted()
  // 4K is a recommendation, not an admission requirement. A PNG
  // derivative of a JPEG can be substantially larger. Never create a new
  // request-size failure when the original is smaller; let the provider size it.
  return output.length < bytes.length
    ? { bytes: output, mediaType: "image/png" }
    : { bytes, mediaType: source.mediaType }
}

// Some decoders expose APNG as a single page and omit PNG color metadata.
// Inspect chunk identities, never incidental text inside pixel/metadata data.
function pngProperties(bytes: Buffer): {
  animated: boolean
  colorMetadata: boolean
} {
  let offset = 8
  let animated = false
  let colorMetadata = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length)
      throw new InvalidImageDataError(
        "Image was not sent: truncated PNG chunk data.",
      )
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (type === "acTL") animated = true
    if (["gAMA", "cHRM", "sRGB", "cICP", "mDCV", "cLLI", "iCCP"].includes(type))
      colorMetadata = true
    if (type === "IEND") return { animated, colorMetadata }
    offset = end
  }
  throw new InvalidImageDataError(
    "Image was not sent: incomplete PNG chunk data.",
  )
}
