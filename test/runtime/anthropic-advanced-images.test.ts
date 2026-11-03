import Anthropic from "@anthropic-ai/sdk"
import sharp from "sharp"
import { expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createAnthropicTestStream } from "./anthropic-test-stream.ts"

async function image(
  width: number,
  height = 10,
): Promise<Extract<ModelImageBlock, { data: string }>> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  return {
    type: "image",
    mediaType: "image/png",
    data: bytes.toString("base64"),
  }
}

function request(
  block: ModelImageBlock,
  mode: "pdf" | "profile",
  model = "claude-sonnet-4-6",
): ModelRequest {
  return {
    target: {
      provider: "anthropic",
      model,
      instructionProfileId: "anthropic",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          block,
          ...(mode === "pdf"
            ? [
                {
                  type: "document" as const,
                  name: "report.pdf",
                  mediaType: "application/pdf" as const,
                  sizeBytes: 6,
                  file: { rolloutId: "rollout_test", path: "report.pdf" },
                  data: "JVBERi0x",
                },
              ]
            : []),
        ],
      },
    ],
    ...(mode === "profile"
      ? {
          providerOptions: {
            provider: "anthropic",
            wireApi: "anthropic_messages" as const,
            body: { user_profile_id: "profile-example" },
          },
        }
      : {}),
  }
}

// Capture the actual SDK HTTP body, not only arguments passed to messages.create.
async function send(input: ModelRequest) {
  const bodies: string[] = []
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected serialized SDK body")
      bodies.push(init.body)
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
    model: input.target.model,
    client,
  })
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return { bodies, events }
}

it.each([
  ["pdf", "claude-sonnet-4-6"],
  ["profile", "claude-sonnet-4-6"],
  ["pdf", "claude-opus-5-5"],
  ["profile", "claude-opus-5-5"],
] as const)("enforces known Claude dimensions before the real SDK request with %s on %s", async (mode, model) => {
  const accepted = await image(8000)
  const input = request(accepted, mode, model)
  const before = structuredClone(input)
  const sent = await send(input)
  expect(sent.events.at(-1)?.type).toBe("response")
  expect(sent.bodies).toHaveLength(1)
  const body = JSON.parse(sent.bodies[0] ?? "{}")
  const wireImage = body.messages[0].content.find(
    (part: { type: string }) => part.type === "image",
  )
  expect(wireImage.source.data).toBe(accepted.data)
  expect(
    (await sharp(Buffer.from(wireImage.source.data, "base64")).metadata())
      .width,
  ).toBe(8000)
  expect(input).toEqual(before)

  const rejectedInput = request(await image(8100), mode, model)
  const rejectedBefore = structuredClone(rejectedInput)
  const rejected = await send(rejectedInput)
  expect(rejected.bodies).toEqual([])
  expect(JSON.stringify(rejected.events)).toContain("8000 pixels")
  expect(rejectedInput).toEqual(rejectedBefore)
})

it.each([
  "pdf",
  "profile",
] as const)("enforces the known base64 image ceiling with %s", async (mode) => {
  const valid = await image(100)
  const padded = Buffer.concat([
    Buffer.from(valid.data ?? "", "base64"),
    Buffer.alloc(7_500_001),
  ])
  const input = request({ ...valid, data: padded.toString("base64") }, mode)
  const result = await send(input)
  expect(result.bodies).toEqual([])
  expect(JSON.stringify(result.events)).toContain("10 MB base64")
})

it.each([
  "pdf",
  "profile",
] as const)("counts historical image occurrences for the many-image boundary with %s", async (mode) => {
  const input = request(await image(3100), mode)
  const small = await image(10)
  const result = await send({
    ...input,
    messages: [
      { role: "user", content: Array.from({ length: 20 }, () => small) },
      ...input.messages,
    ],
  })
  expect(result.bodies).toEqual([])
  expect(JSON.stringify(result.events)).toContain("3000 pixels")
})

it("bounds aggregate native image data with SDK profile controls before calling the SDK", async () => {
  const small = await image(10)
  const bytes = Buffer.concat([
    Buffer.from(small.data ?? "", "base64"),
    Buffer.alloc(4_000_000),
  ])
  const large = { ...small, data: bytes.toString("base64") }
  const input = request(large, "profile")
  const result = await send({
    ...input,
    messages: [
      { role: "user", content: Array.from({ length: 7 }, () => large) },
    ],
  })
  expect(result.bodies).toEqual([])
  expect(JSON.stringify(result.events)).toContain("32 MB")
})

it("bounds the full advanced request rather than only its image data", async () => {
  const input = request(await image(10), "profile")
  const result = await send({
    ...input,
    system: [{ id: "large", revision: "1", text: "a".repeat(32_000_000) }],
  })
  expect(result.bodies).toEqual([])
  expect(JSON.stringify(result.events)).toContain("whole-request budget")
})

it.each([
  ["claude-sonnet-4-6", 1000, 10, true],
  ["claude-sonnet-4-6", 2000, 10, false],
  ["claude-opus-5-5", 2000, 10, true],
  ["claude-opus-5-5", 2576, 10, true],
  ["claude-opus-5-5", 2577, 10, false],
  ["claude-opus-5-5", 2000, 2000, false],
] as const)("checks %s screenshot tier before SDK serialization at %i by %i", async (model, width, height, accepted) => {
  const input = request(await image(2400), "profile")
  const screenshot = await image(width, height)
  const source = screenshot.data
  const result = await send({
    ...input,
    target: { ...input.target, model },
    providerOptions: {
      provider: "anthropic",
      wireApi: "anthropic_messages",
      body: {
        tools: [
          {
            type: "computer_20251124",
            name: "computer",
            display_width_px: width,
            display_height_px: height,
          },
        ],
      },
    },
    messages: [
      ...input.messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "screenshot",
            name: "computer",
            input: { action: "screenshot" },
          },
        ],
      },
      { role: "tool", toolCallId: "screenshot", content: [screenshot] },
    ],
  })
  expect(result.bodies).toHaveLength(accepted ? 1 : 0)
  if (accepted) {
    const body = JSON.parse(result.bodies[0] ?? "{}")
    const last = body.messages.at(-1)
    expect(last.content[0].content[0].source.data).toBe(source)
    expect(result.events.at(-1)?.type).toBe("response")
  } else {
    expect(JSON.stringify(result.events)).toContain("tool's coordinate mapping")
  }
  expect(screenshot.data).toBe(source)
})

it("does not mistake an ordinary tool image for a native computer screenshot", async () => {
  const source = await image(2400)
  const input = request(source, "profile")
  const result = await send({
    ...input,
    providerOptions: {
      provider: "anthropic",
      wireApi: "anthropic_messages",
      body: {
        tools: [
          {
            type: "computer_20251124",
            name: "computer",
            display_width_px: 1000,
            display_height_px: 10,
          },
        ],
      },
    },
    messages: [
      ...input.messages,
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "read", name: "view_image", input: {} },
        ],
      },
      { role: "tool", toolCallId: "read", content: [source] },
    ],
  })
  expect(result.bodies).toHaveLength(1)
  expect(result.events.at(-1)?.type).toBe("response")
})

it("enforces the model image-count guard with SDK profile controls", async () => {
  const small = await image(10)
  const input = request(small, "profile")
  const result = await send({
    ...input,
    target: { ...input.target, model: "claude-haiku-4-5" },
    messages: [
      { role: "user", content: Array.from({ length: 101 }, () => small) },
    ],
  })
  expect(result.bodies).toEqual([])
  expect(JSON.stringify(result.events)).toContain("image-count guard")
})
