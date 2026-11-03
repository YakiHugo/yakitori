import type Anthropic from "@anthropic-ai/sdk"
import { crc32 } from "node:zlib"
import sharp from "sharp"
import { expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { withSDKResponse } from "../support/sdk-response.ts"
import { createAnthropicTestStream } from "./anthropic-test-stream.ts"

function image(bytes: Buffer): ModelImageBlock {
  return {
    type: "image",
    mediaType: "image/png",
    detail: "high",
    data: bytes.toString("base64"),
  }
}
function request(bytes: Buffer): ModelRequest {
  return {
    target: {
      provider: "renamed-account",
      model: "kimi-for-coding",
      instructionProfileId: "kimi-code",
    },
    system: [],
    messages: [{ role: "user", content: [image(bytes)] }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
function harness(
  endpoint = "https://api.kimi.com/coding",
  profile: "generic" | "kimi-code" = "kimi-code",
) {
  const bodies: unknown[] = []
  const client = withSDKResponse({
    baseURL: endpoint,
    messages: {
      create(body: unknown) {
        bodies.push(body)
        return (async function* () {
          yield {
            type: "message_start",
            message: { id: "msg", stop_reason: null, usage: {} },
          }
          yield {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          }
          yield { type: "message_stop" }
        })()
      },
    },
  } as unknown as Anthropic)
  const stream = createAnthropicTestStream({
    apiKey: "test",
    model: "kimi-for-coding",
    client,
    profile,
  })
  return {
    bodies,
    async send(input: ModelRequest) {
      const events: ModelStreamEvent[] = []
      for await (const event of stream(input)) events.push(event)
      return events
    },
  }
}
function sentImages(value: unknown): Buffer[] {
  if (Array.isArray(value)) return value.flatMap(sentImages)
  if (value === null || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  if (record.type === "base64" && typeof record.data === "string")
    return [Buffer.from(record.data, "base64")]
  return Object.values(record).flatMap(sentImages)
}
async function png(width = 2400, height = 1200) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 50, b: 80, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
async function animated() {
  const pixels = Buffer.alloc(2100 * 20 * 3, 80)
  pixels.fill(255, 0, 2100 * 10 * 3)
  return sharp(pixels, {
    raw: { width: 2100, height: 20, channels: 3, pageHeight: 10 },
  })
    .gif({ delay: [100, 200] })
    .toBuffer()
}
function addChunk(bytes: Buffer, type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)])
}

it("safely resizes saved transparent attachments even when storage exports a URL, without mutating sources", async () => {
  const source = await png()
  const before = Buffer.from(source)
  const input: ModelRequest = {
    ...request(source),
    assets: {
      read: async () => source,
      url: () => "https://assets.invalid/source.png",
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            file: { rolloutId: "r", path: "source.png" },
            sizeBytes: source.length,
            detail: "original",
          },
        ],
      },
    ],
  }
  const original = structuredClone(input.messages)
  const run = harness()
  expect((await run.send(input)).at(-1)?.type).toBe("response")
  const sent = sentImages(run.bodies)[0]
  expect(await sharp(sent).metadata()).toMatchObject({
    width: 2000,
    height: 1000,
    hasAlpha: true,
  })
  const pixel = await sharp(sent)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer()
  expect([...pixel]).toEqual([19, 49, 79, 128])
  expect(source).toEqual(before)
  expect(input.messages).toEqual(original)
})

it.each([
  "animation",
  "icc",
  "16bit",
  "apng",
  "gamma",
])("rejects unsafe %s conversion before a request and allows a corrected copy on the same transport", async (kind) => {
  let source = await png()
  if (kind === "animation") source = await animated()
  if (kind === "icc")
    source = await sharp(source).withIccProfile("srgb").png().toBuffer()
  if (kind === "16bit")
    source = await sharp(source).toColourspace("rgb16").png().toBuffer()
  if (kind === "apng")
    source = addChunk(source, "acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))
  if (kind === "gamma")
    source = addChunk(source, "gAMA", Buffer.from([0, 0, 177, 143]))
  const before = Buffer.from(source)
  const run = harness()
  const events = await run.send(request(source))
  expect(run.bodies).toHaveLength(0)
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "failure",
      failure: expect.objectContaining({
        kind: "invalid_request",
        stage: "request_build",
      }),
    }),
  )
  expect(JSON.stringify(events)).toContain("automatic conversion could discard")
  expect(JSON.stringify(events)).toContain("original has not been changed")
  expect(source).toEqual(before)
  expect((await run.send(request(await png(100, 50)))).at(-1)?.type).toBe(
    "response",
  )
  expect(run.bodies).toHaveLength(1)
})

