import OpenAI from "openai"
import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import {
  prepareOpenAIImage,
  validateOpenAIImageRequest,
  OPENAI_IMAGE_REQUEST_SAFETY_BYTES,
} from "../../src/runtime/openai-image-policy.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { gifImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.restoreAllMocks())
const png = () =>
  sharp({
    create: {
      width: 4096,
      height: 512,
      channels: 4,
      background: { r: 20, g: 60, b: 90, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
function block(
  bytes: Buffer,
  detail: "high" | "original" = "high",
): ModelImageBlock {
  return {
    type: "image",
    mediaType: "image/png",
    detail,
    data: bytes.toString("base64"),
  }
}
function request(images: ModelImageBlock[]): ModelRequest {
  return {
    target: {
      provider: "personal",
      model: "gpt-6-astra",
      instructionProfileId: "generic",
    },
    system: [],
    messages: [{ role: "user", content: images }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
function response() {
  return new Response(
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":null}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )
}
async function send(
  input: ModelRequest,
  options: {
    baseURL?: string
    requestProfile?: "codex"
    responseProfile?: "grok"
  } = {},
) {
  const bodies: string[] = []
  const client = new OpenAI({
    apiKey: "unused",
    baseURL: options.baseURL ?? "https://api.openai.com/v1",
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return response()
    },
  })
  const stream = createOpenAIProvider({
    apiKey: "unused",
    model: input.target.model,
    client,
    ...options,
  })
  return { bodies, events: await Array.fromAsync(stream(input)) }
}
function imageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(imageUrls)
  if (typeof value !== "object" || value === null) return []
  if (
    "type" in value &&
    value.type === "input_image" &&
    "image_url" in value &&
    typeof value.image_url === "string"
  )
    return [value.image_url]
  return Object.values(value).flatMap(imageUrls)
}

describe("native Responses Astra image preparation", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
  ] as const)("preserves original %s bytes even for high detail", async (format) => {
    const bytes = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const prepared = await prepareOpenAIImage(
      bytes,
      block(bytes),
      "gpt-6-astra",
    )
    expect(prepared.data).toBe(bytes.toString("base64"))
    expect(prepared.mediaType).toBe(`image/${format}`)
    expect(prepared.detail).toBe("high")
  })
  it("keeps static GIF intact and rejects animation rather than flattening", async () => {
    const staticGif = Buffer.from(gifImageBase64, "base64")
    expect(
      (await prepareOpenAIImage(staticGif, block(staticGif), "gpt-6-astra"))
        .data,
    ).toBe(gifImageBase64)
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
      raw: {
        width: 1,
        height: 2,
        channels: 3,
        pageHeight: 1,
      },
    })
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer()
    await expect(
      prepareOpenAIImage(animated, block(animated), "gpt-6-astra"),
    ).rejects.toThrow("non-animated GIF")
  })
  it("rejects oversized original before decoding or a model call, without changing high detail", async () => {
    const header = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
    header.writeUInt32BE(6400, 16)
    header.writeUInt32BE(6400, 20)
    const result = await send(request([block(header, "original")]))
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        message: expect.stringContaining("30000-patch"),
      },
    })
    expect(result.bodies).toHaveLength(0)
    const bytes = await png()
    const valid = await send(request([block(bytes, "original"), block(bytes)]))
    expect(valid.events.at(-1)).toMatchObject({ type: "response" })
    expect(imageUrls(JSON.parse(valid.bodies[0] ?? "{}"))).toEqual([
      `data:image/png;base64,${bytes.toString("base64")}`,
      `data:image/png;base64,${bytes.toString("base64")}`,
    ])
  })
  it("counts the complete JSON body and image occurrences including nested tool output", async () => {
    const wireImage = {
      type: "input_image",
      image_url: "https://example.com/image.png",
    }
    expect(() =>
      validateOpenAIImageRequest({
        input: [{ role: "user", content: Array(1500).fill(wireImage) }],
      }),
    ).not.toThrow()
    expect(() =>
      validateOpenAIImageRequest({
        input: [
          { type: "function_call_output", output: Array(1501).fill(wireImage) },
        ],
      }),
    ).toThrow("1500")
    // Image-like schemas are not image inputs.
    expect(() =>
      validateOpenAIImageRequest({
        input: [
          {
            type: "tool_search_output",
            tools: [
              {
                type: "function",
                parameters: { examples: Array(1501).fill(wireImage) },
              },
            ],
          },
          { role: "user", content: [wireImage] },
        ],
        tools: Array(1501).fill(wireImage),
      }),
    ).not.toThrow()
    const text = "x".repeat(OPENAI_IMAGE_REQUEST_SAFETY_BYTES / 2)
    expect(() =>
      validateOpenAIImageRequest({ input: [], instructions: [text, text] }),
    ).toThrow("80 MiB local")
    const bytes = await png()
    const input = request([block(bytes)])
    const result = await send({
      ...input,
      system: [
        { id: "large", revision: "1", text },
        { id: "large2", revision: "1", text },
      ],
    })
    expect(result.bodies).toHaveLength(0)
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request" },
    })
  })
  it("preflights excessive inline bytes before decoding and excessive count before asset reads", async () => {
    const data = "A".repeat(OPENAI_IMAGE_REQUEST_SAFETY_BYTES / 2)
    const result = await send(
      request([
        { type: "image", mediaType: "image/png", data },
        { type: "image", mediaType: "image/png", data },
      ]),
    )
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { message: expect.stringContaining("80 MiB local") },
    })
    expect(result.bodies).toHaveLength(0)
    const read = vi.fn(async () => Buffer.alloc(0))
    const remote: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      sizeBytes: 1,
      file: { rolloutId: "r", path: "a.png" },
    }
    const tooMany = await send({
      ...request(Array(1501).fill(remote)),
      assets: { read },
    })
    expect(tooMany.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { message: expect.stringContaining("1500") },
    })
    expect(read).not.toHaveBeenCalled()
  })
  it("preserves local asset bytes and leaves HTTP image fetching to the provider", async () => {
    const bytes = await png()
    const file: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      sizeBytes: bytes.length,
      detail: "original",
      file: { rolloutId: "r", path: "a.png" },
    }
    const url: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      sizeBytes: 0,
      file: { url: "https://example.com/image.png" },
    }
    const read = vi.fn(async () => bytes)
    const input = { ...request([file, url]), assets: { read } }
    const before = structuredClone(input.messages)
    const result = await send(input)
    expect(imageUrls(JSON.parse(result.bodies[0] ?? "{}"))).toEqual([
      `data:image/png;base64,${bytes.toString("base64")}`,
      "https://example.com/image.png",
    ])
    expect(read).toHaveBeenCalledTimes(1)
    expect(input.messages).toEqual(before)
  })
})

