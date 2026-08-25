import type { ImageAttachment } from "./events.ts"

export type ImageMetadata = Readonly<{
  mediaType: ImageAttachment["mediaType"]
  width: number
  height: number
}>

export function inspectImageBytes(bytes: Uint8Array): ImageMetadata {
  const buffer = asBuffer(bytes)
  const mediaType = detectImageMediaType(buffer)
  const dimensions = readImageDimensions(buffer, mediaType)
  if (dimensions === undefined) {
    throw new Error("Image data is truncated or has invalid dimensions.")
  }
  return { mediaType, ...dimensions }
}

export function readImageDimensions(
  bytes: Uint8Array,
  mediaType: ImageAttachment["mediaType"],
): { readonly width: number; readonly height: number } | undefined {
  const buffer = asBuffer(bytes)
  if (
    mediaType === "image/png" &&
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return dimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20))
  }
  if (
    mediaType === "image/gif" &&
    buffer.length >= 10 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" ||
      buffer.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8))
  }
  if (mediaType === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegDimensions(buffer)
  }
  if (mediaType === "image/webp") return readWebpDimensions(buffer)
  return undefined
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function detectImageMediaType(bytes: Buffer): ImageAttachment["mediaType"] {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg"
  }
  const prefix = bytes.subarray(0, 6).toString("ascii")
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif"
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.")
}

function readJpegDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) return undefined
    if (startOfFrameMarkers.has(marker)) {
      return dimensions(
        bytes.readUInt16BE(offset + 7),
        bytes.readUInt16BE(offset + 5),
      )
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segmentLength = bytes.readUInt16BE(offset + 2)
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      return undefined
    }
    offset += segmentLength + 2
  }
  return undefined
}

function readWebpDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (
    bytes.length < 25 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined
  }
  const kind = bytes.toString("ascii", 12, 16)
  if (kind === "VP8X" && bytes.length >= 30) {
    return dimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    return dimensions(
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff,
    )
  }
  if (kind === "VP8L") {
    const packed = bytes.readUInt32LE(21)
    return dimensions((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1)
  }
  return undefined
}

function dimensions(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined
}
