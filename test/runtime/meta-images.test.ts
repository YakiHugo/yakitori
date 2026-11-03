import sharp from "sharp"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import {
  prepareMetaImage,
  validateMetaImageRequest,
} from "../../src/runtime/meta-image-policy.ts"

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
    model: "muse-spark-1.3",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text }, block] }],
  tools: [],
  toolWireProtocol: "eager",
})

describe("direct Meta images", () => {
  it("enables only the known native model, not relays or similar names", async () => {
    const backend = resolveProviderBackend({
      service: "meta",
      wireApi: "openai_chat_completions",
      baseURL: "https://api.meta.ai/v1",
    })
    expect(backend.chatCompletionsFlavor).toBe("meta")
    const configured = createConfiguredProvider(
      "personal",
      {
        name: "Editable account",
        service: "meta",
        wireApi: "openai_chat_completions",
        baseURL: "https://api.meta.ai/v1",
        models: [
          { id: "muse-spark-1.3" },
          { id: "muse-wonder-1.0" },
          { id: "muse-spark-1.3-unverified" },
        ],
      },
      "unused",
    )
    const manager = configured.models
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "muse-spark-1.3",
      )?.inputModalities,
    ).toContain("image")
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "muse-wonder-1.0",
      ),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_048_576,
    })
    for (const endpoint of [
      {
        baseURL: "https://api.meta.ai/v1/proxy",
        wireApi: "openai_chat_completions" as const,
      },
      {
        baseURL: "https://api.meta.ai/v1",
        wireApi: "openai_responses" as const,
      },
      {
        baseURL: "https://api.meta.ai/v1?proxy=1",
        wireApi: "openai_chat_completions" as const,
      },
    ])
      expect(
        resolveProviderBackend({ service: "meta", ...endpoint }).serviceId,
      ).toBeUndefined()
    expect(
      (await manager.listModels()).find(
        (model) => model.model === "muse-spark-1.3-unverified",
      )?.inputModalities,
    ).not.toContain("image")
    expect(
      resolveProviderBackend({
        service: "meta",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
      }).serviceId,
    ).toBeUndefined()
    const relay = createConfiguredProvider(
      "personal",
      {
        name: "Meta",
        service: "meta",
        wireApi: "openai_chat_completions",
        baseURL: "https://relay.example/v1",
        models: [{ id: "muse-spark-1.3" }],
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
    { native: true, model: "muse-spark-1.3" },
    { native: true, model: "muse-wonder-1.0" },
    { native: false, model: "muse-spark-1.3" },
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
        name: "Meta label is not identity",
        service: "meta",
        wireApi: "openai_chat_completions",
        baseURL: native ? "https://api.meta.ai/v1" : "https://relay.example/v1",
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
        promptCacheKey: "meta-image",
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
      expect(
        payload.messages.map((message: { role: string }) => message.role),
      ).toEqual(["user", "assistant", "tool", "user", "user"])
      expect(payload.messages[2].content).toContain("call_1")
      expect(payload.messages[3].content[0].text).toContain("call_1")
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

  it.each([
    "png",
    "jpeg",
    "webp",
    "gif",
  ] as const)("preserves validated %s bytes", async (format) => {
    const bytes = await sharp({
      create: { width: 3000, height: 20, channels: 3, background: "red" },
    })
      [format]()
      .toBuffer()
    expect((await prepareMetaImage(bytes)).data).toBe(bytes.toString("base64"))
  })

  it("rejects oversized or invalid bytes without conversion", async () => {
    await expect(prepareMetaImage(Buffer.alloc(50_000_001))).rejects.toThrow(
      "50 MB",
    )
    await expect(prepareMetaImage(Buffer.from("broken"))).rejects.toThrow()
  })

  it("counts URLs and inline images together, accepting exactly 50", () => {
    const part = {
      type: "image_url" as const,
      image_url: { url: "https://example.com/picture.png" },
    }
    expect(() =>
      validateMetaImageRequest({
        messages: [{ role: "user", content: Array(50).fill(part) }],
      }),
    ).not.toThrow()
    expect(() =>
      validateMetaImageRequest({
        messages: [{ role: "user", content: Array(51).fill(part) }],
      }),
    ).toThrow("50 images")
  })

  it("rejects unknown models, image count and final JSON overflow before fetch", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Must not send"))
    const stream = createChatCompletionsProvider({
      apiKey: "unused",
      model: "muse-spark-1.3",
      baseURL: "https://api.meta.ai/v1",
      flavor: "meta",
    })
    const block = await image()
    const initial = request(block)
    const cases: ModelRequest[] = [
      {
        ...initial,
        target: { ...initial.target, model: "muse-spark-1.3-unverified" },
      },
      {
        ...initial,
        messages: [{ role: "user", content: Array(51).fill(block) }],
      },
      {
        ...initial,
        system: [
          { id: "large", revision: "1", text: "a".repeat(80 * 1024 * 1024) },
        ],
      },
    ]
    for (const input of cases) {
      const events = await Array.fromAsync(stream(input))
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({
        type: "failure",
        failure: { kind: "invalid_request", stage: "request_build" },
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