it.each([
  { native: true, model: "gpt-6-astra", width: 4096 },
  { native: false, model: "gpt-6-astra", width: 4096 },
  { native: false, model: "gpt-5.5", width: 4096 },
  { native: false, model: "gpt-5.6-sol", width: 4096 },
  { native: true, model: "gpt-6.1-sol", width: 4096 },
  { native: true, model: "gpt-6.1-terra", width: 4096 },
  { native: true, model: "gpt-6-sol", width: 4096 },
  { native: true, model: "gpt-6-luna", width: 4096 },
  ...[
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ].map((model) => ({ native: true, model, width: 4096 })),
])("preserves resolution through real Turn projection and repeated user/tool replay ($native/$model)", async ({
  native,
  model,
  width,
}) => {
  const bodies: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    bodies.push(String(options?.body))
    return response()
  })
  const provider = createConfiguredProvider(
    "personal",
    {
      name: "Renamed connection",
      service: "openai",
      wireApi: "openai_responses",
      baseURL: native
        ? "https://api.openai.com/v1"
        : "https://relay.example/v1",
      models: [
        native && (model.startsWith("gpt-5.") || model.startsWith("gpt-6.1-"))
          ? { id: model }
          : { id: model, inputModalities: ["text", "image"] },
      ],
    },
    "unused",
  )
  const turn = createProviderRegistry({ personal: provider })
    .createClient()
    .startTurn("personal")
  const selection = { provider: "personal", model }
  const configuration = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: "/tmp",
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: "astra-images",
    },
    provider.models,
  ).resolveStep(selection, provider.models)
  const registry = createToolRegistry([])
  const step = captureStepContext({
    registry,
    configuration,
    ...(turn.serviceId === undefined ? {} : { serviceId: turn.serviceId }),
    ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
  })
  const bytes = model.startsWith("gpt-6.1-")
    ? await sharp(await png())
        .webp()
        .toBuffer()
    : await png()
  const raw = block(bytes)
  const history: ModelMessage[] = [
    { role: "user", content: [raw] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_1", name: "inspect", input: {} },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: [
        native && model.startsWith("gpt-5.")
          ? { ...raw, detail: "original" }
          : raw,
      ],
    },
  ]
  const before = structuredClone(history)
  try {
    for (let replay = 0; replay < 2; replay++) {
      const messages = await prepareModelMedia(history, {
        target: step.target,
        deferImagePreparation: step.deferImagePreparation,
        imageCapabilities: step.modelInfo,
        rolloutAssets: undefined,
        documentReading: step.documentReading,
        userDocumentReading: step.userDocumentReading,
      })
      const events = await Array.fromAsync(
        turn.stream({
          target: step.target,
          system: [],
          messages,
          tools: [],
          toolWireProtocol: "eager",
        }),
      )
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({
        type: "response",
      })
      if (model.startsWith("gpt-6.1-"))
        expect(JSON.parse(bodies[replay] ?? "{}").reasoning.effort).toBe(
          "medium",
        )
      const urls = imageUrls(JSON.parse(bodies[replay] ?? "{}"))
      expect(urls).toHaveLength(2)
      if (native && model.startsWith("gpt-5.")) {
        expect(bodies[replay]).toContain('"detail":"high"')
        expect(bodies[replay]).toContain('"detail":"original"')
        expect(step.modelInfo.usedFallbackModelMetadata).toBe(true)
      }
      for (const url of urls) {
        const payload = Buffer.from(url.split(",")[1] ?? "", "base64")
        expect((await sharp(payload).metadata()).width).toBe(width)
        if (width === 4096) expect(payload).toEqual(bytes)
      }
    }
    expect(history).toEqual(before)
  } finally {
    await step.toolRouter.release()
    await registry.dispose()
    await provider.close?.()
  }
})

