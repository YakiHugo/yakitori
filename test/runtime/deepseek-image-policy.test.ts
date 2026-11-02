import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { deepseekImagePolicy } from "../../src/runtime/deepseek-image-policy.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"

const endpoint = "https://api.deepseek.com"
function inline(bytes: Buffer): ModelImageBlock {
  // Deliberately wrong declared MIME: the policy must detect actual content.
  return {
    type: "image",
    mediaType: "image/jpeg",
    data: bytes.toString("base64"),
    detail: "original",
  }
}
function request(
  images: ModelImageBlock[],
  model = "deepseek-flash",
): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages: [{ role: "user", content: images }],
    tools: [],
    toolWireProtocol: "eager",
  }
}
async function png(width = 3000) {
  return sharp({
    create: {
      width,
      height: 10,
      channels: 4,
      background: { r: 30, g: 50, b: 70, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
}
async function run(input: ModelRequest, baseURL = endpoint) {
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected serialized body")
      bodies.push(init.body)
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
  const provider = createChatCompletionsProvider({
    apiKey: "test",
    baseURL,
    model: input.target.model,
    flavor: "deepseek",
  })
  const events: ModelStreamEvent[] = []
  for await (const event of provider(input)) events.push(event)
  return { events, bodies, fetch }
}
function expectFailure(
  result: Awaited<ReturnType<typeof run>>,
  message: string,
) {
  expect(result.bodies).toEqual([])
  expect(result.events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      stage: "request_build",
      kind: "invalid_request",
      message: expect.stringContaining(message),
    },
  })
}
afterEach(() => vi.restoreAllMocks())

describe("direct DeepSeek Flash image input", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
    "gif",
  ] as const)("keeps %s bytes and corrects MIME without changing history", async (format) => {
    const bytes = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const input = request([inline(bytes)])
    const before = structuredClone(input)
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    expect(JSON.parse(result.bodies[0] ?? "").messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: {
        url: `data:image/${format};base64,${bytes.toString("base64")}`,
        detail: "high",
      },
    })
    expect(input).toEqual(before)
  })

  it("preserves local asset dimensions and places tool images in user messages", async () => {
    const bytes = await png()
    const image: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { rolloutId: "rollout_test", path: "large.png" },
      sizeBytes: bytes.length,
      detail: "high",
    }
    const input: ModelRequest = {
      ...request([]),
      assets: { read: async () => bytes },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call_image", name: "inspect", input: {} },
          ],
        },
        { role: "tool", toolCallId: "call_image", content: [image] },
      ],
    }
    const result = await run(input)
    expect(result.events.at(-1)?.type).toBe("response")
    const messages = JSON.parse(result.bodies[0] ?? "").messages
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${bytes.toString("base64")}`,
            detail: "high",
          },
        },
      ]),
    })
    expect(image.file).toEqual({ rolloutId: "rollout_test", path: "large.png" })
  })

  it.each([
    { count: 1, width: 8192, ok: true },
    { count: 1, width: 8193, ok: false },
    { count: 14, width: 4097, ok: true },
    { count: 15, width: 4096, ok: true },
    { count: 15, width: 4097, ok: false },
  ])("enforces dimensions for $count images of width $width", async ({
    count,
    width,
    ok,
  }) => {
    const result = await run(
      request(Array(count).fill(inline(await png(width)))),
    )
    if (ok) expect(result.events.at(-1)?.type).toBe("response")
    else expectFailure(result, "pixels per side")
  })

  it("accepts exactly 600 image occurrences", async () => {
    const result = await run(request(Array(600).fill(inline(await png(1)))))
    expect(result.events.at(-1)?.type).toBe("response")
  })

  it("bounds aggregate base64 expansion before serializing the request", async () => {
    const source = await png(1)
    const bytes = Buffer.concat([source, Buffer.alloc(19 * 1024 * 1024)])
    expectFailure(await run(request([inline(bytes), inline(bytes)])), "48 MiB")
  })

  it("checks URLs resolved from local asset storage", async () => {
    const image: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { rolloutId: "rollout_test", path: "image.png" },
      sizeBytes: 1,
    }
    const read = vi.fn().mockRejectedValue(new Error("Should not read"))
    const result = await run({
      ...request([image]),
      assets: { read, url: () => `https://example.com/${"x".repeat(8192)}` },
    })
    expectFailure(result, "8192 characters")
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects 601 occurrences before reading assets", async () => {
    const read = vi.fn().mockRejectedValue(new Error("Should not read"))
    const image: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { rolloutId: "rollout_test", path: "image.png" },
      sizeBytes: 1,
    }
    expectFailure(
      await run({ ...request(Array(601).fill(image)), assets: { read } }),
      "600 images",
    )
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects a single inline image above 32 MiB before decoding", async () => {
    expectFailure(
      await run(request([inline(Buffer.alloc(32 * 1024 * 1024 + 1))])),
      "32 MiB",
    )
  })

  it("counts UTF-8 text and tools in the complete request budget", async () => {
    const input = request([inline(await png())])
    const result = await run({
      ...input,
      system: [
        { id: "system", revision: "1", text: "界".repeat(16 * 1024 * 1024) },
      ],
    })
    expectFailure(result, "48 MiB")
  })

  it("rejects malformed images without a network call", async () => {
    expectFailure(
      await run(request([inline(Buffer.from("not an image"))])),
      "Only PNG",
    )
  })

  it("leaves remote image downloads to DeepSeek but rejects overlong URLs", async () => {
    const image: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { url: "https://example.com/image.png" },
      sizeBytes: 0,
    }
    const result = await run(request([image]))
    expect(result.fetch).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(result.bodies[0] ?? "").messages[0].content[0].image_url.url,
    ).toBe("https://example.com/image.png")
    expectFailure(
      await run(
        request([
          {
            ...image,
            file: { url: `https://example.com/${"x".repeat(8192)}` },
          },
        ]),
      ),
      "8192 characters",
    )
  })

  it("does not infer a policy for relays, aliases or text-only models", () => {
    for (const [url, model] of [
      ["https://relay.example", "deepseek-flash"],
      [endpoint, "deepseek-chat"],
      [endpoint, "deepseek-flash-future"],
    ] as const)
      expect(
        deepseekImagePolicy(url, model, request([inline(Buffer.alloc(0))])),
      ).toBeUndefined()
  })

  it("bounds exact UTF-8 serialized body sizes inclusively", async () => {
    const policy = deepseekImagePolicy(
      endpoint,
      "deepseek-flash",
      request([inline(await png())]),
    )
    if (policy === undefined) throw new Error("Expected direct image policy")
    expect(() =>
      policy.validateBody("a".repeat(48 * 1024 * 1024 - 2), []),
    ).not.toThrow()
    expect(() =>
      policy.validateBody("a".repeat(48 * 1024 * 1024 - 1), []),
    ).toThrow("48 MiB")
  })

  it("advertises documented vision only for the direct service and exact model", () => {
    const config = {
      name: "Custom name",
      service: "deepseek",
      wireApi: "openai_chat_completions" as const,
      baseURL: endpoint,
      models: [{ id: "deepseek-flash" }, { id: "deepseek-chat" }],
    }
    const provider = createConfiguredProvider("personal", config, "test")
    expect(
      provider.models.resolve({
        provider: "personal",
        model: "deepseek-flash",
      }),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      imageDetailModes: ["high", "original"],
    })
    expect(
      provider.models.resolve({ provider: "personal", model: "deepseek-chat" })
        .inputModalities,
    ).toEqual(["text"])
    const relay = createConfiguredProvider(
      "relay",
      { ...config, baseURL: "https://relay.example" },
      "test",
    )
    expect(
      relay.models.resolve({ provider: "relay", model: "deepseek-flash" })
        .inputModalities,
    ).toEqual(["text"])
  })
})
