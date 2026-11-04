import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { createAnthropicTurnTransport } from "../../src/runtime/anthropic-provider.ts"
import { anthropicCodeModels } from "../../src/runtime/anthropic-models.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const ids = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
]
afterEach(() => vi.restoreAllMocks())

function request(
  model = "claude-sonnet-5-5",
  images: ModelImageBlock[] = [],
): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [
      { id: "system", revision: "1", text: "Keep this system instruction." },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect." }, ...images],
      },
    ],
    tools: [],
    toolWireProtocol: "eager",
    continuationScope: "account-a",
  }
}
function image(bytes: Buffer): ModelImageBlock {
  return {
    type: "image",
    mediaType: "image/jpeg",
    detail: "high",
    data: bytes.toString("base64"),
  }
}
async function png(width = 2400, height = 1200) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
function streamResponse(
  transformations: unknown[] = [],
  finalTransformations?: unknown[],
) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 12, output_tokens: 0 },
        stop_reason: null,
        input_transformations: transformations,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      ...(finalTransformations === undefined
        ? {}
        : { input_transformations: finalTransformations }),
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}
async function run(
  input: ModelRequest,
  baseURL = "https://api.anthropic.com",
  transformations: unknown[] = [],
  finalTransformations?: unknown[],
) {
  const bodies: Record<string, unknown>[] = []
  const headers: Headers[] = []
  const warnings: { code: string; message: string }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe(
      `${baseURL}/v1/messages`,
    )
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test")
    headers.push(new Headers(init?.headers))
    bodies.push(JSON.parse(String(init?.body)))
    return streamResponse(transformations, finalTransformations)
  })
  const transport = createAnthropicTurnTransport({
    apiKey: "test",
    model: input.target.model,
    baseURL,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of transport.stream({
    ...input,
    onWarning: (warning) => warnings.push(warning),
  }))
    events.push(event)
  await transport.close()
  return { bodies, events, headers, warnings }
}
function sentImages(value: unknown): Buffer[] {
  if (Array.isArray(value)) return value.flatMap(sentImages)
  if (value === null || typeof value !== "object") return []
  const object = value as Record<string, unknown>
  if (object.type === "base64" && typeof object.data === "string")
    return [Buffer.from(object.data, "base64")]
  return Object.values(object).flatMap(sentImages)
}