it.each([
  { baseURL: "https://api.openai.com/v1", requestProfile: "codex" as const },
  { baseURL: "https://api.openai.com/custom" },
  { baseURL: "https://relay.example/v1" },
])("does not apply public Astra preparation to proxy/custom routes %j", async (options) => {
  const bytes = await png()
  const file: ModelImageBlock = {
    type: "image",
    mediaType: "image/png",
    sizeBytes: bytes.length,
    file: { rolloutId: "r", path: "a.png" },
  }
  const result = await send(
    { ...request([file]), assets: { read: async () => bytes } },
    options,
  )
  expect(result.events.at(-1), JSON.stringify(result.events)).toMatchObject({
    type: "response",
  })
  const url = imageUrls(JSON.parse(result.bodies[0] ?? "{}"))[0] ?? ""
  expect(
    (await sharp(Buffer.from(url.split(",")[1] ?? "", "base64")).metadata())
      .width,
  ).toBe(options.requestProfile === "codex" ? 2048 : 4096)
})

it("bounds retained native images even without portable image blocks", async () => {
  const input = request([])
  const wireImage = {
    type: "input_image",
    image_url: "https://example.com/image.png",
  }
  const result = await send({
    ...input,
    continuationScope: "account",
    messages: [
      {
        role: "assistant",
        content: [],
        native: [
          {
            provider: "personal",
            model: "gpt-6-astra",
            wireApi: "openai_responses",
            scope: "account",
            value: {
              type: "message",
              role: "user",
              content: Array(1501).fill(wireImage),
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  })
  expect(result.bodies).toHaveLength(0)
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("1500") },
  })
})

it("prepares mixed local PDF and raw image without treating preflight placeholders as uploads", async () => {
  const bytes = await png()
  const pdf = Buffer.from("%PDF-1.7 test fixture")
  const input = request([block(bytes)])
  const result = await send({
    ...input,
    assets: { read: async () => pdf },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            mediaType: "application/pdf",
            name: "report.pdf",
            sizeBytes: pdf.length,
            file: { rolloutId: "r", path: "report.pdf" },
          },
          block(bytes),
        ],
      },
    ],
  })
  expect(result.events.at(-1)).toMatchObject({ type: "response" })
  const body = JSON.parse(result.bodies[0] ?? "{}")
  expect(imageUrls(body)).toEqual([
    `data:image/png;base64,${bytes.toString("base64")}`,
  ])
  expect(body.input[0].content[0]).toMatchObject({
    type: "input_file",
    file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
  })
})

