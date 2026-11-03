import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import {
  createRekaVisionPolicy,
  rekaVisionModel,
} from "../../src/runtime/reka-vision.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const endpoint = "https://api.reka.ai/v1"
afterEach(() => vi.restoreAllMocks())
function request(images: ModelImageBlock[] = []): ModelRequest {
  return {
    target: {
      provider: "personal",
      model: rekaVisionModel,
      instructionProfileId: "default",
    },
    system: [{ id: "system", revision: "1", text: "Inspect supplied images." }],
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
  flavor: "reka" | "generic" = "reka",
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
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ id: "chat_test", choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } })}\n\ndata: [DONE]\n\n`,
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
  expect(result.fetch).not.toHaveBeenCalled()
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
] as const)("serializes validated %s bytes unchanged without claiming live format acceptance", async (format) => {
  const bytes = await sharp(await png())
    .toFormat(format)
    .toBuffer()
  const input = request([inline(bytes)])
  const original = structuredClone(input)
  const result = await run(input)
  expect(result.events.at(-1)).toMatchObject({
    type: "response",
    response: {
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 100, outputTokens: 2 },
    },
  })
  const body = JSON.parse(result.bodies[0] ?? "")
  expect(body.messages).toEqual([
    { role: "system", content: "Inspect supplied images." },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/${format};base64,${bytes.toString("base64")}`,
          },
        },
      ],
    },
  ])
  expect(body).not.toHaveProperty("stream_options")
  expect(body).not.toHaveProperty("reasoning_effort")
  expect(input).toEqual(original)
})
it("sends exactly three image URLs without client downloads", async () => {
  const image: ModelImageBlock = {
    type: "image",
    mediaType: "image/png",
    file: { url: "https://example.com/a.png" },
    sizeBytes: 0,
  }
  const result = await run(request([image, image, image]))
  expect(result.events.at(-1)?.type).toBe("response")
  expect(result.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(result.bodies[0] ?? "").messages[1].content).toEqual(
    Array(3).fill({
      type: "image_url",
      image_url: { url: "https://example.com/a.png" },
    }),
  )
})
it("counts tool and prior-user images before reading any asset", async () => {
  const image: ModelImageBlock = {
    type: "image",
    mediaType: "image/png",
    file: { rolloutId: "rollout_test", path: "unused.png" },
    sizeBytes: 0,
  }
  const input: ModelRequest = {
    ...request([image]),
    messages: [
      { role: "user", content: [image, image] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call_image", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_image",
        content: [image],
      },
      { role: "user", content: [image] },
    ],
  }
  const original = structuredClone(input)
  failure(await run(input), "at most three")
  expect(input).toEqual(original)
})
it("rejects corrupt images and unsupported model IDs before inference", async () => {
  failure(await run(request([inline(Buffer.from("broken"))])), "Only PNG")
  for (const model of ["reka-flash-3", "reka-core", "reka-edge", "gemma4-26b"])
    failure(
      await run({ ...request(), target: { ...request().target, model } }),
      "reka-edge-2603",
    )
})
it.each([
  { toolChoice: { name: "inspect" } },
  { parallelToolCalls: false },
  { target: { ...request().target, effort: "high" } },
])("rejects unsupported explicit controls before inference: %j", async (control) => {
  failure(await run({ ...request(), ...control }), "Remove those overrides")
})
it.each([
  "auto",
  "none",
  "required",
] as const)("retains documented %s tool choice, max_tokens and structured output", async (toolChoice) => {
  const result = await run({
    ...request(),
    maxOutputTokens: 1024,
    toolChoice,
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    outputFormat: {
      type: "json_schema",
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "")).toMatchObject({
    max_tokens: 1024,
    tool_choice: toolChoice,
    tools: [{ type: "function", function: { name: "inspect" } }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", strict: true },
    },
  })
})
it("rejects custom tool definitions and history, strict functions, and hosted tools", async () => {
  const base = request()
  const cases: ModelRequest[] = [
    {
      ...base,
      tools: [
        {
          kind: "custom",
          name: "inspect",
          description: "Inspect",
          inputSchema: { type: "string" },
        },
      ],
    },
    {
      ...base,
      tools: [
        {
          name: "inspect",
          description: "Inspect",
          inputSchema: { type: "object" },
          strict: true,
        },
      ],
    },
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolKind: "custom",
              id: "custom",
              name: "inspect",
              input: "text",
            },
          ],
        },
      ],
    },
    {
      ...base,
      providerOptions: {
        provider: "personal",
        wireApi: "openai_chat_completions",
        body: { tools: [{ type: "web_search" }] },
      },
    },
  ]
  for (const input of cases) failure(await run(input), "function tools")
})
it("does not apply the Reka profile on relays or unbound generic connections", async () => {
  const bytes = await png()
  for (const [baseURL, flavor] of [
    ["https://relay.example/v1", "reka"],
    [endpoint, "generic"],
    ["https://api.reka.ai/proxy/v1", "reka"],
  ] as const) {
    const result = await run(
      request(Array(4).fill(inline(bytes))),
      baseURL,
      flavor,
    )
    expect(result.events.at(-1)?.type).toBe("response")
    expect(JSON.parse(result.bodies[0] ?? "")).toHaveProperty(
      "stream_options.include_usage",
      true,
    )
    expect(
      JSON.parse(result.bodies[0] ?? "").messages[1].content[0].image_url,
    ).toHaveProperty("detail", "high")
  }
})
it("bounds aggregate image encoding and UTF-8 body allocation as local safety, not a vendor quota", async () => {
  const source = await png()
  const bytes = Buffer.alloc(24_000_000)
  source.copy(bytes)
  const policy = createRekaVisionPolicy(request(), rekaVisionModel)
  await policy.prepareImage(bytes, inline(source))
  await policy.prepareImage(bytes, inline(source))
  await expect(policy.prepareImage(source, inline(source))).rejects.toThrow(
    "local 64 MB",
  )
  expect(() =>
    policy.validateBody({ text: "a".repeat(63_999_989) }, []),
  ).not.toThrow()
  expect(() =>
    policy.validateBody({ text: "a".repeat(63_999_990) }, []),
  ).toThrow("not a published Reka quota")
  expect(() =>
    policy.validateBody({ text: "界".repeat(21_333_334) }, []),
  ).toThrow("local 64 MB")
})
it("discovers only the adapted ready first-party model and reads Reka output limits", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          {
            id: rekaVisionModel,
            context_length: 16384,
            max_output_length: 8192,
            input_modalities: ["text", "image", "video"],
            supported_features: ["tools", "streaming"],
            is_ready: true,
          },
          { id: "reka-flash-3", input_modalities: ["text"] },
          { id: "gemma4-26b", input_modalities: ["text", "image"] },
          { id: "reka-future", input_modalities: ["text", "image"] },
        ],
      }),
    ),
  )
  const config = {
    name: "Account",
    service: "reka",
    baseURL: endpoint,
    wireApi: "openai_chat_completions" as const,
    models: [],
  }
  const discovered = await discoverProviderModels(config, "test")
  expect(discovered.map((model) => model.id)).toEqual([rekaVisionModel])
  const provider = createConfiguredProvider(
    "personal",
    { ...config, models: discovered },
    "test",
  )
  expect(
    provider.models.resolve({ provider: "personal", model: rekaVisionModel }),
  ).toMatchObject({
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    contextWindowTokens: 16384,
    maxOutputTokens: 8192,
    efforts: [],
    supportsCustomTools: false,
  })
  const relay = createConfiguredProvider(
    "relay",
    {
      ...config,
      baseURL: "https://relay.example/v1",
      models: [{ id: rekaVisionModel }],
    },
    "test",
  )
  expect(
    relay.models.resolve({ provider: "relay", model: rekaVisionModel })
      .inputModalities,
  ).toEqual(["text"])
})
it.each([
  { is_ready: false },
  { supported_features: ["streaming"] },
])("does not silently select unavailable or tool-less account models: %j", async (status) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ data: [{ id: rekaVisionModel, ...status }] }),
    ),
  )
  await expect(
    discoverProviderModels(
      {
        name: "Account",
        service: "reka",
        baseURL: endpoint,
        wireApi: "openai_chat_completions",
        models: [],
      },
      "test",
    ),
  ).rejects.toThrow("no chat models")
})
it.each([
  401, 404, 405,
])("does not treat HTTP %i as proof of Reka model availability", async (status) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status }),
  )
  await expect(
    discoverProviderModels(
      {
        name: "Account",
        service: "reka",
        baseURL: endpoint,
        wireApi: "openai_chat_completions",
        models: [],
      },
      "test",
    ),
  ).rejects.toThrow(`HTTP ${status}`)
})
it("admits documented sampling controls and rejects unadapted provider extensions", async () => {
  const body = {
    temperature: 0.2,
    top_p: 0.9,
    top_k: 20,
    stop: ["done"],
    seed: 123,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
  }
  const result = await run({
    ...request(),
    providerOptions: {
      provider: "personal",
      wireApi: "openai_chat_completions",
      body,
    },
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(JSON.parse(result.bodies[0] ?? "")).toMatchObject(body)
  vi.restoreAllMocks()
  failure(
    await run({
      ...request(),
      providerOptions: {
        provider: "personal",
        wireApi: "openai_chat_completions",
        body: { thinking: { type: "enabled" } },
      },
    }),
    "does not document the thinking",
  )
})
it("rejects PDF content at the native wire boundary", async () => {
  failure(
    await run({
      ...request(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              name: "file.pdf",
              mediaType: "application/pdf",
              file: { rolloutId: "rollout_test", path: "file.pdf" },
              sizeBytes: 0,
            },
          ],
        },
      ],
    }),
    "PDF input",
  )
})
