import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createStepfunImagePolicy } from "../../src/runtime/stepfun-image-policy.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const endpoint = "https://api.stepfun.com/v1"
function request(
  images: ModelImageBlock[],
  model = "step-5-preview",
): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages: [{ role: "user", content: images }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
function inline(bytes: Buffer): ModelImageBlock {
  return {
    type: "image",
    mediaType: "image/jpeg",
    data: bytes.toString("base64"),
    detail: "high",
  }
}
async function png(width = 3000) {
  return sharp({
    create: {
      width,
      height: 100,
      channels: 4,
      background: { r: 20, g: 30, b: 40, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
async function run(
  input: ModelRequest,
  baseURL = endpoint,
  flavor: "stepfun" | "generic" = "stepfun",
) {
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected request body")
      bodies.push(init.body)
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const events: ModelStreamEvent[] = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "test",
    baseURL,
    model: input.target.model,
    flavor,
  })(input))
    events.push(event)
  return { bodies, events, fetch }
}
function failure(result: Awaited<ReturnType<typeof run>>, text: string) {
  expect(result.bodies).toEqual([])
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      stage: "request_build",
      kind: "invalid_request",
      message: expect.stringContaining(text),
    },
  })
}
afterEach(() => vi.restoreAllMocks())

describe("Step 5 native vision", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
    "gif",
  ] as const)("preserves %s original pixels/encoding and detects MIME", async (format) => {
    const bytes = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const input = request([inline(bytes)])
    const original = structuredClone(input)
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(JSON.parse(result.bodies[0] ?? "").messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: {
        url: `data:image/${format};base64,${bytes.toString("base64")}`,
        detail: "high",
      },
    })
    expect(input).toEqual(original)
    expect(JSON.parse(result.bodies[0] ?? "")).not.toHaveProperty(
      "stream_options",
    )
  })

  it("rejects animated GIF rather than silently taking one frame", async () => {
    const frames = Buffer.alloc(32 * 32 * 3, 80)
    frames.fill(180, 32 * 16 * 3)
    const bytes = await sharp(frames, {
      raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
    })
      .gif({ delay: [100, 200] })
      .toBuffer()
    failure(await run(request([inline(bytes)])), "static GIF")
  })

  it("keeps provider-addressable URLs without client downloading", async () => {
    const result = await run(
      request([
        {
          type: "image",
          mediaType: "image/png",
          file: { url: "https://example.com/screenshot.png" },
          sizeBytes: 0,
        },
      ]),
    )
    expect(result.events.at(-1)?.type).toBe("response")
    expect(result.fetch).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(result.bodies[0] ?? "").messages[0].content[0],
    ).toMatchObject({
      image_url: { url: "https://example.com/screenshot.png", detail: "high" },
    })
  })

  it("accepts 60 images and rejects 61 before reading local assets", async () => {
    expect(
      (await run(request(Array(60).fill(inline(await png(1)))))).events.at(-1)
        ?.type,
    ).toBe("response")
    const read = vi.fn().mockRejectedValue(new Error("Must not read"))
    const image: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { rolloutId: "rollout_test", path: "test.png" },
      sizeBytes: 1,
    }
    failure(
      await run({ ...request(Array(61).fill(image)), assets: { read } }),
      "60 images",
    )
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects corrupt input before inference with a structured local failure", async () => {
    failure(
      await run(request([inline(Buffer.from("broken image"))])),
      "Only PNG",
    )
  })

  it("labels its aggregate encoded allocation bound as local, not a vendor quota", async () => {
    const bytes = Buffer.concat([await png(1), Buffer.alloc(13_000_000)])
    failure(await run(request([inline(bytes), inline(bytes)])), "local 32 MB")
  })

  it("includes UTF-8 text and tools in final request admission", async () => {
    const input = request([inline(await png())])
    failure(
      await run({
        ...input,
        tools: [
          {
            name: "inspect",
            description: "界".repeat(11_000_000),
            inputSchema: { type: "object" },
          },
        ],
      }),
      "not a published StepFun quota",
    )
  })

  it("admits the exact local byte budget but rejects one byte over", async () => {
    const policy = createStepfunImagePolicy(
      request([inline(await png())]),
      "step-5-preview",
    )
    if (!policy) throw new Error("Missing policy")
    expect(() => policy.validateBody("a".repeat(31_999_998))).not.toThrow()
    expect(() => policy.validateBody("a".repeat(31_999_999))).toThrow(
      "local 32 MB",
    )
  })

  it("fails unknown StepFun vision models rather than guessing a policy", async () => {
    failure(
      await run(request([inline(await png())], "step-future")),
      "only for the documented step-5-preview",
    )
  })

  it.each([
    endpoint,
    "https://api.stepfun.ai/v1",
  ])("discovers and resolves the native model at %s without alias or relay inheritance", async (baseURL) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "step-5-preview" }, { id: "step-future" }],
        }),
      ),
    )
    const config = {
      name: "Custom label",
      service: "stepfun",
      baseURL,
      wireApi: "openai_chat_completions" as const,
      models: [],
    }
    const models = await discoverProviderModels(config, "test")
    const provider = createConfiguredProvider(
      "personal",
      { ...config, models },
      "test",
    )
    expect(
      provider.models.resolve({
        provider: "personal",
        model: "step-5-preview",
      }),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      efforts: ["low", "medium", "high"],
    })
    expect(
      provider.models.resolve({ provider: "personal", model: "step-future" })
        .inputModalities,
    ).toEqual(["text"])
    const relay = createConfiguredProvider(
      "relay",
      { ...config, baseURL: "https://relay.example/v1", models },
      "test",
    )
    expect(
      relay.models.resolve({ provider: "relay", model: "step-5-preview" })
        .inputModalities,
    ).toEqual(["text"])
  })

  it("keeps the local byte budget scoped to explicit direct native image requests", async () => {
    const image = inline(
      Buffer.concat([await png(1), Buffer.alloc(25_000_000)]),
    )
    const result = await run(request([image]), "https://relay.example/v1")
    expect(result.events.at(-1)?.type).toBe("response")
    const generic = await run(request([image]), endpoint, "generic")
    expect(generic.events.at(-1)?.type).toBe("response")
  })
})