it.each([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
])("leaves %s original resizing to the API instead of applying the modern rejection ceiling", async (model) => {
  const bytes = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer()
  const input = request([block(bytes, "original")])
  const before = structuredClone(input.messages)
  const result = await send({ ...input, target: { ...input.target, model } })
  expect(result.events.at(-1)).toMatchObject({ type: "response" })
  const body = JSON.parse(result.bodies[0] ?? "{}")
  expect(body.input[0].content[0].detail).toBe("original")
  expect(imageUrls(body)).toEqual([
    `data:image/png;base64,${bytes.toString("base64")}`,
  ])
  expect(input.messages).toEqual(before)
})

it.each([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
])("rejects over-limit %s original before decoding", async (model) => {
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(6400, 16)
  header.writeUInt32BE(6400, 20)
  const input = request([block(header, "original")])
  const result = await send({ ...input, target: { ...input.target, model } })
  expect(result.bodies).toHaveLength(0)
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("30000-patch") },
  })
})

it.each([
  "gpt-6.1-sol",
  "gpt-6.1-terra",
])("preserves native %s WebP and rejects unverified original including remote URLs", async (model) => {
  const bytes = await sharp(await png())
    .webp()
    .toBuffer()
  const input = request([block(bytes)])
  const result = await send({ ...input, target: { ...input.target, model } })
  expect(result.events.at(-1)).toMatchObject({ type: "response" })
  expect(imageUrls(JSON.parse(result.bodies[0] ?? "{}"))).toEqual([
    `data:image/webp;base64,${bytes.toString("base64")}`,
  ])
  const remote = request([
    {
      type: "image",
      mediaType: "image/png",
      sizeBytes: 0,
      detail: "original",
      file: { url: "https://example.com/a.png" },
    },
  ])
  const rejected = await send({
    ...remote,
    target: { ...remote.target, model },
  })
  expect(rejected.bodies).toHaveLength(0)
  expect(rejected.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("not verified") },
  })
})

it("rejects unverified native original retained inside a compaction replay", async () => {
  const input = request([])
  const model = "gpt-6.1-terra"
  const result = await send({
    ...input,
    target: { ...input.target, model },
    continuationScope: "account",
    messages: [
      {
        role: "assistant",
        content: [],
        native: [
          {
            provider: "personal",
            model,
            wireApi: "openai_responses",
            scope: "account",
            value: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  detail: "original",
                  image_url: "https://example.com/a.png",
                },
              ],
            },
          },
        ],
      },
    ],
  })
  expect(result.bodies).toHaveLength(0)
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("not verified") },
  })
})
