import Anthropic from "@anthropic-ai/sdk"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelUserContentBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
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

function request(content: ModelUserContentBlock[]): ModelRequest {
  return {
    target: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      instructionProfileId: "anthropic",
    },
    system: [],
    messages: [{ role: "user", content }],
    tools: [],
    toolWireProtocol: "eager",
  }
}

async function send(
  input: ModelRequest,
  endpoint = "https://api.anthropic.com",
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
            message: { id: "msg_image", stop_reason: null, usage: {} },
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
    model: input.target.model,
    client,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return { bodies, events }
}

function sentImages(value: unknown): Buffer[] {
  if (Array.isArray(value)) return value.flatMap(sentImages)
  if (value === null || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  if (
    record.type === "base64" &&
    typeof record.data === "string" &&
    typeof record.media_type === "string" &&
    record.media_type.startsWith("image/")
  )
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

function fileRequest(bytes: Buffer): ModelRequest {
  return {
    ...request([]),
    assets: { read: async () => bytes },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            detail: "high",
            file: { rolloutId: "rollout_test", path: "source.png" },
            sizeBytes: bytes.length,
          },
        ],
      },
    ],
  }
}

describe("native Anthropic image preparation", () => {
  it.each([
    "png",
    "jpeg",
  ] as const)("delegates a large %s source unchanged to the known native model", async (format) => {
    const source =
      format === "png"
        ? await png()
        : await sharp(await png())
            .flatten()
            .jpeg()
            .toBuffer()
    const block = {
      ...image(source),
      mediaType:
        format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
    }
    const input = request([block])
    const before = structuredClone(input)
    const result = await send(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sentImages(result.bodies)).toEqual([source])
    expect(input).toEqual(before)
    expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
      2400,
    )
  })

  it("preserves locally owned source bytes without mutating the asset", async () => {
    const source = await png()
    const original = Buffer.from(source)
    const result = await send(fileRequest(source))
    expect(sentImages(result.bodies)).toEqual([source])
    expect(source).toEqual(original)
  })

  it.each([
    ["https://compatible.example/v1", "claude-sonnet-4-6"],
    ["https://api.anthropic.com/v1", "claude-sonnet-4-6"],
  ])("preserves resolution on compatibility routes %s and %s", async (endpoint, model) => {
    const source = await png()
    const input = fileRequest(source)
    const result = await send(
      { ...input, target: { ...input.target, model } },
      endpoint,
    )
    expect(result.events.at(-1)?.type).toBe("response")
    const [outgoing] = sentImages(result.bodies)
    expect(outgoing).toEqual(source)
    expect((await sharp(outgoing).metadata()).width).toBe(2400)
  })

  it("preserves native images nested in tool results", async () => {
    const source = await png()
    const input = request([])
    const result = await send({
      ...input,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call_image",
              name: "view_image",
              input: {},
            },
          ],
        },
        { role: "tool", toolCallId: "call_image", content: [image(source)] },
      ],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sentImages(result.bodies)).toEqual([source])
  })

  it("falls back to bounded preparation when one encoded image exceeds the native limit", async () => {
    const source = Buffer.concat([await png(), Buffer.alloc(7_500_000)])
    const result = await send(request([image(source)]))
    expect(result.events.at(-1)?.type).toBe("response")
    const [outgoing] = sentImages(result.bodies)
    expect((await sharp(outgoing).metadata()).width).toBe(1568)
    expect(outgoing?.toString("base64").length).toBeLessThan(10_000_000)
  })

  it("bounds a source beyond the native 8000-pixel admission edge", async () => {
    const source = await png(8100, 10)
    const result = await send(request([image(source)]))
    expect(result.events.at(-1)?.type).toBe("response")
    expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
      1568,
    )
  })

  it("re-encodes a padded but safe small image without reducing dimensions", async () => {
    const source = Buffer.concat([await png(100, 100), Buffer.alloc(7_500_000)])
    const result = await send(request([image(source)]))
    expect(result.events.at(-1)?.type).toBe("response")
    const [outgoing] = sentImages(result.bodies)
    expect((await sharp(outgoing).metadata()).width).toBe(100)
    expect(await sharp(outgoing).raw().toBuffer()).toEqual(
      await sharp(source).raw().toBuffer(),
    )
  })

  it("counts earlier and nested images for the many-image dimension limit", async () => {
    const source = await png(3200, 100)
    const input = request(Array.from({ length: 20 }, () => image(source)))
    const result = await send({
      ...input,
      messages: [
        ...input.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call_many",
              name: "view_image",
              input: {},
            },
          ],
        },
        { role: "tool", toolCallId: "call_many", content: [image(source)] },
      ],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    const images = sentImages(result.bodies)
    expect(images).toHaveLength(21)
    for (const bytes of images)
      expect((await sharp(bytes).metadata()).width).toBe(1568)
  })

  it("uses the actual serialized request budget and falls back once before sending", async () => {
    const source = Buffer.concat([await png(), Buffer.alloc(200_000)])
    const input = request([image(source)])
    const result = await send({
      ...input,
      system: [{ id: "large", revision: "1", text: "a".repeat(31_900_000) }],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    expect(result.bodies).toHaveLength(1)
    expect(
      Buffer.byteLength(JSON.stringify(result.bodies[0])),
    ).toBeLessThanOrEqual(32_000_000)
    expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
      1568,
    )
  })

  it("rejects a still-oversized complete body without calling the model", async () => {
    const input = request([image(await png())])
    const result = await send({
      ...input,
      system: [{ id: "large", revision: "1", text: "a".repeat(32_000_000) }],
    })
    expect(result.bodies).toEqual([])
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
    expect(JSON.stringify(result.events)).toContain("32 MB")
  })

  it.each([
    ["claude-haiku-4-5", 100, true],
    ["claude-haiku-4-5", 101, false],
    ["claude-sonnet-4-6", 600, true],
    ["claude-sonnet-4-6", 601, false],
  ] as const)("enforces %s image-count boundary at %i", async (model, count, accepted) => {
    const input = request(
      Array.from(
        { length: count },
        (): ModelImageBlock => ({
          type: "image",
          mediaType: "image/png",
          file: { url: "https://images.example/source.png" },
          sizeBytes: 0,
        }),
      ),
    )
    const result = await send({ ...input, target: { ...input.target, model } })
    expect(result.bodies).toHaveLength(accepted ? 1 : 0)
    expect(result.events.at(-1)?.type).toBe(accepted ? "response" : "failure")
  })

  it("does not impose the new image budget on a text-only request", async () => {
    const result = await send({
      ...request([]),
      system: [{ id: "large", revision: "1", text: "a".repeat(32_000_000) }],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    expect(result.bodies).toHaveLength(1)
  })

  it("preserves file-image resolution for a mixed PDF request", async () => {
    const input = fileRequest(await png())
    const result = await send({
      ...input,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              name: "report.pdf",
              mediaType: "application/pdf",
              sizeBytes: 6,
              file: { rolloutId: "rollout_test", path: "report.pdf" },
              data: "JVBERi0x",
            },
          ],
        },
        ...input.messages,
      ],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
      2400,
    )
  })
})

