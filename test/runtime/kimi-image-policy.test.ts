import { createHash } from "node:crypto"
import { crc32, deflateSync } from "node:zlib"
import OpenAI from "openai"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"

const endpoint = "https://api.moonshot.ai/v1"
const limit = 20_000_000
function image(
  bytes: Buffer,
  mediaType: ModelImageBlock["mediaType"] = "image/png",
): ModelImageBlock {
  return {
    type: "image",
    mediaType,
    data: bytes.toString("base64"),
    detail: "high",
  }
}
function request(bytes: Buffer): ModelRequest {
  return {
    target: {
      provider: "custom-moonshot",
      model: "kimi-k3",
      instructionProfileId: "default",
    },
    system: [],
    messages: [{ role: "user", content: [image(bytes)] }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
function assetRequest(bytes: Buffer, count = 1): ModelRequest {
  return {
    ...request(bytes),
    assets: { read: async () => bytes },
    messages: [
      {
        role: "user",
        content: Array.from(
          { length: count },
          (_, i): ModelImageBlock => ({
            type: "image",
            mediaType: "image/png",
            detail: "high",
            file: { rolloutId: "rollout_test", path: `${i}.png` },
            sizeBytes: bytes.length,
          }),
        ),
      },
    ],
  }
}
async function png(width = 2400, height = 100) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 30, g: 80, b: 120, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
async function run(
  input: ModelRequest,
  baseURL = endpoint,
  responseProfile: "kimi" | "openai" = "kimi",
) {
  const bodies: string[] = []
  const client = new OpenAI({
    apiKey: "test",
    baseURL,
    maxRetries: 0,
    fetch: async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected serialized SDK body")
      bodies.push(init.body)
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_image", status: "completed", output: [], incomplete_details: null, error: null } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: input.target.model,
    client,
    responseProfile,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return { bodies, events }
}
function imageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(imageUrls)
  if (typeof value !== "object" || value === null) return []
  const object = value as Record<string, unknown>
  if (object.type === "input_image" && typeof object.image_url === "string")
    return [object.image_url]
  return Object.values(object).flatMap(imageUrls)
}
function sent(result: { bodies: string[] }): Buffer {
  const url = imageUrls(JSON.parse(result.bodies[0] ?? "{}"))[0] ?? ""
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
}
function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4)
  data.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
  return bytes
}
function apng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  const control = Buffer.alloc(8)
  control.writeUInt32BE(2)
  const frame = (sequence: number) => {
    const bytes = Buffer.alloc(26)
    bytes.writeUInt32BE(sequence)
    bytes.writeUInt32BE(1, 4)
    bytes.writeUInt32BE(1, 8)
    bytes.writeUInt16BE(1, 20)
    bytes.writeUInt16BE(10, 22)
    return bytes
  }
  const sequence = Buffer.alloc(4)
  sequence.writeUInt32BE(2)
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("acTL", control),
    chunk("fcTL", frame(0)),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("fcTL", frame(1)),
    chunk(
      "fdAT",
      Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 255, 0, 255]))]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