it("defers inline historical tool images so animation is rejected rather than flattened before the adapter", async () => {
  const source = await animated()
  const base = request(await png(10, 10))
  const history: ModelRequest["messages"] = [
    ...base.messages,
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call",
          name: "read",
          input: { path: "a.gif" },
        },
      ],
    },
    { role: "tool", toolCallId: "call", content: [image(source)] },
  ]
  const messages = await prepareModelMedia(history, {
    deferImagePreparation: true,
    target: base.target,
    imageCapabilities: {
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
    },
    rolloutAssets: undefined,
    documentReading: { nativePdf: false, images: true },
    userDocumentReading: { nativePdf: false, images: true },
  })
  const run = harness()
  const events = await run.send({ ...base, messages })
  expect(run.bodies).toHaveLength(0)
  expect(JSON.stringify(events)).toContain("tool message 3")
  expect(JSON.stringify(events)).toContain("automatic conversion could discard")
})

it("preserves small valid bytes including a previously saved derivative rather than pretending to restore original pixels", async () => {
  const source = await png(1900, 950)
  const run = harness()
  expect((await run.send(request(source))).at(-1)?.type).toBe("response")
  expect(sentImages(run.bodies)).toEqual([source])
})

it("rotates oversized EXIF pixels once without retaining an orientation that would rotate them again", async () => {
  const source = await sharp(await png())
    .flatten()
    .jpeg()
    .withExif({ IFD0: {} })
    .toBuffer()
  // Construct a real little-endian TIFF orientation tag without adding ICC;
  // withMetadata would exercise the color-profile rejection instead.
  const tiff = source.subarray(source.indexOf(Buffer.from("Exif\0\0")) + 6)
  for (let i = 0; i < tiff.readUInt16LE(8); i++) {
    const offset = 10 + i * 12
    if (tiff.readUInt16LE(offset) === 0x112) tiff.writeUInt16LE(6, offset + 8)
  }
  expect(await sharp(source).metadata()).toMatchObject({ orientation: 6 })
  const before = Buffer.from(source)
  const run = harness("https://api.kimi.com/coding/v1/")
  expect((await run.send(request(source))).at(-1)?.type).toBe("response")
  const metadata = await sharp(sentImages(run.bodies)[0]).metadata()
  expect(metadata).toMatchObject({ width: 1000, height: 2000 })
  expect(metadata.orientation).toBeUndefined()
  expect(source).toEqual(before)
})

it("does not apply the agent-read byte budget to user attachments or total requests", async () => {
  const pixels = Buffer.alloc(400 * 400 * 3)
  let seed = 12345
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    pixels[i] = seed >>> 24
  }
  const source = await sharp(pixels, {
    raw: { width: 400, height: 400, channels: 3 },
  })
    .png()
    .toBuffer()
  expect(source.length).toBeGreaterThan(262144)
  const base = request(source)
  const run = harness()
  expect(
    (
      await run.send({
        ...base,
        messages: [
          {
            role: "user",
            content: Array.from({ length: 5 }, () => image(source)),
          },
        ],
      })
    ).at(-1)?.type,
  ).toBe("response")
  expect(sentImages(run.bodies)).toEqual(
    Array.from({ length: 5 }, () => source),
  )
})

it.each([
  ["https://relay.example/coding", "kimi-code"],
  ["https://api.kimi.com/coding", "generic"],
  ["https://api.kimi.com/coding/other", "kimi-code"],
] as const)("does not opt %s with %s profile into a native Kimi client policy", async (endpoint, profile) => {
  const source = await png()
  const run = harness(endpoint, profile)
  expect((await run.send(request(source))).at(-1)?.type).toBe("response")
  expect(sentImages(run.bodies)).toEqual([source])
})

it.each([
  ["k3.1-pro", "https://api.kimi.com/coding/"],
  ["k3.1-pro-highspeed", "https://api.kimi.com/coding/"],
  ["k3", "https://api.kimi.com/coding/v1"],
  ["k3-256k", "https://api.kimi.com/coding/v1"],
  ["kimi-for-coding", "https://api.kimi.com/coding"],
  ["kimi-for-coding-highspeed", "https://api.kimi.com/coding"],
])("prepares images for %s on the official endpoint %s", async (model, endpoint) => {
  const source = await png()
  const input = request(source)
  const run = harness(endpoint)
  const events = await run.send({ ...input, target: { ...input.target, model } })
  expect(events.at(-1)?.type).toBe("response")
  expect(await sharp(sentImages(run.bodies)[0]).metadata()).toMatchObject({
    width: 2000,
    height: 1000,
    hasAlpha: true,
  })
})