it.each([
  {
    tools: [
      {
        type: "computer_20251124",
        name: "computer",
        display_width_px: 2400,
        display_height_px: 1200,
      },
    ],
  },
  { user_profile_id: "profile-example" },
  { output_format: { type: "json_schema", schema: { type: "object" } } },
])("preserves image resolution with advanced native controls", async (body) => {
  const input = fileRequest(await png())
  const result = await send({
    ...input,
    providerOptions: {
      provider: "anthropic",
      wireApi: "anthropic_messages",
      body,
    },
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
    2400,
  )
})

it("serializes unchanged image bytes through the real SDK without making an external call", async () => {
  const source = await png()
  let wireBody: unknown
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON wire body")
      wireBody = JSON.parse(init.body)
      expect(Buffer.byteLength(init.body, "utf8")).toBeLessThanOrEqual(
        32_000_000,
      )
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_wire","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const stream = createAnthropicTestStream({
    apiKey: "test",
    model: "claude-sonnet-4-6",
    client,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of stream(request([image(source)]))) events.push(event)
  expect(events.at(-1)?.type).toBe("response")
  expect(sentImages(wireBody)).toEqual([source])
})

it("preserves EXIF JPEG and animated GIF source encoding at the native boundary", async () => {
  const jpeg = await sharp(await png())
    .flatten()
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const gif = await sharp(Buffer.alloc(2200 * 20 * 3, 80), {
    raw: { width: 2200, height: 20, channels: 3, pageHeight: 10 },
  })
    .gif({ delay: [100, 200] })
    .toBuffer()
  for (const [source, mediaType] of [
    [jpeg, "image/jpeg"],
    [gif, "image/gif"],
  ] as const) {
    const result = await send(request([{ ...image(source), mediaType }]))
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sentImages(result.bodies)).toEqual([source])
  }
})

it("projects PDF raster fallback separately while delegating ordinary inline and file images from originals", async () => {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createRolloutAssets } = await import(
    "../../src/core/rollout-assets.ts"
  )
  const { prepareModelMedia } = await import("../../src/runtime/model-media.ts")
  const { prepareModelDocuments } = await import(
    "../../src/runtime/prepare-model-document.ts"
  )
  const { pdfFixture } = await import("./tools/pdf-fixture.ts")
  const root = await mkdtemp(join(tmpdir(), "native-image-projection-"))
  try {
    await mkdir(join(root, "rollouts", "rollout_test"), { recursive: true })
    const assets = createRolloutAssets(root, {
      withMutationLease: async (_id, mutate) => mutate(),
    })
    const pdf = pdfFixture(["PDF raster stays on its existing policy"])
    const source = await png()
    const storedPdf = await assets.saveToolFile(
      "rollout_test",
      "call_pdf",
      "report.pdf",
      pdf,
    )
    const storedImage = await assets.saveToolFile(
      "rollout_test",
      "call_image",
      "source.png",
      source,
    )
    const document = {
      type: "document" as const,
      mediaType: "application/pdf" as const,
      name: "report.pdf",
      file: storedPdf.reference,
      sizeBytes: pdf.length,
    }
    const input = request([
      document,
      image(source),
      {
        type: "image",
        mediaType: "image/png",
        file: storedImage.reference,
        sizeBytes: source.length,
        detail: "high",
      },
    ])
    const before = JSON.stringify(input.messages)
    const legacyPdf = await prepareModelDocuments([document], assets, {
      nativePdf: false,
      images: true,
    })
    const projected = await prepareModelMedia(input.messages, {
      deferImagePreparation: true,
      target: input.target,
      imageCapabilities: {
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      rolloutAssets: assets,
      documentReading: { nativePdf: false, images: true },
      userDocumentReading: { nativePdf: false, images: true },
    })
    const result = await send({ ...input, messages: projected, assets })
    expect(result.events.at(-1)?.type).toBe("response")
    expect(sentImages(result.bodies)).toEqual([
      ...legacyPdf.images.map((block) =>
        Buffer.from(block.data ?? "", "base64"),
      ),
      source,
      source,
    ])
    expect(JSON.stringify(input.messages)).toBe(before)
    expect(await assets.read(storedImage.reference)).toEqual(source)
    // A model switch reprojects the same original rather than the last wire image.
    const switched = await prepareModelMedia(
      input.messages.slice().map((message) =>
        message.role === "user"
          ? {
              ...message,
              content: message.content.filter(
                (block) => block.type !== "document",
              ),
            }
          : message,
      ),
      {
        deferImagePreparation: false,
        target: input.target,
        imageCapabilities: {
          inputModalities: ["text", "image"],
          imageDetailModes: ["high"],
        },
        rolloutAssets: assets,
        documentReading: { nativePdf: false, images: true },
        userDocumentReading: { nativePdf: false, images: true },
      },
    )
    const message = switched[0]
    if (message?.role !== "user") throw new Error("Missing user message")
    const block = message.content[0]
    if (block?.type !== "image" || !block.data)
      throw new Error("Missing inline image")
    expect(
      (await sharp(Buffer.from(block.data, "base64")).metadata()).width,
    ).toBe(2400)
    expect(JSON.stringify(input.messages)).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("bounds large file-backed image batches before materializing every source", async () => {
  const profiled = await sharp(await png(1, 1))
    .withMetadata()
    .png()
    .toBuffer()
  const source = Buffer.concat([profiled, Buffer.alloc(6_100_000)])
  let reads = 0
  const input = request(
    Array.from(
      { length: 12 },
      (_, index): ModelImageBlock => ({
        type: "image",
        mediaType: "image/png",
        sizeBytes: source.length,
        file: { rolloutId: "rollout_test", path: `image-${index}.png` },
      }),
    ),
  )
  const result = await send({
    ...input,
    assets: {
      async read() {
        reads += 1
        return source
      },
    },
  })
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "invalid_request" },
  })
  expect(result.bodies).toHaveLength(0)
  expect(reads).toBeLessThan(12)
})

it.each([
  [1920, 1080, 1456, 819],
  [1075, 1520, 924, 1307],
  [2400, 1200, 1568, 784],
  [100, 100, 100, 100],
] as const)("uses documented standard-tier dimensions for %i x %i only when adaptation is necessary", async (width, height, expectedWidth, expectedHeight) => {
  const source = Buffer.concat([
    await png(width, height),
    Buffer.alloc(7_500_000),
  ])
  const result = await send(request([image(source)]))
  expect(result.events.at(-1)?.type).toBe("response")
  const output = sentImages(result.bodies)[0]
  const metadata = await sharp(output).metadata()
  expect([metadata.width, metadata.height]).toEqual([
    expectedWidth,
    expectedHeight,
  ])
  expect(
    Math.ceil(metadata.width / 28) * Math.ceil(metadata.height / 28),
  ).toBeLessThanOrEqual(1568)
  expect(metadata.hasAlpha).toBe(true)
  const alpha = await sharp(output).extractChannel("alpha").raw().toBuffer()
  expect(new Set(alpha)).toEqual(new Set([128]))
})

it("applies EXIF orientation before the native tier resize", async () => {
  const jpeg = await sharp(await png())
    .flatten()
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withIccProfile("srgb", { attach: false })
    .toBuffer()
  expect((await sharp(jpeg).metadata()).icc).toBeUndefined()
  const source = Buffer.concat([jpeg, Buffer.alloc(7_500_000)])
  const result = await send(
    request([{ ...image(source), mediaType: "image/jpeg" }]),
  )
  expect(result.events.at(-1)?.type).toBe("response")
  expect(await sharp(sentImages(result.bodies)[0]).metadata()).toMatchObject({
    width: 784,
    height: 1568,
  })
})

it("rejects necessary conversions of profiled, 16-bit and animated originals instead of silently changing semantics", async () => {
  const profiled = await sharp(await png())
    .withMetadata()
    .png()
    .toBuffer()
  const highDepth = await sharp(await png(10, 10))
    .toColourspace("rgb16")
    .png()
    .toBuffer()
  const frames = Buffer.alloc(32 * 20 * 3, 80)
  frames.fill(160, 32 * 10 * 3)
  const animated = await sharp(frames, {
    raw: { width: 32, height: 20, channels: 3, pageHeight: 10 },
  })
    .gif({ delay: [100, 200] })
    .toBuffer()
  expect((await sharp(animated).metadata()).pages).toBe(2)
  for (const source of [profiled, highDepth, animated]) {
    const padded = Buffer.concat([source, Buffer.alloc(7_500_000)])
    const input = request([image(padded)])
    const result = await send(input)
    expect(result.bodies).toHaveLength(0)
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request" },
    })
    expect(JSON.stringify(result.events)).toContain("static 8-bit sRGB copy")
    expect(
      (input.messages[0] as { readonly content: readonly ModelImageBlock[] })
        .content[0]?.data,
    ).toBe(padded.toString("base64"))
  }
})

it("preserves an unknown native model's source without assuming its resolution tier", async () => {
  const source = await png()
  const input = fileRequest(source)
  const result = await send({
    ...input,
    target: { ...input.target, model: "unknown-model" },
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(sentImages(result.bodies)).toEqual([source])
})

it.each([
  "image",
  "request",
] as const)("applies native protocol/local %s budget safeguards to an unknown model without guessing resize", async (kind) => {
  const source =
    kind === "image"
      ? Buffer.concat([await png(), Buffer.alloc(7_500_000)])
      : await png()
  const input = fileRequest(source)
  const result = await send({
    ...input,
    target: { ...input.target, model: "unknown-model" },
    ...(kind === "request"
      ? {
          system: [
            { id: "large", revision: "1", text: "x".repeat(32_000_000) },
          ],
        }
      : {}),
  })
  expect(result.bodies).toHaveLength(0)
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "invalid_request" },
  })
  expect(JSON.stringify(result.events)).toContain(
    kind === "image" ? "Automatic resizing is not configured" : "Yakitori",
  )
})
