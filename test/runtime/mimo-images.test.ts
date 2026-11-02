import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createMimoImagePolicy } from "../../src/runtime/mimo-image-policy.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const endpoint = "https://api.xiaomimimo.com/v1"
const models = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]
afterEach(() => vi.restoreAllMocks())
function request(
  images: ModelImageBlock[] = [],
  model = "mimo-v2.6-pro",
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
async function png() {
  return sharp({
    create: {
      width: 3000,
      height: 2,
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
  flavor: "mimo" | "generic" = "mimo",
  finishReason = "stop",
) {
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test",
      )
      if (typeof init?.body !== "string") throw new Error("Missing body")
      bodies.push(init.body)
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: finishReason === "repetition_truncation" ? { tool_calls: [{ index: 0, id: "call_incomplete", type: "function", function: { name: "inspect", arguments: "{}" } }] } : { content: "ok" }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
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
it.each([
  "png",
  "jpeg",
  "webp",
  "gif",
] as const)("retains original %s bytes/MIME and omits undocumented image detail", async (format) => {
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
    },
  })
  expect(input).toEqual(original)
})
it("retains animated GIF bytes without silently flattening", async () => {
  const frames = Buffer.alloc(32 * 32 * 3, 80)
  frames.fill(180, 32 * 16 * 3)
  const bytes = await sharp(frames, {
    raw: { width: 32, height: 32, channels: 3, pageHeight: 16 },
  })
    .gif({ delay: [100, 200] })
    .toBuffer()
  const result = await run(request([inline(bytes)]))
  expect(result.events.at(-1)?.type).toBe("response")
  expect(
    JSON.parse(result.bodies[0] ?? "").messages[0].content[0].image_url.url,
  ).toBe(`data:image/gif;base64,${bytes.toString("base64")}`)
})
it("does not client-download provider-addressable URLs or invent a fixed image count", async () => {
  const image: ModelImageBlock = {
    type: "image",
    mediaType: "image/png",
    file: { url: "https://example.com/a.png" },
    sizeBytes: 0,
  }
  const result = await run(request(Array(151).fill(image)))
  expect(result.events.at(-1)?.type).toBe("response")
  expect(result.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(result.bodies[0] ?? "").messages[0].content).toHaveLength(
    151,
  )
  expect(
    JSON.parse(result.bodies[0] ?? "").messages[0].content[0].image_url,
  ).toEqual({ url: "https://example.com/a.png" })
})
it("rejects corrupt bytes and unknown/retired models before inference", async () => {
  failure(await run(request([inline(Buffer.from("broken"))])), "Only PNG")
  failure(await run(request([inline(await png())], "mimo-v2.5-pro")), "retired")
  failure(await run(request([inline(await png())], "mimo-future")), "Unknown")
})
it("measures the single image boundary as encoded base64, not raw bytes", async () => {
  const source = await png()
  const exact = Buffer.alloc(37_500_000)
  source.copy(exact)
  const input = request([inline(source)])
  const policy = createMimoImagePolicy(input, "mimo-v2.6-pro")
  if (!policy) throw new Error("Missing policy")
  const image = await policy.prepareImage(exact, inline(source))
  expect(image.data?.length).toBe(50_000_000)
  await expect(
    policy.prepareImage(Buffer.alloc(37_500_001), inline(source)),
  ).rejects.toThrow("base64 string exceeds 50 MB")
})
it("bounds aggregate encoding and full UTF-8 request bytes independently of per-image quota", async () => {
  const source = await png()
  const bytes = Buffer.alloc(24_000_000)
  source.copy(bytes)
  const policy = createMimoImagePolicy(
    request([inline(source)]),
    "mimo-v2.6-pro",
  )
  if (!policy) throw new Error("Missing policy")
  await policy.prepareImage(bytes, inline(source))
  await policy.prepareImage(bytes, inline(source))
  await expect(policy.prepareImage(source, inline(source))).rejects.toThrow(
    "local 64 MB",
  )
  expect(() => policy.validateBody("a".repeat(63_999_998))).not.toThrow()
  expect(() => policy.validateBody("a".repeat(63_999_999))).toThrow(
    "not a published MiMo quota",
  )
  expect(() =>
    policy.validateBody({ tools: [{ description: "界".repeat(21_333_334) }] }),
  ).toThrow("local 64 MB")
})
it.each(
  models,
)("discovers %s vision without inheriting unknown/relay capabilities", async (model) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ data: [{ id: model }, { id: "mimo-future" }] }),
    ),
  )
  const config = {
    name: "Account",
    service: "mimo",
    baseURL: endpoint,
    wireApi: "openai_chat_completions" as const,
    models: [],
  }
  const discovered = await discoverProviderModels(config, "test")
  const provider = createConfiguredProvider(
    "personal",
    { ...config, models: discovered },
    "test",
  )
  expect(
    provider.models.resolve({ provider: "personal", model }),
  ).toMatchObject({
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    maxOutputTokens: 131072,
  })
  expect(
    provider.models.resolve({ provider: "personal", model: "mimo-future" })
      .inputModalities,
  ).toEqual(["text"])
  const relay = createConfiguredProvider(
    "relay",
    { ...config, baseURL: "https://relay.example/v1", models: discovered },
    "test",
  )
  expect(
    relay.models.resolve({ provider: "relay", model }).inputModalities,
  ).toEqual(["text"])
})
it("uses native max_completion_tokens without stream_options or invented reasoning effort", async () => {
  const result = await run({ ...request(), maxOutputTokens: 1024 })
  expect(JSON.parse(result.bodies[0] ?? "")).toMatchObject({
    max_completion_tokens: 1024,
  })
  for (const key of ["max_tokens", "stream_options", "reasoning_effort"])
    expect(JSON.parse(result.bodies[0] ?? "")).not.toHaveProperty(key)
  for (const [baseURL, flavor] of [
    ["https://relay.example/v1", "mimo"],
    [endpoint, "generic"],
  ] as const) {
    const generic = await run(
      { ...request(), maxOutputTokens: 1024 },
      baseURL,
      flavor,
    )
    expect(JSON.parse(generic.bodies[0] ?? "")).toMatchObject({
      max_tokens: 1024,
      stream_options: { include_usage: true },
    })
  }
})
it.each([
  { toolChoice: "required" as const },
  { parallelToolCalls: false },
  { target: { ...request().target, effort: "high" } },
  {
    outputFormat: {
      type: "json_schema" as const,
      name: "answer",
      schema: { type: "object" },
    },
  },
])("rejects unsupported explicit controls rather than silently ignoring them: %j", async (control) => {
  failure(await run({ ...request(), ...control }), "Remove those overrides")
})
it("rejects tool history missing native reasoning without mutating it", async () => {
  const input: ModelRequest = {
    ...request(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call_old", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_old",
        content: [{ type: "text", text: "result" }],
      },
    ],
  }
  const original = structuredClone(input)
  failure(await run(input), "original reasoning_content")
  expect(input).toEqual(original)
})
it("reports repetition truncation as incomplete rather than successful output", async () => {
  const result = await run(request(), endpoint, "mimo", "repetition_truncation")
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      kind: "protocol_error",
      providerCode: "repetition_truncation",
      serverShouldRetry: false,
      message: expect.stringContaining("repetition_truncation"),
    },
  })
  expect(result.events.some((e) => e.type === "response")).toBe(false)
})
it("allows explicitly disabled thinking with ordinary tool history", async () => {
  const result = await run({
    ...request(),
    providerOptions: {
      provider: "personal",
      wireApi: "openai_chat_completions",
      body: { thinking: { type: "disabled" } },
    },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call_old", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_old",
        content: [{ type: "text", text: "result" }],
      },
    ],
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "")).toMatchObject({
    thinking: { type: "disabled" },
  })
})
it("requires custom tools to use the function-call fallback", async () => {
  const tool = {
    kind: "custom" as const,
    name: "inspect",
    description: "Inspect",
    inputSchema: { type: "object" },
  }
  failure(await run({ ...request(), tools: [tool] }), "function tools")
  const result = await run({
    ...request(),
    tools: [{ ...tool, customInputFallbackKey: "input" }],
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "").tools[0]).toMatchObject({
    type: "function",
    function: { name: "inspect" },
  })
})
it("counts UTF-8 tool descriptions in the actual SDK request admission", async () => {
  failure(
    await run({
      ...request([inline(await png())]),
      tools: [
        {
          name: "inspect",
          description: "界".repeat(21_333_334),
          inputSchema: { type: "object" },
        },
      ],
    }),
    "local 64 MB",
  )
})
it.each(
  models,
)("sends images using the exact native model %s", async (model) => {
  const result = await run(request([inline(await png())], model))
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "").model).toBe(model)
})
it("rejects native custom-tool history even when thinking is disabled and current tools are functions", async () => {
  const input: ModelRequest = {
    ...request(),
    providerOptions: {
      provider: "personal",
      wireApi: "openai_chat_completions",
      body: { thinking: { type: "disabled" } },
    },
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_custom",
            name: "legacy",
            toolKind: "custom",
            input: "old text",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_custom",
        content: [{ type: "text", text: "old result" }],
      },
    ],
  }
  const original = structuredClone(input)
  failure(await run(input), "function tools")
  expect(input).toEqual(original)
})
