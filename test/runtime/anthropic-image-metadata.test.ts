import { deflateSync } from "node:zlib"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { prepareAnthropicImage } from "../../src/runtime/anthropic-image-policy.ts"

function chunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, content, checksum])
}

function png(animated: boolean): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(2)
  const frame = (sequence: number) => {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(sequence)
    data.writeUInt32BE(1, 4)
    data.writeUInt32BE(1, 8)
    data.writeUInt16BE(1, 20)
    data.writeUInt16BE(10, 22)
    return data
  }
  const sequence = Buffer.alloc(4)
  sequence.writeUInt32BE(2)
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("Comment\0acTL is text, not animation")),
    ...(animated ? [chunk("acTL", animation), chunk("fcTL", frame(0))] : []),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    ...(animated
      ? [
          chunk("fcTL", frame(1)),
          chunk(
            "fdAT",
            Buffer.concat([
              sequence,
              deflateSync(Buffer.from([0, 0, 255, 0, 255])),
            ]),
          ),
        ]
      : []),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

describe("native Anthropic APNG preparation", () => {
  it("preserves admissible APNG bytes even when the decoder only exposes its first frame", async () => {
    const source = png(true)
    await expect(sharp(source).stats()).resolves.toBeDefined()
    const prepared = await prepareAnthropicImage(
      source,
      {
        type: "image",
        mediaType: "image/png",
        data: source.toString("base64"),
      },
      1,
    )
    expect(prepared.data).toBe(source.toString("base64"))
    const budgetCandidate = await prepareAnthropicImage(
      source,
      {
        type: "image",
        mediaType: "image/png",
        data: source.toString("base64"),
      },
      1,
      undefined,
      true,
    )
    expect(budgetCandidate.data).toBe(source.toString("base64"))
  })

  it("does not flatten APNG to satisfy a hard byte limit", async () => {
    const source = Buffer.concat([png(true), Buffer.alloc(7_500_000)])
    await expect(
      prepareAnthropicImage(
        source,
        {
          type: "image",
          mediaType: "image/png",
          data: source.toString("base64"),
        },
        1,
      ),
    ).rejects.toThrow("static 8-bit sRGB copy")
  })

  it("does not mistake acTL inside text for an animation control chunk", async () => {
    const source = Buffer.concat([png(false), Buffer.alloc(7_500_000)])
    const prepared = await prepareAnthropicImage(
      source,
      {
        type: "image",
        mediaType: "image/png",
        data: source.toString("base64"),
      },
      1,
    )
    expect(prepared.data).toBeDefined()
    expect(prepared.data?.length).toBeLessThan(10_000_000)
    expect(
      await sharp(Buffer.from(prepared.data ?? "", "base64")).metadata(),
    ).toMatchObject({ width: 1, height: 1, hasAlpha: true })
  })
})

it("does not discard explicit PNG gamma when a decoder labels the image sRGB", async () => {
  const gamma = Buffer.alloc(4)
  gamma.writeUInt32BE(100000)
  const plain = png(false)
  const source = Buffer.concat([
    plain.subarray(0, 33),
    chunk("gAMA", gamma),
    plain.subarray(33),
  ])
  expect(await sharp(source).metadata()).toMatchObject({
    space: "srgb",
    depth: "uchar",
    hasProfile: false,
  })
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: source.toString("base64"),
  }
  expect(
    (await prepareAnthropicImage(source, image, 1, undefined, true)).data,
  ).toBe(image.data)
  await expect(
    prepareAnthropicImage(
      Buffer.concat([source, Buffer.alloc(7_500_000)]),
      image,
      1,
    ),
  ).rejects.toThrow("static 8-bit sRGB copy")
})
