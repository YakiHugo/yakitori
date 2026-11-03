import { createHash } from "node:crypto"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"

const endpoint = "https://generativelanguage.googleapis.com/v1beta"
const limit = 20_000_000
function inline(
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
function request(
  blocks: ModelImageBlock[],
  model = "gemini-3.8-flash",
): ModelRequest {
  return {
    target: { provider: "custom-name", model, instructionProfileId: "default" },
    system: [],
    messages: [{ role: "user", content: blocks }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
function assetRequest(bytes: Buffer, count = 1): ModelRequest {
  return {
    ...request([]),
    assets: { read: async () => bytes },
    messages: [
      {
        role: "user",
        content: Array.from(
          { length: count },
          (_, i): ModelImageBlock => ({
            type: "image",
            mediaType: "image/png",
            file: { rolloutId: "rollout_test", path: `${i}.png` },
            sizeBytes: bytes.length,
            detail: "high",
          }),
        ),
      },
    ],
  }
}
async function png(width = 2400) {
  return sharp({
    create: {
      width,
      height: 100,
      channels: 4,
      background: { r: 20, g: 70, b: 140, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
async function run(input: ModelRequest, baseURL = endpoint) {
  const bodies: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized JSON")
    bodies.push(init.body)
    return new Response(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const stream = createGeminiProvider({
    apiKey: "test",
    model: input.target.model,
    baseURL,
    fetchFn,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return { bodies, events }
}
function images(value: unknown): { mimeType: string; data: string }[] {
  if (Array.isArray(value)) return value.flatMap(images)
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  if (
    typeof record.mimeType === "string" &&
    record.mimeType.startsWith("image/") &&
    typeof record.data === "string"
  )
    return [{ mimeType: record.mimeType, data: record.data }]
  return Object.values(record).flatMap(images)
}
function outgoing(body: string) {
  return images(JSON.parse(body))
}
function toolMessages(block: ModelImageBlock): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_image", name: "inspect", input: {} },
      ],
    },
    { role: "tool", toolCallId: "call_image", content: [block] },
  ]
}

describe("native GenerateContent image preparation", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("preserves large %s source encoding and caller history", async (format) => {
    const source = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const input = request([inline(source, `image/${format}`)])
    const before = structuredClone(input)
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(outgoing(result.bodies[0] ?? "{}")).toEqual([
      { mimeType: `image/${format}`, data: source.toString("base64") },
    ])
    expect(input).toEqual(before)
    expect(JSON.parse(result.bodies[0] ?? "{}").generationConfig).toEqual({})
  })

  it("reprojects stored history from its available bytes after an endpoint switch", async () => {
    const source = await png(3000)
    const input = assetRequest(source)
    const before = structuredClone(input.messages)
    const legacy = await run(input, "https://compatible.example/v1beta")
    const legacyData = outgoing(legacy.bodies[0] ?? "{}")[0]?.data ?? ""
    expect(
      (await sharp(Buffer.from(legacyData, "base64")).metadata()).width,
    ).toBe(2048)
    const native = await run(input)
    expect(outgoing(native.bodies[0] ?? "{}")[0]?.data).toBe(
      source.toString("base64"),
    )
    expect(input.messages).toEqual(before)
  })

  it("delegates unknown native models without guessing their resolution", async () => {
    const source = await png()
    const result = await run(request([inline(source)], "future-model"))
    expect(outgoing(result.bodies[0] ?? "{}")[0]?.data).toBe(
      source.toString("base64"),
    )
  })

  it.each([
    "https://compatible.example/v1beta",
    "https://generativelanguage.googleapis.com/v1",
  ])("keeps legacy file preparation at %s", async (baseURL) => {
    const result = await run(assetRequest(await png()), baseURL)
    const data = outgoing(result.bodies[0] ?? "{}")[0]?.data ?? ""
    expect((await sharp(Buffer.from(data, "base64")).metadata()).width).toBe(
      2048,
    )
  })

  it.each([
    "gemini-3.8-flash",
    "gemini-2.5-flash",
    "gemini-3-future-text",
    "future-model",
  ])("preserves tool source pixels with the established %s schema", async (model) => {
    const source = await png()
    const result = await run({
      ...request([], model),
      messages: toolMessages(inline(source)),
    })
    expect(result.events.at(-1)?.type).toBe("response")
    const body = JSON.parse(result.bodies[0] ?? "{}")
    const parts = body.contents[1].parts
    expect(parts[0].functionResponse.parts !== undefined).toBe(
      model === "gemini-3.8-flash",
    )
    expect(outgoing(result.bodies[0] ?? "{}")[0]?.data).toBe(
      source.toString("base64"),
    )
  })

  it("retains animated user GIF bytes but rejects unsupported nested GIF tool parts", async () => {
    const frames = Buffer.alloc(32 * 32 * 3, 80)
    frames.fill(180, 32 * 16 * 3)
    const source = await sharp(frames, {
      raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
    })
      .gif({ delay: [100, 200] })
      .toBuffer()
    expect((await sharp(source, { animated: true }).metadata()).pages).toBe(2)
    const result = await run(request([inline(source, "image/gif")]))
    expect(outgoing(result.bodies[0] ?? "{}")).toEqual([
      { mimeType: "image/gif", data: source.toString("base64") },
    ])
    const failed = await run({
      ...request([]),
      messages: toolMessages(inline(source, "image/gif")),
    })
    expect(failed.bodies).toEqual([])
    expect(failed.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
    expect(JSON.stringify(failed.events)).toContain("Image was not sent")
    expect(JSON.stringify(failed.events)).toContain("image/gif")
  })

  it("sniffs actual encoding instead of trusting stale MIME metadata", async () => {
    const source = await sharp(await png())
      .jpeg()
      .toBuffer()
    const result = await run(request([inline(source, "image/png")]))
    expect(outgoing(result.bodies[0] ?? "{}")).toEqual([
      { mimeType: "image/jpeg", data: source.toString("base64") },
    ])
  })

  it("counts actual UTF-8, tools, MIME, and controls at the exact local budget boundary", async () => {
    const source = await sharp(await png())
      .jpeg()
      .toBuffer()
    const input: ModelRequest = {
      ...assetRequest(source),
      system: [{ id: "budget", revision: "1", text: '漢字\n"' }],
      tools: [
        {
          name: "inspect",
          description: "图像检查",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string", description: "é" } },
          },
        },
      ],
      providerOptions: {
        provider: "custom-name",
        wireApi: "gemini_generate_content",
        body: {
          generationConfig: {
            mediaResolution: "MEDIA_RESOLUTION_HIGH",
            temperature: 0.3,
          },
        },
      },
    }
    const baseline = await run(input)
    const overhead = Buffer.byteLength(baseline.bodies[0] ?? "")
    expect(overhead).toBeGreaterThan(0)
    const text = `漢字\n"${"a".repeat(limit - overhead)}`
    const exact = await run({
      ...input,
      system: [{ id: "budget", revision: "1", text }],
    })
    expect(exact.events.at(-1)?.type).toBe("response")
    expect(Buffer.byteLength(exact.bodies[0] ?? "")).toBe(limit)
    expect(JSON.parse(exact.bodies[0] ?? "{}").generationConfig).toMatchObject({
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      temperature: 0.3,
    })
    const tooLarge = {
      ...input,
      system: [{ id: "budget", revision: "1", text: `${text}a` }],
    }
    const failed = await run(tooLarge)
    expect(failed.bodies).toEqual([])
    expect(JSON.stringify(failed.events)).toContain(
      "20 MB local request budget",
    )
    expect(tooLarge.system[0]?.text.length).toBe(text.length + 1)
    tooLarge.system[0] = { id: "budget", revision: "1", text: "fixed" }
    const retry = await run(tooLarge)
    expect(retry.events.at(-1)?.type).toBe("response")
    expect(outgoing(retry.bodies[0] ?? "{}")[0]?.data).toBe(
      source.toString("base64"),
    )
  })

  it("rejects oversized static content before any asset read or network request", async () => {
    const input = assetRequest(await png())
    let reads = 0
    const result = await run({
      ...input,
      system: [{ id: "huge", revision: "1", text: "a".repeat(limit) }],
      assets: {
        read: async () => {
          reads += 1
          throw new Error("must not read")
        },
      },
    })
    expect(reads).toBe(0)
    expect(result.bodies).toEqual([])
    expect(JSON.stringify(result.events)).toContain(
      "20 MB local request budget",
    )
  })

  it("stops cumulative image preparation before reading later assets", async () => {
    const source = Buffer.concat([await png(), Buffer.alloc(7_600_000)])
    const originalHash = createHash("sha256").update(source).digest("hex")
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
    expect(reads).toBe(2)
    expect(result.bodies).toEqual([])
    expect(JSON.stringify(result.events)).toContain(
      "20 MB local request budget",
    )
    expect(createHash("sha256").update(source).digest("hex")).toBe(originalHash)
    expect(input.messages[0]?.content).toHaveLength(3)
  })

  it("accepts exactly 3600 small image occurrences", async () => {
    const source = await png(1)
    const result = await run(
      request(Array.from({ length: 3600 }, () => inline(source))),
    )
    expect(result.events.at(-1)?.type).toBe("response")
    expect(outgoing(result.bodies[0] ?? "{}")).toHaveLength(3600)
  })

  it("rejects more than 3600 image occurrences before reading files", async () => {
    let reads = 0
    const result = await run({
      ...assetRequest(await png(1), 3601),
      assets: {
        read: async () => {
          reads += 1
          throw new Error("must not read")
        },
      },
    })
    expect(reads).toBe(0)
    expect(result.bodies).toEqual([])
    expect(JSON.stringify(result.events)).toContain("3600")
  })

  it("keeps mixed PDF requests on existing bounded image preparation", async () => {
    const input = assetRequest(await png())
    const result = await run({
      ...input,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              name: "report.pdf",
              mediaType: "application/pdf",
              file: { rolloutId: "rollout_test", path: "report.pdf" },
              sizeBytes: 6,
              data: "JVBERi0x",
            },
          ],
        },
        ...input.messages,
      ],
    })
    expect(result.events.at(-1)?.type).toBe("response")
    const data = outgoing(result.bodies[0] ?? "{}")[0]?.data ?? ""
    expect((await sharp(Buffer.from(data, "base64")).metadata()).width).toBe(
      2048,
    )
  })
})