describe("native Moonshot Responses image preparation", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("preserves a static %s source larger than the legacy cap", async (format) => {
    const source = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const input = request(source)
    const before = structuredClone(input)
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sent(result).equals(source)).toBe(true)
    expect(imageUrls(JSON.parse(result.bodies[0] ?? "{}"))[0]).toMatch(
      new RegExp(`^data:image/${format};base64,`),
    )
    expect(input).toEqual(before)
  })

  it.each([
    [5000, 1000, 4096, 819],
    [1000, 5000, 819, 4096],
    [3000, 3000, 2160, 2160],
  ])("fits %i × %i within the orientation-aware recommendation", async (width, height, expectedWidth, expectedHeight) => {
    const source = await png(width, height)
    const result = await run(assetRequest(source))
    expect(result.events.at(-1)?.type).toBe("response")
    expect(await sharp(sent(result)).metadata()).toMatchObject({
      width: expectedWidth,
      height: expectedHeight,
      format: "png",
      hasAlpha: true,
    })
    expect(sent(result).length).toBeLessThan(source.length)
    const stats = await sharp(sent(result)).stats()
    expect(stats.channels[3]?.min).toBe(128)
    expect(stats.channels[3]?.max).toBe(128)
  })

  it("applies EXIF orientation once when producing a bounded static copy", async () => {
    const source = await sharp(await png(5000, 1000))
      .withExif({ IFD0: { Artist: "fixture" } })
      .png()
      .toBuffer()
    const exif = (await sharp(source).metadata()).exif
    expect(exif).toBeDefined()
    const orientation =
      exif?.indexOf(Buffer.from("120103000100000001000000", "hex")) ?? -1
    expect(orientation).toBeGreaterThanOrEqual(0)
    source.writeUInt16LE(
      6,
      source.indexOf(exif ?? Buffer.alloc(0)) + orientation + 8,
    )
    const exifOffset = source.indexOf(exif ?? Buffer.alloc(0))
    const exifEnd = exifOffset + (exif?.length ?? 0)
    source.writeUInt32BE(
      crc32(source.subarray(exifOffset - 4, exifEnd)),
      exifEnd,
    )
    expect(await sharp(source).metadata()).toMatchObject({
      orientation: 6,
      hasProfile: false,
    })
    const result = await run(request(source))
    expect(result.events.at(-1)?.type).toBe("response")
    expect(await sharp(sent(result)).metadata()).toMatchObject({
      width: 819,
      height: 4096,
    })
    expect((await sharp(sent(result)).metadata()).orientation).toBeUndefined()
    expect(sent(result).length).toBeLessThan(source.length)
  })

  it.each([
    ["https://proxy.example/v1", "kimi"],
    [endpoint, "openai"],
  ] as const)("preserves compatibility image resolution for %s profile %s", async (baseURL, profile) => {
    const source = await png()
    const result = await run(assetRequest(source), baseURL, profile)
    expect((await sharp(sent(result)).metadata()).width).toBe(2400)
  })

  it("projects the same owned history separately on a provider switch", async () => {
    const source = await png()
    const input = assetRequest(source)
    const before = structuredClone(input.messages)
    expect(
      (
        await sharp(
          sent(await run(input, "https://proxy.example/v1")),
        ).metadata()
      ).width,
    ).toBe(2400)
    expect(sent(await run(input))).toEqual(source)
    expect(input.messages).toEqual(before)
  })

  it("sends a transparent single-frame GIF unchanged", async () => {
    const source = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 30, g: 80, b: 120, alpha: 0 },
      },
    })
      .gif()
      .toBuffer()
    expect((await sharp(source).metadata()).pages).toBe(1)
    const result = await run(request(source))
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sent(result).equals(source)).toBe(true)
    expect(await sharp(sent(result)).metadata()).toMatchObject({
      format: "gif",
      hasAlpha: true,
    })
    expect((await sharp(sent(result)).stats()).channels[3]?.max).toBe(0)
  })

  it.each([
    "gif",
    "webp",
    "apng",
  ] as const)("rejects animated %s rather than flattening it", async (format) => {
    const frames = Buffer.alloc(32 * 32 * 3, 80)
    frames.fill(180, 32 * 16 * 3)
    const encoder = sharp(frames, {
      raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
    })
    const source =
      format === "apng"
        ? apng()
        : format === "gif"
          ? await encoder.gif({ delay: [100, 200] }).toBuffer()
          : await encoder.webp({ delay: [100, 200] }).toBuffer()
    await expect(sharp(source).stats()).resolves.toBeDefined()
    if (format !== "apng")
      expect((await sharp(source, { animated: true }).metadata()).pages).toBe(2)
    const result = await run(request(source))
    expect(result.bodies).toEqual([])
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
    expect(JSON.stringify(result.events)).toMatch(/static|animated/i)
  })

  it.each([
    "icc",
    "16bit",
    "gamma",
  ] as const)("preserves %s source bytes instead of applying an unsafe resize", async (kind) => {
    const prepare = async (width: number) => {
      const source = await png(width)
      if (kind === "icc")
        return sharp(source).withIccProfile("p3").png().toBuffer()
      if (kind === "16bit")
        return sharp(source).toColourspace("rgb16").png().toBuffer()
      const gamma = Buffer.alloc(4)
      gamma.writeUInt32BE(100000)
      return Buffer.concat([
        source.subarray(0, 33),
        chunk("gAMA", gamma),
        source.subarray(33),
      ])
    }
    const small = await prepare(2400)
    expect(sent(await run(request(small)))).toEqual(small)
    const large = await prepare(5000)
    const result = await run(request(large))
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sent(result)).toEqual(large)
    expect((await sharp(sent(result)).metadata()).width).toBe(5000)
  })

  it("sends the smaller original JPEG when a 4K PNG would exceed the request budget", async () => {
    const pixels = Buffer.alloc(5000 * 2800 * 3)
    let state = 0x12345678
    for (let offset = 0; offset < pixels.length; offset += 4) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      pixels.writeUInt32LE(state >>> 0, offset)
    }
    const source = await sharp(pixels, {
      raw: { width: 5000, height: 2800, channels: 3 },
    })
      .jpeg({ quality: 80 })
      .toBuffer()
    const candidate = await sharp(source)
      .resize({ width: 3857, height: 2160, kernel: "linear" })
      .png()
      .toBuffer()
    expect((source.length * 4) / 3).toBeLessThan(limit)
    expect(candidate.length).toBeGreaterThan(source.length)
    expect((candidate.length * 4) / 3).toBeGreaterThan(limit)
    const input = assetRequest(source)
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sent(result).equals(source)).toBe(true)
    expect((await sharp(sent(result)).metadata()).width).toBe(5000)
    expect(Buffer.byteLength(result.bodies[0] ?? "")).toBeLessThan(limit)
  })

  it("counts actual SDK JSON at the exact local budget and supports corrected retry", async () => {
    const source = await png(1)
    const input: ModelRequest = {
      ...assetRequest(source),
      system: [{ id: "budget", revision: "1", text: '漢字\n"' }],
      tools: [
        {
          name: "inspect",
          description: "图像",
          inputSchema: { type: "object" },
        },
      ],
      providerOptions: {
        provider: "custom-moonshot",
        wireApi: "openai_responses",
        body: { temperature: 0.2 },
      },
    }
    const baseline = await run(input)
    expect(baseline.events.at(-1)?.type).toBe("response")
    const overhead = Buffer.byteLength(baseline.bodies[0] ?? "")
    const text = `漢字\n"${"a".repeat(limit - overhead)}`
    const exact = await run({
      ...input,
      system: [{ id: "budget", revision: "1", text }],
    })
    expect(exact.events.at(-1)?.type).toBe("response")
    expect(Buffer.byteLength(exact.bodies[0] ?? "")).toBe(limit)
    const retryInput = {
      ...input,
      system: [{ id: "budget", revision: "1", text: `${text}a` }],
    }
    const failed = await run(retryInput)
    expect(failed.bodies).toEqual([])
    expect(JSON.stringify(failed.events)).toContain("20 MB")
    expect(retryInput.system[0]?.text.length).toBe(text.length + 1)
    retryInput.system[0] = { id: "budget", revision: "1", text: "corrected" }
    expect(sent(await run(retryInput))).toEqual(source)
  })

  it("rejects static request excess before any asset reads", async () => {
    let reads = 0
    const input = {
      ...assetRequest(await png()),
      system: [{ id: "huge", revision: "1", text: "a".repeat(limit) }],
      assets: {
        read: async () => {
          reads += 1
          throw new Error("must not read")
        },
      },
    }
    const result = await run(input)
    expect(result.bodies).toEqual([])
    expect(reads).toBe(0)
    expect(JSON.stringify(result.events)).toContain("20 MB")
  })

  it("stops cumulative preparation without reading later assets or changing originals", async () => {
    const source = Buffer.concat([await png(), Buffer.alloc(7_600_000)])
    const hash = createHash("sha256").update(source).digest("hex")
    let reads = 0
    const input = {
      ...assetRequest(source, 3),
      assets: {
        read: async () => {
          reads += 1
          return source
        },
      },
    }
    const result = await run(input)
    expect(result.bodies).toEqual([])
    expect(reads).toBe(2)
    expect(JSON.stringify(result.events)).toContain("20 MB")
    expect(createHash("sha256").update(source).digest("hex")).toBe(hash)
    expect(input.messages[0]?.content).toHaveLength(3)
  })
})
