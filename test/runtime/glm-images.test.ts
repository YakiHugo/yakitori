import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createGlmImagePolicy } from "../../src/runtime/glm-image-policy.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

const nativeURL = "https://api.z.ai/api/paas/v4/"
const model = "glm-5.3-flash"
const png = (width = 32, height = 32) =>
  sharp({ create: { width, height, channels: 3, background: "red" } })
    .png()
    .toBuffer()
const inline = (bytes: Buffer): ModelImageBlock => ({
  type: "image",
  mediaType: "image/png",
  data: bytes.toString("base64"),
})
const request = (messages: readonly ModelMessage[]): ModelRequest => ({
  target: { provider: "personal", model, instructionProfileId: "default" },
  system: [],
  tools: [],
  toolWireProtocol: "eager",
  messages,
})
const response = () =>
  new Response(
    'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )

afterEach(() => vi.restoreAllMocks())

async function run(input: ModelRequest) {
  const bodies: string[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return response()
    })
  const events = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "unused",
    baseURL: nativeURL,
    model,
    flavor: "glm",
  })(input))
    events.push(event)
  return { bodies, events, fetch }
}

describe("native Z.AI GLM vision", () => {
  it("offers the verified vision model during setup/discovery without changing the text default", async () => {
    const configuration = {
      name: "GLM",
      service: "glm",
      wireApi: "openai_chat_completions" as const,
      baseURL: nativeURL,
      models: [],
    }
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "glm-5.3" }, { id: model }, { id: "glm-4.6v" }],
        }),
      ),
    )
    const models = await discoverProviderModels(configuration, "unused")
    expect(models.find((entry) => entry.id === model)).toMatchObject({
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      efforts: ["low", "high", "max"],
    })
    expect(
      models.find((entry) => entry.id === "glm-5.3")?.inputModalities,
    ).toBeUndefined()
    expect(
      models.find((entry) => entry.id === "glm-4.6v")?.inputModalities,
    ).toBeUndefined()
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: model }] })),
    )
    expect(
      (
        await discoverProviderModels(
          { ...configuration, baseURL: "https://relay.example/v1" },
          "unused",
        )
      )[0]?.inputModalities,
    ).toBeUndefined()
    fetch.mockResolvedValue(new Response("", { status: 404 }))
    const fallback = await discoverProviderModels(configuration, "unused")
    expect(fallback[0]?.id).toBe("glm-5.3")
    expect(
      fallback.find((entry) => entry.id === model)?.inputModalities,
    ).toContain("image")
  })

  it.each([
    nativeURL,
    "https://relay.example/v1",
    "https://api.z.ai/api/coding/paas/v4/",
  ])("declares only verified native vision, preserving text-only GLM and endpoint separation (%s)", async (baseURL) => {
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "Editable GLM",
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL,
        models: [
          { id: "glm-5.3" },
          { id: model },
          { id: "glm-4.6v" },
          { id: "glm-5.3-flash-unverified" },
        ],
      },
      "unused",
    )
    try {
      const models = await provider.models.listModels()
      for (const entry of models)
        expect(entry.inputModalities.includes("image")).toBe(
          baseURL === nativeURL && entry.model === model,
        )
      if (baseURL === nativeURL)
        expect(models.find((entry) => entry.model === model)?.efforts).toEqual([
          "low",
          "high",
          "max",
        ])
    } finally {
      await provider.close?.()
    }
  })

  it.each([
    { baseURL: nativeURL, selected: model, preserve: true },
    { baseURL: "https://relay.example/v1", selected: model, preserve: false },
    {
      baseURL: nativeURL,
      selected: "glm-5.3-flash-unverified",
      preserve: false,
    },
  ])("captures native history/tool image delegation and wire format ($baseURL, $selected)", async ({
    baseURL,
    selected,
    preserve,
  }) => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return response()
    })
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "GLM",
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL,
        models: [{ id: selected, inputModalities: ["text", "image"] }],
      },
      "unused",
    )
    const turn = createProviderRegistry({ personal: provider })
      .createClient()
      .startTurn("personal")
    const selection = { provider: "personal", model: selected }
    const configuration = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/tmp",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "glm-image",
      },
      provider.models,
    ).resolveStep(selection, provider.models)
    const step = captureStepContext({
      registry: createToolRegistry([]),
      configuration,
      ...(turn.serviceId === undefined ? {} : { serviceId: turn.serviceId }),
      ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    })
    const bytes = await png(3000, 20)
    const block = inline(bytes)
    const history: ModelMessage[] = [
      { role: "user", content: [block] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call_1", name: "inspect", input: {} },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: [block] },
      { role: "user", content: [{ type: "text", text: "Inspect again" }] },
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
        ...request(messages),
        target: step.target,
      }))
        events.push(event)
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({
        type: "response",
      })
      const body = JSON.parse(bodies[0] ?? "{}")
      const images: { url: string; detail?: string }[] = body.messages.flatMap(
        (message: { content: string | { image_url?: { url: string } }[] }) =>
          Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                part.image_url ? [part.image_url] : [],
              )
            : [],
      )
      expect(images).toHaveLength(2)
      for (const image of images) {
        const data = image.url.split(",")[1] ?? ""
        expect(
          (await sharp(Buffer.from(data, "base64")).metadata()).width,
        ).toBe(3000)
        if (preserve) {
          expect(data).toBe(bytes.toString("base64"))
          expect(image).not.toHaveProperty("detail")
        }
      }
      expect(history[0]?.content).toEqual([block])
    } finally {
      await step.toolRouter.release()
      await turn.close()
      await provider.close?.()
    }
  })

  it("sniffs MIME, preserves pixels and accepts the 6000-pixel dimension boundary", async () => {
    const bytes = await png(6000, 1)
    const prepared = await createGlmImagePolicy(request([])).prepareImage(
      bytes,
      { ...inline(bytes), mediaType: "image/webp" },
    )
    expect(prepared).toMatchObject({
      mediaType: "image/png",
      data: bytes.toString("base64"),
    })
    const tooWide = await png(6001, 1)
    await expect(
      createGlmImagePolicy(request([])).prepareImage(tooWide, inline(tooWide)),
    ).rejects.toThrow("6000")
  })

  it.each([
    "gif",
    "webp",
  ] as const)("rejects unsupported actual %s pixels before inference", async (format) => {
    const bytes = await sharp(await png())
      .toFormat(format)
      .toBuffer()
    const result = await run(
      request([{ role: "user", content: [inline(bytes)] }]),
    )
    expect(result.fetch).not.toHaveBeenCalled()
    expect(result.events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        stage: "request_build",
        message: expect.stringContaining("PNG and JPEG"),
      },
    })
  })

  it("enforces conservative encoded size without rewriting originals", async () => {
    const small = await png()
    const below = Buffer.concat([small, Buffer.alloc(3_749_982 - small.length)])
    const above = Buffer.concat([below, Buffer.alloc(1)])
    const policy = createGlmImagePolicy(request([]))
    expect((await policy.prepareImage(below, inline(below))).data).toBe(
      below.toString("base64"),
    )
    await expect(policy.prepareImage(above, inline(above))).rejects.toThrow(
      "under-5-MB",
    )
    expect(above.length).toBe(3_749_983)
  })

  it("bounds image count before reading assets and cumulative bytes before later assets", async () => {
    const small = await png()
    const bytes = Buffer.concat([small, Buffer.alloc(3_000_000 - small.length)])
    const asset: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      file: { rolloutId: "rollout_test", path: "large.png" },
      sizeBytes: bytes.length,
    }
    const read = vi.fn(async () => bytes)
    const tooMany = await run({
      ...request([
        { role: "user", content: Array.from({ length: 151 }, () => asset) },
      ]),
      assets: { read },
    })
    expect(read).not.toHaveBeenCalled()
    expect(tooMany.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(tooMany.events)).toContain("local 150-image")
    const cumulative = await run({
      ...request([
        {
          role: "user",
          content: Array.from({ length: 10 }, () => ({ ...asset })),
        },
      ]),
      assets: { read },
    })
    expect(read).toHaveBeenCalledTimes(8)
    expect(cumulative.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(cumulative.events)).toContain("local 32 MB")
  })

  it("counts final UTF-8 tools/text with exact boundary and early overflow stop", async () => {
    const block = inline(await png())
    const policy = createGlmImagePolicy(
      request([{ role: "user", content: [block] }]),
    )
    const body = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image_url" as const,
              image_url: { url: `data:image/png;base64,${block.data}` },
            },
          ],
        },
      ],
      tools: [{ description: '界\n"🙂' }],
      padding: "",
    }
    body.padding = "a".repeat(
      32_000_000 - Buffer.byteLength(JSON.stringify(body), "utf8"),
    )
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(32_000_000)
    expect(() => policy.validateBody(body)).not.toThrow()
    body.padding += "a"
    expect(() => policy.validateBody(body)).toThrow("local 32 MB")
    body.padding += "overflow"
    let lateReads = 0
    Object.defineProperty(body, "later", {
      enumerable: true,
      get() {
        lateReads += 1
        throw new Error("Must not serialize after overflow")
      },
    })
    expect(() => policy.validateBody(body)).toThrow("local 32 MB")
    expect(lateReads).toBe(0)
  })

  it("leaves external URL fetching to Z.AI instead of downloading on the user's host", async () => {
    const calls: string[] = []
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      calls.push(String(url))
      bodies.push(String(options?.body))
      return response()
    })
    const url = "https://example.com/image.png"
    const input = request([
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            file: { url },
            sizeBytes: 0,
          },
        ],
      },
    ])
    const events = []
    for await (const event of createChatCompletionsProvider({
      apiKey: "unused",
      model,
      baseURL: nativeURL,
      flavor: "glm",
    })(input))
      events.push(event)
    expect(calls).toEqual(["https://api.z.ai/api/paas/v4/chat/completions"])
    expect(JSON.parse(bodies[0] ?? "{}").messages[0].content).toEqual([
      { type: "image_url", image_url: { url } },
    ])
    expect(events.at(-1)).toMatchObject({ type: "response" })
  })
})
