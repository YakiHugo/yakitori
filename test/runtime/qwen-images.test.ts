import sharp from "sharp"
import { qwenEndpointPolicy } from "../../src/runtime/qwen-endpoints.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createChatCompletionsProvider,
  toChatCompletionsMessages,
} from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import {
  prepareQwenImage,
  validateQwenImageRequest,
} from "../../src/runtime/qwen-image-policy.ts"

afterEach(() => vi.restoreAllMocks())

const dashscope = {
  requestBytes: 16 * 1024 * 1024,
  requestLimit: "16 MiB DashScope",
}

const image = async (
  width = 32,
  height = 32,
): Promise<ModelImageBlock & { data: string }> => ({
  type: "image",
  mediaType: "image/png",
  data: (
    await sharp({ create: { width, height, channels: 3, background: "red" } })
      .png()
      .toBuffer()
  ).toString("base64"),
})
const request = (block: ModelImageBlock, text = "Inspect"): ModelRequest => ({
  target: {
    provider: "personal",
    model: "qwen3.8-max",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text }, block] }],
  tools: [],
  toolWireProtocol: "eager",
})

describe("direct Qwen images", () => {
  it("enables only the known native model, not relays or similar names", async () => {
    const backend = resolveProviderBackend({
      service: "qwen",
      wireApi: "openai_chat_completions",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })
    expect(backend.chatCompletionsFlavor).toBe("qwen")
    const configured = createConfiguredProvider(
      "personal",
      {
        name: "Editable account",
        service: "qwen",
        wireApi: "openai_chat_completions",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [{ id: "qwen3.8-max" }, { id: "qwen3.8-max-unverified" }],
      },
      "unused",
    )
    const manager = configured.models
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "qwen3.8-max",
      )?.inputModalities,
    ).toContain("image")
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "qwen3.8-max-unverified",
      )?.inputModalities,
    ).not.toContain("image")
    expect(
      resolveProviderBackend({
        service: "qwen",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
      }).catalogProvider,
    ).toBeUndefined()
    const relay = createConfiguredProvider(
      "personal",
      {
        name: "Qwen",
        service: "qwen",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
        models: [{ id: "qwen3.8-max" }],
      },
      "unused",
    )
    expect((await relay.models.listModels())[0]?.inputModalities).not.toContain(
      "image",
    )
    await relay.close?.()
    await configured.close?.()
  })

  it.each([
    ...[
      "qwen3.8-max",
      "qwen3.8-max-0902",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "qwen3.5-plus",
    ].map((model) => ({ native: true, model })),
    { native: false, model: "qwen3.8-max" },
    { native: true, model: "qwen3.8-max-unverified" },
  ])("projects history/tool images through the captured Turn (native=$native, model=$model)", async ({
    native,
    model,
  }) => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const provider = createConfiguredProvider(
      "arbitrary",
      {
        name: "Qwen label is not identity",
        service: "qwen",
        wireApi: "openai_chat_completions",
        baseURL: native
          ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
          : "https://relay.example/v1",
        models: [{ id: model, inputModalities: ["text", "image"] }],
      },
      "unused",
    )
    const turn = createProviderRegistry({ arbitrary: provider })
      .createClient()
      .startTurn("arbitrary")
    const selection = { provider: "arbitrary", model }
    const configuration = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/tmp",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "qwen-image",
      },
      provider.models,
    ).resolveStep(selection, provider.models)
    const step = captureStepContext({
      registry: createToolRegistry([]),
      configuration,
      ...(turn.serviceId === undefined ? {} : { serviceId: turn.serviceId }),
      ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    })
    const block = await image(3000, 20)
    const history: ModelMessage[] = [
      { role: "user" as const, content: [block] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            id: "call_1",
            name: "inspect",
            input: {},
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_1", content: [block] },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Inspect again" }],
      },
    ]
    try {
      const messages = await prepareModelMedia(history, {
        target: step.target,
        deferImagePreparation: step.deferImagePreparation,
        imageCapabilities: step.modelInfo,
        rolloutAssets: undefined,
        documentReading: step.documentReading,
        userDocumentReading: step.userDocumentReading,
      })
      const events = []
      for await (const event of turn.stream({
        ...request(block),
        target: step.target,
        messages,
      }))
        events.push(event)
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({
        type: "response",
      })
      const payload = JSON.parse(bodies[0] ?? "{}")
      const urls = payload.messages.flatMap(
        (message: {
          content: string | { type: string; image_url?: { url: string } }[]
        }) =>
          Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                part.image_url ? [part.image_url.url] : [],
              )
            : [],
      ) as string[]
      expect(urls).toHaveLength(2)
      for (const url of urls) {
        const data = url.split(",")[1] ?? ""
        expect(
          (await sharp(Buffer.from(data, "base64")).metadata()).width,
        ).toBe(3000)
        expect(data).toBe(block.data)
      }
      expect(history[0]?.content).toEqual([block])
    } finally {
      await step.toolRouter.release()
      await turn.close()
      await provider.close?.()
    }
  })

  it("preserves a valid image over 2048px without changing the source", async () => {
    const original = await image(3000, 20)
    const bytes = Buffer.from(original.data, "base64")
    const prepared = await prepareQwenImage(bytes, original)
    expect(prepared.data).toBe(original.data)
    expect(prepared.mediaType).toBe("image/png")
  })

  it.each([
    [10, 32],
    [32, 10],
    [2211, 11],
  ])("rejects unsupported geometry %ix%i", async (width, height) => {
    const original = await image(width, height)
    await expect(
      prepareQwenImage(Buffer.from(original.data, "base64"), original),
    ).rejects.toThrow("aspect ratio")
  })

  it("omits OpenAI detail on both user and tool images without changing generic serialization", async () => {
    const block = await image()
    const messages = [
      { role: "user" as const, content: [block] },
      { role: "tool" as const, toolCallId: "call_1", content: [block] },
    ]
    const qwen = JSON.stringify(
      toChatCompletionsMessages(messages, "personal", undefined, "qwen"),
    )
    expect(qwen).not.toContain('"detail"')
    expect(qwen.match(/data:image\/png;base64/g)).toHaveLength(2)
    expect(
      JSON.stringify(toChatCompletionsMessages(messages, "personal")),
    ).toContain('"detail":"high"')
  })

  it("rejects image count and data URI overflow locally", () => {
    const part = {
      type: "image_url" as const,
      image_url: { url: "https://example.com/a.png" },
    }
    expect(() =>
      validateQwenImageRequest(
        {
          messages: [
            {
              role: "user",
              content: Array(251).fill({
                ...part,
                image_url: { url: "data:image/png;base64,AAAA" },
              }),
            },
          ],
        },
        dashscope,
        "qwen3.8-max",
      ),
    ).toThrow("250-image")
    expect(() =>
      validateQwenImageRequest(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  ...part,
                  image_url: {
                    url: `data:image/png;base64,${"A".repeat(20_000_000)}`,
                  },
                },
              ],
            },
          ],
        },
        dashscope,
        "qwen3.8-max",
      ),
    ).toThrow("20 MB")
  })

  it("matches serialized UTF-8 at the exact budget and stops before later fields on overflow", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "image_url" as const,
            image_url: { url: "https://example.com/image.png" },
          },
        ],
      },
    ]
    const body = {
      messages,
      tools: [{ description: '界\n"🙂', parameters: { type: "object" } }],
      padding: "",
    }
    const limit = 16 * 1024 * 1024
    body.padding = "a".repeat(
      limit - Buffer.byteLength(JSON.stringify(body), "utf8"),
    )
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(limit)
    expect(() =>
      validateQwenImageRequest(body, dashscope, "qwen3.8-max"),
    ).not.toThrow()
    body.padding += "a"
    expect(() =>
      validateQwenImageRequest(body, dashscope, "qwen3.8-max"),
    ).toThrow("16 MiB")
    body.padding += "overflow"
    let lateReads = 0
    Object.defineProperty(body, "later", {
      enumerable: true,
      get() {
        lateReads += 1
        throw new Error("Must not serialize after overflow")
      },
    })
    expect(() =>
      validateQwenImageRequest(body, dashscope, "qwen3.8-max"),
    ).toThrow("16 MiB")
    expect(lateReads).toBe(0)
  })

  it("counts final text and images in the 16 MiB request before network", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const events = []
    for await (const event of createChatCompletionsProvider({
      apiKey: "unused",
      model: "qwen3.8-max",
      flavor: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })(request(await image(), "界".repeat(6_000_000))))
      events.push(event)
    expect(events).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          stage: "request_build",
          kind: "invalid_request",
          message: expect.stringContaining("16 MiB"),
        }),
      }),
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["qwen3.8-max", 2048],
    ["qwen3.8-max-0902", 2048],
    ["qwen3.7-plus", 2048],
    ["qwen3.6-plus", 256],
    ["qwen3.6-flash", 256],
    ["qwen3.5-plus", 256],
  ])("uses %s URL allowance without treating it as base64", (model, count) => {
    const endpoint = qwenEndpointPolicy(
      "https://maas.qwencloudapi.com/compatible-mode/v1",
    )
    if (!endpoint) throw new Error("Missing Qwen endpoint")
    const part = {
      type: "image_url" as const,
      image_url: { url: "https://example.com/image.png" },
    }
    const content = Array.from({ length: count }, () => part)
    const body = { messages: [{ role: "user" as const, content }] }
    expect(() => validateQwenImageRequest(body, endpoint, model)).not.toThrow()
    content.push(part)
    expect(() => validateQwenImageRequest(body, endpoint, model)).toThrow(
      `${count}-image`,
    )
    content.splice(250)
    content.push({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    })
    expect(() => validateQwenImageRequest(body, endpoint, model)).toThrow(
      "250-image",
    )
  })

  it("enforces the full 64 MB body budget for QwenCloud", () => {
    const endpoint = qwenEndpointPolicy(
      "https://maas.qwencloudapi.com/compatible-mode/v1",
    )
    if (!endpoint) throw new Error("Missing Qwen endpoint")
    const body = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image_url" as const,
              image_url: { url: "https://example.com/image.png" },
            },
          ],
        },
      ],
      tools: [{ description: '界\n"🙂', parameters: { type: "object" } }],
      padding: "",
    }
    body.padding = "a".repeat(
      64_000_000 - Buffer.byteLength(JSON.stringify(body), "utf8"),
    )
    expect(() =>
      validateQwenImageRequest(body, endpoint, "qwen3.8-max"),
    ).not.toThrow()
    body.padding += "a"
    expect(() =>
      validateQwenImageRequest(body, endpoint, "qwen3.8-max"),
    ).toThrow("64 MB")
  })

  it.each([
    "https://maas.qwencloudapi.com/compatible-mode/v1",
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ])("uses %s budget instead of the DashScope limit on the wire", async (baseURL) => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const block = await image(3000, 20)
    const events = []
    for await (const event of createChatCompletionsProvider({
      apiKey: "unused",
      model: "qwen3.8-flash",
      flavor: "qwen",
      baseURL,
    })({
      ...request(block, "a".repeat(17_000_000)),
      target: {
        provider: "personal",
        model: "qwen3.8-flash",
        instructionProfileId: "default",
      },
    }))
      events.push(event)
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: "response",
    })
    expect(bodies[0]).toContain(block.data)
    expect(bodies[0]).not.toContain('"detail"')
  })

  it.each([
    "qwen3.7-max",
    "qwen3-coder-plus",
    "qwen3-coder-next",
    "qwen3-max-2026-01-23",
  ])("does not send images to text-only %s even for a direct caller", async (model) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const block = await image()
    const events = []
    for await (const event of createChatCompletionsProvider({
      apiKey: "unused",
      model,
      flavor: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })({
      ...request(block),
      target: { provider: "personal", model, instructionProfileId: "default" },
    }))
      events.push(event)
    expect(events).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          stage: "request_build",
          message: expect.stringContaining("text-only"),
        }),
      }),
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends native image data without an OpenAI detail parameter", async () => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":null}]}\n\ndata: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const block = await image(3000, 20)
    const events = []
    for await (const event of createChatCompletionsProvider({
      apiKey: "unused",
      model: "qwen3.8-max",
      flavor: "qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })(request(block)))
      events.push(event)
    expect(events.some((event) => event.type === "response")).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(`data:image/png;base64,${block.data}`)
    expect(bodies[0]).not.toContain('"detail"')
  })
})
