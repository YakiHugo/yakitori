import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createNvidiaImagePolicy } from "../../src/runtime/nvidia-image-policy.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const model = "nvidia/nemotron-3.5-super-vl-120b-a12b"
const endpoint = "https://integrate.api.nvidia.com/v1"
afterEach(() => vi.restoreAllMocks())

function request(images: ModelImageBlock[] = []): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [
      { id: "system", revision: "1", text: "Keep the system instruction." },
    ],
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
      height: 20,
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
  flavor: "nvidia" | "generic" = "nvidia",
  status = 200,
) {
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`${baseURL.replace(/\/$/, "")}/chat/completions`)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test",
      )
      if (typeof init?.body !== "string") throw new Error("Missing body")
      bodies.push(init.body)
      if (status !== 200)
        return new Response(
          JSON.stringify({ error: { message: "Invalid image" } }),
          { status },
        )
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { reasoning_content: "Inspecting." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ id: "chat_test", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const events: ModelStreamEvent[] = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "test",
    baseURL,
    model,
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
] as const)("preserves original %s bytes, source MIME and system instructions", async (format) => {
  const bytes = await sharp(await png())
    .toFormat(format)
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const input = request([inline(bytes)])
  const original = structuredClone(input)
  const result = await run(input)
  expect(result.events.at(-1)).toMatchObject({
    type: "response",
    response: { usage: { inputTokens: 12, outputTokens: 3 } },
  })
  const body = JSON.parse(result.bodies[0] ?? "")
  expect(body.messages[0]).toEqual({
    role: "system",
    content: "Keep the system instruction.",
  })
  expect(body.messages[1].content[0]).toEqual({
    type: "image_url",
    image_url: {
      url: `data:image/${format};base64,${bytes.toString("base64")}`,
      detail: "high",
    },
  })
  expect(body.stream_options).toEqual({ include_usage: true })
  expect(result.events).toContainEqual({
    type: "reasoning_delta",
    text: "Inspecting.",
  })
  expect(input).toEqual(original)
})

it("leaves remote image fetching to NVIDIA without imposing the Playground image count", async () => {
  const image: ModelImageBlock = {
    type: "image",
    mediaType: "image/png",
    file: { url: "https://example.com/a.png" },
    sizeBytes: 0,
  }
  const result = await run(request(Array(9).fill(image)))
  expect(result.events.at(-1)?.type).toBe("response")
  expect(result.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(result.bodies[0] ?? "").messages[1].content).toHaveLength(9)
  expect(
    JSON.parse(result.bodies[0] ?? "").messages[1].content[0].image_url,
  ).toEqual({ url: "https://example.com/a.png", detail: "high" })
})

it("reads stored assets through the same original-byte policy", async () => {
  const bytes = await png()
  const input: ModelRequest = {
    ...request([
      {
        type: "image",
        mediaType: "image/jpeg",
        file: { rolloutId: "rollout_test", path: "image.png" },
        sizeBytes: bytes.length,
      },
    ]),
    assets: { read: async () => bytes },
  }
  const result = await run(input)
  expect(result.events.at(-1)?.type).toBe("response")
  expect(
    JSON.parse(result.bodies[0] ?? "").messages[1].content[0].image_url.url,
  ).toBe(`data:image/png;base64,${bytes.toString("base64")}`)
})

it("rejects undecodable and undocumented GIF input without inference", async () => {
  failure(await run(request([inline(Buffer.from("broken"))])), "Only PNG")
  const source = await png()
  failure(
    await run(request([inline(source.subarray(0, 40))])),
    "unable to decode",
  )
  failure(
    await run(request([inline(await sharp(source).gif().toBuffer())])),
    "JPEG, PNG, and WebP only",
  )
})

