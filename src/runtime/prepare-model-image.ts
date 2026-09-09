import type { ImageDetail, ModelImageBlock } from "../kernel/events.ts"
import { inspectImageBytes } from "../kernel/image-metadata.ts"

// Codex's high-detail preparation bounds the longest edge; original preserves it.
const HIGH_DETAIL_MAX_DIMENSION = 2048

export async function prepareModelImage(
  bytes: Buffer,
  detail: ImageDetail,
): Promise<ModelImageBlock> {
  const metadata = inspectImageBytes(bytes)
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
  return {
    type: "image",
    mediaType: "image/png",
    detail,
    data: resized.toString("base64"),
  }
}

export async function imageDecodeError(
  bytes: Buffer,
): Promise<string | undefined> {
  const { default: sharp } = await import("sharp")
  try {
    await sharp(bytes).stats()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
