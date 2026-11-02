import { crc32 } from "node:zlib"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { InvalidImageDataError } from "../../src/kernel/image-metadata.ts"
import { prepareKimiImageBytes } from "../../src/runtime/kimi-image-policy.ts"

function png(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 30, g: 70, b: 90, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}

function addPngChunk(source: Buffer, type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, "ascii")
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)])
}

describe("Kimi static image preparation", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("preserves eligible %s bytes rather than transcoding", async (format) => {
    const bytes = await sharp(await png(2400, 1200))
      [format]()
      .toBuffer()
    const before = Buffer.from(bytes)
    const result = await prepareKimiImageBytes(bytes)
    expect(result.bytes).toBe(bytes)
    expect(result.mediaType).toBe(`image/${format}`)
    expect(bytes).toEqual(before)
  })

  it.each([
    [4096, 2160],
    [2160, 4096],
    [12, 9],
  ] as const)("preserves %i × %i at the recommendation boundary without enlargement", async (width, height) => {
    const bytes = await png(width, height)
    expect((await prepareKimiImageBytes(bytes)).bytes).toBe(bytes)
  })

  it.each([
    [6000, 1500, 4096, 1024],
    [3000, 2500, 2592, 2160],
    [2500, 3000, 2160, 2592],
  ] as const)("fits %i × %i to %i × %i without changing the source or alpha", async (width, height, outputWidth, outputHeight) => {
    // Trailing transport padding leaves pixels unchanged and ensures this
    // fixture exercises a genuinely smaller derivative, not mandatory 4K.
    const bytes = Buffer.concat([
      await png(width, height),
      Buffer.alloc(100_000),
    ])
    const before = Buffer.from(bytes)
    const result = await prepareKimiImageBytes(bytes)
    expect(result.mediaType).toBe("image/png")
    expect(result.bytes.length).toBeLessThan(bytes.length)
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      width: outputWidth,
      height: outputHeight,
      depth: "uchar",
      hasAlpha: true,
    })
    const alpha = await sharp(result.bytes)
      .extractChannel("alpha")
      .raw()
      .toBuffer()
    expect(new Set(alpha)).toEqual(new Set([128]))
    expect(bytes).toEqual(before)
  })

  it("honors EXIF orientation when resizing without retaining a stale orientation tag", async () => {
    const jpeg = await sharp(await png(6000, 1500))
      .flatten()
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withIccProfile("srgb", { attach: false })
      .toBuffer()
    // Exercise EXIF conversion only when the derivative reduces wire bytes.
    const bytes = Buffer.concat([jpeg, Buffer.alloc(100_000)])
    const original = Buffer.from(bytes)
    const result = await prepareKimiImageBytes(bytes)
    const metadata = await sharp(result.bytes).metadata()
    expect(result.bytes.length).toBeLessThan(bytes.length)
    expect([metadata.width, metadata.height]).toEqual([1024, 4096])
    expect(metadata.orientation).toBeUndefined()
    expect(bytes).toEqual(original)
  })

  it("leaves small profiled, 16-bit and gamma-bearing static originals unchanged", async () => {
    const base = await png(32, 16)
    const gamma = Buffer.alloc(4)
    gamma.writeUInt32BE(45_455)
    for (const bytes of [
      await sharp(base).withMetadata().png().toBuffer(),
      await sharp(base).toColourspace("rgb16").png().toBuffer(),
      addPngChunk(base, "gAMA", gamma),
    ])
      expect((await prepareKimiImageBytes(bytes)).bytes).toBe(bytes)
  })

  it("preserves oversized originals when conversion could change profile, depth or gamma", async () => {
    const base = await png(4097, 1)
    const gamma = Buffer.alloc(4)
    gamma.writeUInt32BE(45_455)
    for (const bytes of [
      await sharp(base).withMetadata().png().toBuffer(),
      await sharp(base).toColourspace("rgb16").png().toBuffer(),
      addPngChunk(base, "gAMA", gamma),
    ]) {
      const before = Buffer.from(bytes)
      const result = await prepareKimiImageBytes(bytes)
      expect(result.bytes).toBe(bytes)
      expect(result.mediaType).toBe("image/png")
      expect(bytes).toEqual(before)
    }
  })

  it("preserves a compact oversized JPEG when conversion would expand its payload", async () => {
    const pixels = Buffer.alloc(4097 * 64 * 3)
    let seed = 17
    for (let index = 0; index < pixels.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      pixels[index] = seed >>> 24
    }
    const bytes = await sharp(pixels, {
      raw: { width: 4097, height: 64, channels: 3 },
    })
      .jpeg({ quality: 10 })
      .toBuffer()
    const result = await prepareKimiImageBytes(bytes)
    expect(result.bytes).toBe(bytes)
    expect(result.mediaType).toBe("image/jpeg")
    expect((await sharp(result.bytes).metadata()).width).toBe(4097)
  })

  it("preserves a transparent single-frame GIF without rewriting its palette", async () => {
    const bytes = await sharp(await png(16, 8))
      .gif()
      .toBuffer()
    expect((await sharp(bytes).metadata()).pages).toBe(1)
    expect((await sharp(bytes).metadata()).hasAlpha).toBe(true)
    const prepared = await prepareKimiImageBytes(bytes)
    expect(prepared.bytes).toBe(bytes)
    expect(prepared.mediaType).toBe("image/gif")
  })

  it("rejects animated GIF/WebP/APNG without flattening or switching to video", async () => {
    const pixels = Buffer.alloc(16 * 16 * 3, 20)
    pixels.fill(180, 16 * 8 * 3)
    const animation = {
      raw: { width: 16, height: 16, channels: 3 as const, pageHeight: 8 },
    }
    const webp = await sharp(pixels, animation)
      .webp({ delay: [100, 200] })
      .toBuffer()
    expect((await sharp(webp).metadata()).pages).toBe(2)
    const animationControl = Buffer.alloc(8)
    animationControl.writeUInt32BE(2)
    const apng = addPngChunk(await png(16, 8), "acTL", animationControl)
    for (const bytes of [
      await sharp(pixels, animation)
        .gif({ delay: [100, 200] })
        .toBuffer(),
      webp,
      apng,
    ]) {
      const before = Buffer.from(bytes)
      await expect(prepareKimiImageBytes(bytes)).rejects.toThrow(
        "not flattened or sent as video",
      )
      expect(bytes).toEqual(before)
    }
  })

  it("does not mistake PNG text payload for animation or color chunks", async () => {
    const source = addPngChunk(
      Buffer.concat([await png(4097, 1), Buffer.alloc(1_000)]),
      "tEXt",
      Buffer.from("note\0acTL gAMA iCCP"),
    )
    const result = await prepareKimiImageBytes(source)
    expect(result.bytes.length).toBeLessThan(source.length)
    expect((await sharp(result.bytes).metadata()).width).toBe(4096)
  })

  it("rejects damaged pixels and honors cancellation without mutating input", async () => {
    const bytes = await png(10, 10)
    await expect(
      prepareKimiImageBytes(bytes.subarray(0, 24)),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
    const controller = new AbortController()
    controller.abort(new Error("Cancelled Kimi image"))
    await expect(
      prepareKimiImageBytes(bytes, controller.signal),
    ).rejects.toThrow("Cancelled Kimi image")
    expect((await prepareKimiImageBytes(bytes)).bytes).toBe(bytes)
  })
})
