import { crc32 } from "node:zlib"
import { pngImageBase64 } from "../fixtures/images.ts"
import { expect, it } from "vitest"
import sharp from "sharp"
import { prepareModelImage } from "../../src/runtime/prepare-model-image.ts"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"

it.each([
  "high",
  "original",
] as const)("preserves the complete raster for %s detail without guessing a model budget", async (detail) => {
  const bytes = await sharp({
    create: { width: 4096, height: 1024, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  const prepared = await prepareModelImage(bytes, detail)
  expect(prepared.data).toBe(bytes.toString("base64"))
})

it.each([
  "high",
  "original",
] as const)("rejects corrupt pixel data even when %s detail would preserve the original bytes", async (detail) => {
  const valid = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  // A valid signature and dimensions are not a decodable image.
  const corrupt = valid.subarray(0, 24)
  expect(inspectImageBytes(corrupt)).toMatchObject({ width: 100, height: 100 })
  await prepareModelImage(valid, detail)
  await expect(prepareModelImage(corrupt, detail)).rejects.toThrow(
    "Image was not sent: unable to decode image",
  )
  expect((await prepareModelImage(valid, detail)).data).toBe(
    valid.toString("base64"),
  )
})

it.each([
  "png",
  "jpeg",
] as const)("does not enlarge or recompress ordinary %s images", async (format) => {
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "red" },
  })
    .toFormat(format)
    .toBuffer()
  const before = Buffer.from(bytes)
  const prepared = await prepareModelImage(bytes, "high")
  expect(prepared).toMatchObject({
    mediaType: `image/${format}`,
    data: bytes.toString("base64"),
  })
  expect(bytes).toEqual(before)
})

it.each([
  "gif",
  "webp",
] as const)("converts static %s to PNG without dropping alpha or changing dimensions", async (format) => {
  const bytes = await sharp({
    create: {
      width: 32,
      height: 16,
      channels: 4,
      background: { r: 50, g: 80, b: 90, alpha: 0 },
    },
  })
    .toFormat(format)
    .toBuffer()
  const before = Buffer.from(bytes)
  const prepared = await prepareModelImage(bytes, "original")
  expect(prepared).toMatchObject({ mediaType: "image/png", detail: "original" })
  const output = Buffer.from(prepared.data ?? "", "base64")
  expect(await sharp(output).metadata()).toMatchObject({
    width: 32,
    height: 16,
    hasAlpha: true,
  })
  expect(await sharp(output).raw().toBuffer()).toEqual(
    await sharp(bytes).raw().toBuffer(),
  )
  expect(bytes).toEqual(before)
})

it.each([
  "gif",
  "webp",
] as const)("rejects animated %s rather than silently sending its first frame", async (format) => {
  const bytes = await sharp(
    Buffer.concat([
      Buffer.alloc(32 * 16 * 3, 80),
      Buffer.alloc(32 * 16 * 3, 180),
    ]),
    {
      raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
    },
  )
    .toFormat(format, { delay: [100, 200] })
    .toBuffer()
  expect((await sharp(bytes).metadata()).pages).toBe(2)
  const before = Buffer.from(bytes)
  await expect(prepareModelImage(bytes, "high")).rejects.toThrow(
    "no frames were discarded",
  )
  expect(bytes).toEqual(before)
})

it("detects PNG animation that the decoder exposes as a static frame", async () => {
  const { deflateSync } = await import("node:zlib")
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(2)
  const frame = (sequence: number) => {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(sequence, 0)
    data.writeUInt32BE(1, 4)
    data.writeUInt32BE(1, 8)
    data.writeUInt16BE(1, 20)
    data.writeUInt16BE(10, 22)
    return data
  }
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", frame(0)),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("fcTL", frame(1)),
    pngChunk(
      "fdAT",
      Buffer.concat([
        Buffer.from([0, 0, 0, 2]),
        deflateSync(Buffer.from([0, 0, 0, 255, 255])),
      ]),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
  expect((await sharp(bytes).metadata()).pages).toBeUndefined()
  await expect(prepareModelImage(bytes, "high")).rejects.toThrow(
    "no frames were discarded",
  )
})

it("applies plain EXIF rotation to the sending copy without resizing or changing pixels", async () => {
  // Two pixels, red then blue, should be red above blue after orientation 6.
  const profiled = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
    raw: { width: 2, height: 1, channels: 3 },
  })
    .png()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const bytes = removePngChunk(profiled, "iCCP")
  expect((await sharp(bytes).metadata()).orientation).toBe(6)
  const before = Buffer.from(bytes)
  const prepared = await prepareModelImage(bytes, "original")
  const output = Buffer.from(prepared.data ?? "", "base64")
  expect(await sharp(output).metadata()).toMatchObject({ width: 1, height: 2 })
  expect((await sharp(output).metadata()).orientation).toBeUndefined()
  expect(await sharp(output).removeAlpha().raw().toBuffer()).toEqual(
    Buffer.from([255, 0, 0, 0, 0, 255]),
  )
  expect(bytes).toEqual(before)
})