it("exposes the exact current Claude Code list and native configured capabilities", async () => {
  expect(anthropicCodeModels.map((model) => model.id).sort()).toEqual(
    [...ids].sort(),
  )
  const provider = createConfiguredProvider(
    "personal",
    {
      name: "Personal",
      service: "anthropic",
      wireApi: "anthropic_messages",
      baseURL: "https://api.anthropic.com",
      models: ids.map((id) => ({ id })),
    },
    "test",
  )
  for (const id of ids) {
    const model = provider.models.resolve({ provider: "personal", model: id })
    expect(model.inputModalities).toEqual(["text", "image"])
    expect(model.maxOutputTokens).toBe(id.includes("4-5-") ? 64_000 : 128_000)
    expect(
      provider.models.capacity({ provider: "personal", model: id })
        ?.contextWindowTokens,
    ).toBe(id.includes("4-5-") ? 200_000 : 1_000_000)
  }
})
it.each(
  ids,
)("preserves original user and tool image bytes and system on %s", async (model) => {
  const source = await png()
  const original = request(model, [image(source)])
  const input: ModelRequest = {
    ...original,
    messages: [
      ...original.messages,
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call",
        content: [image(source)],
      },
    ],
  }
  const before = structuredClone(input)
  const result = await run(input)
  expect(result.events.at(-1)).toMatchObject({
    type: "response",
    response: { usage: { inputTokens: 12, outputTokens: 3 } },
  })
  expect(sentImages(result.bodies)).toEqual([source, source])
  expect(result.bodies[0]?.system).toEqual([
    {
      type: "text",
      text: "Keep this system instruction.",
      cache_control: { type: "ephemeral" },
    },
  ])
  expect(input).toEqual(before)
})
it.each([
  ["claude-sonnet-5-5", 2576],
  ["claude-haiku-4-5-20251001", 1568],
])("uses %s tier only when admission requires resizing", async (model, width) => {
  const source = await png(8100, 100)
  const result = await run(request(String(model), [image(source)]))
  const [outgoing] = sentImages(result.bodies)
  expect((await sharp(outgoing).metadata()).width).toBe(width)
  expect(source).not.toEqual(outgoing)
})
it.each([
  "png",
  "jpeg",
  "webp",
  "gif",
] as const)("preserves valid %s originals on high-resolution models", async (format) => {
  const source = await sharp(await png())
    .toFormat(format)
    .toBuffer()
  const result = await run(request("claude-fable-5-1", [image(source)]))
  expect(sentImages(result.bodies)).toEqual([source])
})
it.each([
  ["claude-sonnet-5-5", "between_tools"],
  ["claude-haiku-5-5", "disabled"],
  ["claude-opus-5", "disabled"],
])("maps off to exact %s thinking mode", async (model, mode) => {
  const input = request(model)
  const result = await run({
    ...input,
    target: { ...input.target, effort: "off" },
  })
  expect(result.bodies[0]?.thinking).toEqual({ type: mode })
  expect(result.bodies[0]).not.toHaveProperty("output_config")
})
it.each([
  "claude-fable-5-1",
  "claude-haiku-5-5",
])("enables summarized adaptive thinking for %s", async (model) => {
  const input = request(model)
  const result = await run({
    ...input,
    target: { ...input.target, effort: "xhigh" },
  })
  expect(result.bodies[0]).toMatchObject({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "xhigh" },
  })
})
it.each([
  { model: "claude-opus-5-5", effort: "off" },
  { model: "claude-fable-5-1", effort: "off" },
  { model: "claude-sonnet-4-6", effort: "xhigh" },
  { model: "claude-sonnet-5-5", toolChoice: "required" as const },
  { model: "claude-opus-5-5", toolChoice: { name: "inspect" } },
  { model: "claude-fable-5-1", maxOutputTokens: 128_001 },
])("rejects incompatible native controls before HTTP $model", async ({
  model,
  effort,
  ...controls
}) => {
  const input = request(model)
  const result = await run({
    ...input,
    ...controls,
    target: { ...input.target, ...(effort === undefined ? {} : { effort }) },
  })
  expect(result.bodies).toEqual([])
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "invalid_request", stage: "request_build" },
  })
})
it.each([
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
])("counts historical tool images against the 200K model limit for %s", async (model) => {
  const source = await png(1, 1)
  const input = request(model, [image(source)])
  const result = await run({
    ...input,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect prior images." }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "call",
        content: Array.from({ length: 100 }, () => image(source)),
      },
      ...input.messages,
    ],
  })
  expect(result.bodies).toEqual([])
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("image-count") },
  })
})
it("parses native discovery fields, respects explicit capability removal and retains new IDs", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: [
        {
          id: "claude-opus-5-5",
          max_input_tokens: 900_000,
          max_tokens: 90_000,
          capabilities: {
            image_input: { supported: false },
            effort: { supported: true, low: { supported: true } },
            thinking: { types: { disabled: { supported: false } } },
          },
        },
        {
          id: "future-id",
          max_input_tokens: 700_000,
          max_tokens: 20_000,
          capabilities: {
            image_input: { supported: true },
            effort: { supported: true, medium: { supported: true } },
          },
        },
        { id: "claude-sonnet-4-5-20250929", lifecycle: "retired" },
      ],
    }),
  )
  const models = await discoverProviderModels(
    {
      name: "Account",
      service: "anthropic",
      wireApi: "anthropic_messages",
      baseURL: "https://api.anthropic.com",
      models: [],
    },
    "test",
  )
  expect(models).toHaveLength(2)
  expect(models[0]).toMatchObject({
    id: "claude-opus-5-5",
    contextWindowTokens: 900_000,
    contextWindowScope: "input",
    maxOutputTokens: 90_000,
    inputModalities: ["text"],
    efforts: ["low"],
  })
  expect(models[0]).not.toHaveProperty("defaultEffort")
  expect(models[1]).toMatchObject({
    id: "future-id",
    inputModalities: ["text", "image"],
    efforts: ["medium"],
  })
})
it("does not leak native metadata into a compatible endpoint", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: [
        {
          id: "claude-opus-5-5",
          max_input_tokens: 900_000,
          capabilities: { image_input: { supported: true } },
        },
      ],
    }),
  )
  const models = await discoverProviderModels(
    {
      name: "Anthropic",
      service: "anthropic",
      wireApi: "anthropic_messages",
      baseURL: "https://relay.example",
      models: [],
    },
    "test",
  )
  expect(models).toEqual([{ id: "claude-opus-5-5", defaultVisible: true }])
})

it("uses high-resolution preparation for the complete request budget without sending an oversized trial", async () => {
  const source = Buffer.concat([await png(3000, 1000), Buffer.alloc(200_000)])
  const input = request("claude-opus-5-5", [image(source)])
  const result = await run({
    ...input,
    system: [{ id: "large", revision: "1", text: "a".repeat(31_900_000) }],
  })
  expect(result.events.at(-1)?.type).toBe("response")
  expect(result.bodies).toHaveLength(1)
  expect(
    Buffer.byteLength(JSON.stringify(result.bodies[0])),
  ).toBeLessThanOrEqual(32_000_000)
  expect((await sharp(sentImages(result.bodies)[0]).metadata()).width).toBe(
    2576,
  )
})
it("leaves remote image fetching to Anthropic", async () => {
  const input = request("claude-haiku-5-5", [
    {
      type: "image",
      mediaType: "image/png",
      detail: "high",
      file: { url: "https://images.example/source.png" },
      sizeBytes: 0,
    },
  ])
  const result = await run(input)
  expect(result.bodies).toHaveLength(1)
  expect(JSON.stringify(result.bodies)).toContain(
    '"type":"url","url":"https://images.example/source.png"',
  )
})
it("refuses Sonnet 5.5 disabled and off display controls before sending", async () => {
  for (const [effort, thinking] of [
    [undefined, { type: "disabled" }],
    ["off", { display: "summarized" }],
  ] as const) {
    const input = request()
    const result = await run({
      ...input,
      target: { ...input.target, ...(effort === undefined ? {} : { effort }) },
      providerOptions: {
        provider: "personal",
        wireApi: "anthropic_messages",
        body: { thinking },
      },
    })
    expect(result.bodies).toEqual([])
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
  }
})

