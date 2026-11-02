import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.unstubAllGlobals())
const configuration = {
  name: "Personal",
  service: "minimax",
  baseURL: "https://api.minimax.io/v1",
  wireApi: "openai_chat_completions" as const,
  models: [],
}
function request(
  data = pngImageBase64,
  model = "MiniMax-M3.1-Flash",
): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    continuationScope: "account",
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", data, detail: "high" },
        ],
      },
    ],
  }
}
async function collect(
  input: ModelRequest,
  flavor: "minimax" | "generic" = "minimax",
) {
  const events: ModelStreamEvent[] = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "unused",
    model: input.target.model,
    baseURL: configuration.baseURL,
    flavor,
  })(input))
    events.push(event)
  return events
}
function capture() {
  const bodies: Record<string, unknown>[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(
      'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  vi.stubGlobal("fetch", fetch)
  return { bodies, fetch }
}

describe("MiniMax vision", () => {
  it("binds vendor behavior only to its explicit official Chat endpoint", () => {
    expect(resolveProviderBackend(configuration).chatCompletionsFlavor).toBe(
      "minimax",
    )
    expect(
      resolveProviderBackend({
        ...configuration,
        baseURL: "https://relay.example/v1",
      }).chatCompletionsFlavor,
    ).toBe("generic")
    expect(
      resolveProviderBackend({
        baseURL: configuration.baseURL,
        wireApi: configuration.wireApi,
      }).chatCompletionsFlavor,
    ).toBe("generic")
  })
  it("fills exact catalog omissions without granting vision to M2 or unknown IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "MiniMax-M3" },
                { id: "MiniMax-M3.1-Flash" },
                { id: "MiniMax-M2.7" },
                { id: "MiniMax-M3-future" },
              ],
            }),
          ),
      ),
    )
    const models = await discoverProviderModels(configuration, "unused")
    expect(models.find((m) => m.id === "MiniMax-M3")).toMatchObject({
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_000_000,
      imageDetailModes: ["high"],
    })
    expect(models.find((m) => m.id === "MiniMax-M3.1-Flash")).toMatchObject({
      defaultEffort: "max",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    })
    expect(
      models.find((m) => m.id === "MiniMax-M2.7")?.inputModalities,
    ).toBeUndefined()
    expect(
      models.find((m) => m.id === "MiniMax-M3-future")?.inputModalities,
    ).toBeUndefined()
    const relay = await discoverProviderModels(
      { ...configuration, baseURL: "https://relay.example/v1" },
      "unused",
    )
    expect(relay.every((m) => m.inputModalities === undefined)).toBe(true)
    expect(
      providerServices.find((s) => s.id === "minimax")?.models[0]?.id,
    ).toBe("MiniMax-M3.1-Flash")
  })
  it.each([
    "MiniMax-M3",
    "MiniMax-M3.1-Flash",
  ])("preserves >2048px source bytes for %s with vendor-valid high detail", async (model) => {
    const bytes = await sharp({
      create: { width: 3000, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
    const { bodies } = capture()
    const events = await collect(request(bytes.toString("base64"), model))
    expect(events.at(-1)?.type).toBe("response")
    expect(bodies[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${bytes.toString("base64")}`,
              detail: "high",
            },
          },
        ],
      },
    ])
  })
  it("keeps tool images after the complete result batch and preserves their bytes", async () => {
    const { bodies } = capture()
    const input = request()
    const events = await collect({
      ...input,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "a",
              name: "read",
              input: {},
            },
            {
              type: "tool_call",
              id: "b",
              name: "read",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "a",
          content: [
            { type: "image", mediaType: "image/png", data: pngImageBase64 },
          ],
        },
        {
          role: "tool",
          toolCallId: "b",
          content: [{ type: "text", text: "done" }],
        },
      ],
    })
    expect(events.at(-1)?.type).toBe("response")
    const messages = bodies[0]?.messages as { role: string; content: unknown }[]
    expect(messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
    ])
    expect(messages[3]?.content).toContainEqual({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${pngImageBase64}`,
        detail: "high",
      },
    })
  })
  it("rejects corrupt inline images before inference and respects cancellation", async () => {
    const { fetch } = capture()
    expect(
      (
        await collect(
          request(
            Buffer.from(pngImageBase64, "base64")
              .subarray(0, 24)
              .toString("base64"),
          ),
        )
      ).at(-1),
    ).toMatchObject({ type: "failure", failure: { kind: "invalid_request" } })
    expect(
      await collect({ ...request(), signal: AbortSignal.abort() }),
    ).toEqual([{ type: "cancelled" }])
    expect(fetch).not.toHaveBeenCalled()
  })
  it("rejects oversized images and unsupported models before a network call", async () => {
    const { fetch } = capture()
    for (const input of [
      request(Buffer.alloc(10_000_001).toString("base64")),
      request(pngImageBase64, "MiniMax-M2.7"),
    ]) {
      expect(await collect(input)).toEqual([
        expect.objectContaining({
          type: "failure",
          failure: expect.objectContaining({
            kind: "invalid_request",
            stage: "request_build",
          }),
        }),
      ])
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it("rejects aggregate encoded image bytes even when each image fits", async () => {
    const { fetch } = capture()
    const source = Buffer.from(pngImageBase64, "base64")
    const bytes = Buffer.alloc(9_600_000)
    source.copy(bytes)
    const image = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: bytes.toString("base64"),
    }
    const input = request()
    const events = await collect({
      ...input,
      messages: [
        { role: "user", content: Array.from({ length: 6 }, () => image) },
      ],
    })
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        message: expect.stringContaining("64 MB"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("surfaces provider context overflow without retrying or mutating image history", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: "context length exceeded",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetch)
    const input = request()
    const original = JSON.stringify(input.messages)
    const events = await collect(input)
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        status: 400,
        providerCode: "context_length_exceeded",
      },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(input.messages)).toBe(original)
  })
  it("bounds complete UTF-8 request including non-image text", async () => {
    const { fetch } = capture()
    const input = request()
    const events = await collect({
      ...input,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "界".repeat(21_333_334) }],
        },
      ],
    })
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        message: expect.stringContaining("64 MB"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("resolves stored image sources without modifying source bytes", async () => {
    const { bodies } = capture()
    const bytes = Buffer.from(pngImageBase64, "base64")
    const input = request()
    const events = await collect({
      ...input,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              file: { url: "https://example.test/image.png" },
              sizeBytes: bytes.length,
            },
          ],
        },
      ],
      assets: { read: async () => bytes },
    })
    expect(events.at(-1)?.type).toBe("response")
    expect(JSON.stringify(bodies[0])).toContain(
      `data:image/png;base64,${pngImageBase64}`,
    )
  })
})