it("bounds accumulated encoding and the complete UTF-8 request without claiming a vendor quota", async () => {
  const source = await png()
  const policy = createNvidiaImagePolicy(request([inline(source)]))
  if (!policy) throw new Error("Missing policy")
  await expect(policy.prepareImage(Buffer.alloc(24_000_001))).rejects.toThrow(
    "local 32 MB",
  )
  expect(() => policy.validateBody({ text: "界".repeat(10_666_667) })).toThrow(
    "not a published NVIDIA quota",
  )
  const largeInput = request([inline(source)])
  failure(
    await run({
      ...largeInput,
      system: [{ id: "system", revision: "1", text: "界".repeat(10_666_667) }],
    }),
    "local 32 MB",
  )
})

it.each([
  "none",
  "low",
  "high",
])("sends the documented %s effort and output, schema and function controls", async (effort) => {
  const input: ModelRequest = {
    ...request(),
    target: { ...request().target, effort },
    maxOutputTokens: 131072,
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
    toolChoice: { name: "inspect" },
    parallelToolCalls: false,
    outputFormat: {
      type: "json_schema",
      name: "answer",
      schema: { type: "object" },
    },
  }
  const result = await run(input)
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "")).toMatchObject({
    reasoning_effort: effort,
    max_tokens: 131072,
    parallel_tool_calls: false,
    tool_choice: { type: "function", function: { name: "inspect" } },
    response_format: { type: "json_schema" },
    tools: [{ type: "function" }],
  })
})

it.each([
  {
    target: {
      ...request().target,
      model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    },
  },
  { target: { ...request().target, effort: "medium" } },
  { maxOutputTokens: 131073 },
  {
    providerOptions: {
      provider: "personal",
      wireApi: "openai_chat_completions" as const,
      body: { chat_template_kwargs: { enable_thinking: false } },
    },
  },
  {
    providerOptions: {
      provider: "personal",
      wireApi: "openai_chat_completions" as const,
      body: { tools: [{ type: "web_search" }] },
    },
  },
])("rejects unsupported native contracts before sending: %j", async (override) => {
  const result = await run({ ...request(), ...override })
  expect(result.bodies).toEqual([])
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { stage: "request_build", kind: "invalid_request" },
  })
})

it("does not apply native controls to a generic connection or alternate endpoint", async () => {
  const input = {
    ...request(),
    target: { ...request().target, effort: "medium" },
  }
  for (const [url, flavor] of [
    [endpoint, "generic"],
    ["https://relay.example/v1", "nvidia"],
  ] as const) {
    const result = await run(input, url, flavor)
    expect(result.events.at(-1)?.type).toBe("response")
  }
})

it("surfaces provider image rejection without retrying or transforming the original", async () => {
  const input = request([inline(await png())])
  const original = structuredClone(input)
  const result = await run(input, endpoint, "nvidia", 422)
  expect(result.fetch).toHaveBeenCalledTimes(1)
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { status: 422, stage: "connect" },
  })
  expect(input).toEqual(original)
})

it("discovers only the exact adapted model from NVIDIA's mixed catalog", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          { id: model },
          { id: `${model}-future` },
          { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
          { id: "meta/llama-3.2-90b-vision-instruct" },
        ],
      }),
    ),
  )
  const config = {
    name: "NVIDIA account",
    service: "nvidia",
    baseURL: endpoint,
    wireApi: "openai_chat_completions" as const,
    models: [],
  }
  const discovered = await discoverProviderModels(config, "test")
  expect(discovered.map((entry) => entry.id)).toEqual([model])
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
    contextWindowTokens: 262144,
    maxOutputTokens: 131072,
    efforts: ["none", "low", "high"],
    supportsCustomTools: false,
    supportsNativeToolSearch: false,
  })
  const { service: _, ...withoutService } = config
  for (const connection of [
    { ...config, baseURL: "https://relay.example/v1" },
    withoutService,
    { ...config, wireApi: "openai_responses" as const },
  ]) {
    const generic = createConfiguredProvider(
      "personal",
      { ...connection, models: [{ id: model }] },
      "test",
    )
    expect(
      generic.models.resolve({ provider: "personal", model }).inputModalities,
    ).toEqual(["text"])
  }
})