function reasoningHistory(model = "claude-sonnet-5-5"): ModelRequest {
  const input = request(model)
  return {
    ...input,
    messages: [
      { role: "user", content: [{ type: "text", text: "First request" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Original reasoning" },
          { type: "text", text: "Prior answer" },
        ],
        native: [
          {
            provider: "personal",
            model: "claude-sonnet-5-5",
            wireApi: "anthropic_messages",
            scope: "account-a",
            value: {
              type: "thinking",
              thinking: "Original reasoning",
              signature: "signed-original",
            },
          },
          {
            provider: "personal",
            model: "claude-sonnet-5-5",
            wireApi: "anthropic_messages",
            scope: "account-a",
            value: { type: "text", text: "Prior answer" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ],
  }
}
it("retains unchanged signed history and enables only the official binding fallback", async () => {
  const input = reasoningHistory()
  const before = structuredClone(input)
  const result = await run(input)
  expect(result.headers[0]?.get("anthropic-beta")).toContain(
    "thinking-binding-controls-2026-08-01",
  )
  expect(result.bodies[0]?.thinking).toMatchObject({
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  })
  expect(JSON.stringify(result.bodies[0]?.messages)).toContain(
    "signed-original",
  )
  expect(result.warnings).toEqual([])
  expect(input).toEqual(before)
})
it("reports actual prefix losses and final server-fallback transformations without duplicate warnings", async () => {
  const input = reasoningHistory()
  const first = {
    type: "thinking_dropped",
    reason: "prefix_binding_mismatch",
    path: "messages.1.content.0",
  }
  const second = {
    type: "thinking_dropped",
    reason: "model_binding_mismatch",
    path: "messages.3.content.0",
  }
  const result = await run(
    {
      ...input,
      system: [{ id: "changed", revision: "2", text: "Changed instructions" }],
    },
    "https://api.anthropic.com",
    [first],
    [first, second],
  )
  expect(result.warnings).toHaveLength(2)
  expect(
    result.warnings.every(
      (warning) =>
        warning.code === "anthropic.thinking_transformed" &&
        warning.message.includes("extra tokens"),
    ),
  ).toBe(true)
  const response = result.events.at(-1)
  expect(response).toMatchObject({
    type: "response",
    response: {
      nativeMetadata: { value: { input_transformations: [first, second] } },
    },
  })
  expect(JSON.stringify(result.bodies[0]?.messages)).toContain(
    "signed-original",
  )
})
it.each([
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
])("projects reasoning out only for %s off and reports the loss", async (model) => {
  const input = reasoningHistory(model)
  const before = structuredClone(input)
  const result = await run({
    ...input,
    target: { ...input.target, effort: "off" },
  })
  expect(JSON.stringify(result.bodies[0]?.messages)).not.toContain(
    "signed-original",
  )
  expect(result.bodies[0]).not.toHaveProperty("thinking.block_binding")
  expect(result.warnings).toEqual([
    expect.objectContaining({
      code: "anthropic.thinking_not_replayed",
      message: expect.stringContaining("extra tokens"),
    }),
  ])
  expect(input).toEqual(before)
})
it("reports cross-model projection without relaying opaque signed reasoning", async () => {
  const result = await run(reasoningHistory("claude-opus-5-5"))
  expect(JSON.stringify(result.bodies[0]?.messages)).not.toContain(
    "signed-original",
  )
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]?.code).toBe("anthropic.thinking_not_replayed")
})
it("ignores unknown transformation types and reasons without guessing", async () => {
  const result = await run(reasoningHistory(), "https://api.anthropic.com", [
    { type: "future", reason: "prefix_binding_mismatch" },
    { type: "thinking_dropped", reason: "future" },
  ])
  expect(result.warnings).toEqual([])
})
it("does not enable binding controls on older models or a compatible endpoint", async () => {
  for (const [model, endpoint] of [
    ["claude-sonnet-4-6", "https://api.anthropic.com"],
    ["claude-sonnet-5-5", "https://relay.example"],
  ]) {
    const result = await run(request(model), endpoint)
    expect(result.headers[0]?.get("anthropic-beta")).toBeNull()
    expect(result.bodies[0]).not.toHaveProperty("thinking.block_binding")
  }
})