it("preserves color profiles when no conversion is needed and refuses speculative color conversion", async () => {
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "red" },
  })
    .png()
    .withIccProfile("p3")
    .toBuffer()
  expect((await prepareModelImage(bytes, "high")).data).toBe(
    bytes.toString("base64"),
  )
  const webp = await sharp(bytes)
    .keepIccProfile()
    .webp({ lossless: true })
    .toBuffer()
  const before = Buffer.from(webp)
  await expect(prepareModelImage(webp, "high")).rejects.toThrow(
    "color metadata or high-bit-depth",
  )
  expect(webp).toEqual(before)
})

it("does not silently discard PNG gamma while normalizing orientation", async () => {
  const source = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "red" },
  })
    .png()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const unprofiled = removePngChunk(source, "iCCP")
  const gamma = Buffer.alloc(4)
  gamma.writeUInt32BE(100000)
  const bytes = Buffer.concat([
    unprofiled.subarray(0, 33),
    pngChunk("gAMA", gamma),
    unprofiled.subarray(33),
  ])
  await expect(prepareModelImage(bytes, "high")).rejects.toThrow(
    "color metadata or high-bit-depth",
  )
})

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, "ascii")
  data.copy(chunk, 8)
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  )
  return chunk
}

function removePngChunk(bytes: Buffer, excluded: string): Buffer {
  const parts = [bytes.subarray(0, 8)]
  let offset = 8
  while (offset < bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset)
    if (bytes.toString("ascii", offset + 4, offset + 8) !== excluded)
      parts.push(bytes.subarray(offset, end))
    offset = end
  }
  return Buffer.concat(parts)
}

it("does not prepare an image after cancellation, including an already validated image", async () => {
  const bytes = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer()
  await prepareModelImage(bytes, "high")
  const controller = new AbortController()
  controller.abort(new Error("Cancelled image preparation"))
  await expect(
    prepareModelImage(bytes, "high", controller.signal),
  ).rejects.toThrow("Cancelled image preparation")
})

it("rejects an oversized raster at the existing decoder safety boundary without changing the source", async () => {
  const bytes = Buffer.from(pngImageBase64, "base64")
  bytes.writeUInt32BE(20_000, 16)
  bytes.writeUInt32BE(20_000, 20)
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29)
  const original = Buffer.from(bytes)
  await expect(prepareModelImage(bytes, "original")).rejects.toThrow(
    "local image decoder's pixel safety limit",
  )
  expect(bytes).toEqual(original)
})

it("rejects oversized source encoding before attempting a decode", async () => {
  await expect(
    prepareModelImage(Buffer.alloc(50_000_001), "original"),
  ).rejects.toThrow("50 MB local compatibility image safety boundary")
})

it("bounds fallback transcoding pixels without silently shrinking a large source", async () => {
  const bytes = await sharp({
    create: { width: 4097, height: 4096, channels: 3, background: "red" },
  })
    .webp({ lossless: true })
    .toBuffer()
  const before = Buffer.from(bytes)
  await expect(prepareModelImage(bytes, "original")).rejects.toThrow(
    "16-megapixel transcoding safety boundary",
  )
  expect(bytes).toEqual(before)
})

it("preserves high-bit-depth PNG bytes when no conversion is necessary", async () => {
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "red" },
  })
    .toColourspace("rgb16")
    .png()
    .toBuffer()
  expect((await sharp(bytes).metadata()).depth).toBe("ushort")
  expect((await prepareModelImage(bytes, "high")).data).toBe(
    bytes.toString("base64"),
  )
})
