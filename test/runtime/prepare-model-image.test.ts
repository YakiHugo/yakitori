import { crc32 } from "node:zlib"
import { pngImageBase64 } from "../fixtures/images.ts"
import { expect, it } from "vitest"
import sharp from "sharp"
import { prepareModelImage } from "../../src/runtime/prepare-model-image.ts"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"

it("fits high detail to 2048 pixels without cropping and preserves original detail", async () => {
  const bytes = await sharp({
    create: { width: 4096, height: 1024, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  const high = await prepareModelImage(bytes, "high")
  if (high.data === undefined) throw new Error("Missing prepared image")
  expect(inspectImageBytes(Buffer.from(high.data, "base64"))).toMatchObject({
    width: 2048,
    height: 512,
  })
  const original = await prepareModelImage(bytes, "original")
  expect(original.data).toBe(bytes.toString("base64"))
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

it("preserves transparent pixels, EXIF bytes and animated GIF bytes on validated passthrough", async () => {
  const transparent = await sharp({
    create: {
      width: 32,
      height: 16,
      channels: 4,
      background: { r: 50, g: 80, b: 90, alpha: 0.25 },
    },
  })
    .png()
    .toBuffer()
  const oriented = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const gif = await sharp(Buffer.alloc(32 * 32 * 3, 80), {
    raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
  })
    .gif({ delay: [100, 200] })
    .toBuffer()
  for (const bytes of [transparent, oriented, gif]) {
    expect((await prepareModelImage(bytes, "high")).data).toBe(
      bytes.toString("base64"),
    )
  }
})

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
