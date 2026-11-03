import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"

afterEach(() => vi.restoreAllMocks())

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
    model: "doubao-seed-2-1-pro-260915",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text }, block] }],
  tools: [],
  toolWireProtocol: "eager",
})

describe("direct Doubao images", () => {
  it("enables only the known native model, not relays or similar names", async () => {
    const backend = resolveProviderBackend({
      service: "doubao",
      wireApi: "openai_chat_completions",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    })
    expect(backend.chatCompletionsFlavor).toBe("doubao")
    const configured = createConfiguredProvider(
      "personal",
      {
        name: "Editable account",
        service: "doubao",
        wireApi: "openai_chat_completions",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
        models: [
          { id: "doubao-seed-2-1-pro-260915" },
          { id: "doubao-seed-2-1-pro-260915-unverified" },
        ],
      },
      "unused",
    )
    const manager = configured.models
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "doubao-seed-2-1-pro-260915",
      )?.inputModalities,
    ).toContain("image")
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "doubao-seed-2-1-pro-260915-unverified",
      )?.inputModalities,
    ).not.toContain("image")
    expect(
      resolveProviderBackend({
        service: "doubao",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
      }).catalogProvider,
    ).toBeUndefined()
    const relay = createConfiguredProvider(
      "personal",
      {
        name: "Doubao",
        service: "doubao",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
        models: [{ id: "doubao-seed-2-1-pro-260915" }],
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
    { native: true, model: "doubao-seed-2-1-pro-260915" },
    { native: false, model: "doubao-seed-2-1-pro-260915" },
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
        name: "Doubao label is not identity",
        service: "doubao",
        wireApi: "openai_chat_completions",
        baseURL: native
          ? "https://ark.cn-beijing.volces.com/api/v3"
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
        promptCacheKey: "doubao-image",
      },
      provider.models,
    ).resolveStep(selection, provider.models)
    const step = captureStepContext({
      registry: createToolRegistry([]),
      configuration,
      ...(turn.serviceId === undefined ? {} : { serviceId: turn.serviceId }),
      ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    })
    const block = await image(3000, 32)
    expect(step.imageTokenEstimator?.(block, "history")).toBe(
      native ? 1280 : undefined,
    )
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
})

async function collect(input: ModelRequest) {
  const events = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "unused",
    model: input.target.model,
    flavor: "doubao",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  })(input))
    events.push(event)
  return events
}

describe("Doubao admission and native continuation", () => {
  it.each([
    [14, 32],
    [32, 14],
    [2401, 15],
  ])("rejects invalid geometry %ix%i before network", async (width, height) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const events = await collect(request(await image(width, height)))
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        stage: "request_build",
        kind: "invalid_request",
        message: expect.stringContaining("14 pixels"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects an unverified model instead of silently preparing images generically", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const input = request(await image())
    expect(
      (
        await collect({
          ...input,
          target: {
            ...input.target,
            model: `${input.target.model}-unverified`,
          },
        })
      ).at(-1),
    ).toMatchObject({
      type: "failure",
      failure: {
        stage: "request_build",
        message: expect.stringContaining("documented Seed"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects 10 MB images before decoding or network", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const block: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      data: Buffer.alloc(10_000_000).toString("base64"),
    }
    expect((await collect(request(block))).at(-1)).toMatchObject({
      type: "failure",
      failure: {
        stage: "request_build",
        message: expect.stringContaining("smaller than 10 MB"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("counts UTF-8 text in the final 64 MB body before network", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    expect(
      (await collect(request(await image(), "界".repeat(22_000_000)))).at(-1),
    ).toMatchObject({
      type: "failure",
      failure: {
        stage: "request_build",
        message: expect.stringContaining("64 MB"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    false,
    true,
  ])("keeps remote image URLs provider-owned (assets=%s)", async (withAssets) => {
    const read = vi.fn(async () => {
      throw new Error("External URLs are not owned rollout files.")
    })
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        expect(String(url)).toBe(
          "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        )
        expect(String(options?.body)).toContain("https://cdn.example/image.png")
        return new Response(
          'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      })
    const input = request({
      type: "image",
      mediaType: "image/png",
      sizeBytes: 0,
      file: { url: "https://cdn.example/image.png" },
    })
    expect(
      (
        await collect({ ...input, ...(withAssets ? { assets: { read } } : {}) })
      ).at(-1),
    ).toMatchObject({ type: "response" })
    expect(read).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("preserves the complete opaque thinking block only in scoped native history for tool continuation", async () => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        `${[
          {
            id: "reply",
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: "Summary",
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "reply",
            choices: [
              {
                index: 0,
                delta: {
                  content: "",
                  reasoning_content: "",
                  encrypted_content: "opaque-original",
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "reply",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "inspect", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const input: ModelRequest = {
      ...request(await image()),
      continuationScope: "account",
      tools: [
        {
          name: "inspect",
          description: "Inspect",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }
    const events = await collect(input)
    const response = events.find((event) => event.type === "response")
    expect(response, JSON.stringify(events)).toBeDefined()
    if (response?.type !== "response") throw new Error("Missing response")
    expect(JSON.stringify(response.response.content)).not.toContain("opaque-")
    if (response.response.native === undefined)
      throw new Error("Missing native continuation")
    const next: ModelRequest = {
      ...input,
      messages: [
        ...input.messages,
        {
          role: "assistant",
          content: response.response.content,
          native: response.response.native,
        },
        {
          role: "tool",
          toolCallId: "call_1",
          content: [{ type: "text", text: "Done" }],
        },
      ],
    }
    await collect(next)
    expect(JSON.parse(bodies[1] ?? "{}").messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        encrypted_content: "opaque-original",
        reasoning_content: "Summary",
      }),
    )
    expect(bodies[0]).toContain('"detail":"high"')
    await collect({ ...next, continuationScope: "different-account" })
    expect(bodies[2]).not.toContain("opaque-original")
  })
})
