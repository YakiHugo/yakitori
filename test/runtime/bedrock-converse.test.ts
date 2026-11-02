import { once } from "node:events"
import { createServer } from "node:http"
import sharp from "sharp"
import { fetch as bedrockFetch, Response as BedrockResponse } from "undici"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBedrockConverseProvider } from "../../src/runtime/bedrock-converse-provider.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import type {
  ModelImageBlock,
  ModelRequest,
  ModelStreamEvent,
  StreamFn,
} from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import {
  providerConfigValue,
  providersFromConfig,
  requireProviderConfiguration,
} from "../../src/server/provider-configuration.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>()
  return { ...actual, fetch: vi.fn(actual.fetch) }
})

const baseURL = "https://bedrock-runtime.us-east-1.amazonaws.com"
const model = "us.amazon.nova-2-lite-v1:0"
const config = {
  name: "Nova",
  baseURL,
  wireApi: "bedrock_converse" as const,
  service: "amazon-nova",
  authentication: "stored" as const,
  models: [{ id: model, inputModalities: ["text", "image"] as const }],
}
const options = { apiKey: "fixture-only", baseURL, model }
function request(patch: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: { provider: "nova", model, instructionProfileId: "default" },
    system: [{ id: "system", revision: "1", text: "Be helpful" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    toolWireProtocol: "eager",
    ...patch,
  }
}
async function collect(stream: StreamFn, input = request()) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream(input)) events.push(event)
  return events
}
function reply(
  content: unknown[] = [{ text: "Hello!" }],
  stopReason = "end_turn",
) {
  return Response.json({
    output: { message: { role: "assistant", content } },
    stopReason,
    usage: { inputTokens: 240, outputTokens: 10, totalTokens: 250 },
  })
}
async function image(
  format: "png" | "jpeg" | "webp" | "gif" = "png",
  width = 3000,
): Promise<Extract<ModelImageBlock, { data: string }>> {
  const bytes = await sharp({
    create: { width, height: 10, channels: 3, background: "red" },
  })
    .toFormat(format)
    .toBuffer()
  return {
    type: "image",
    mediaType: "image/jpeg",
    data: bytes.toString("base64"),
    detail: "high",
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("Bedrock Converse native adapter", () => {
  it.each([
    "png",
    "jpeg",
    "webp",
    "gif",
  ] as const)("preserves %s encoded image bytes and emits native Converse, not OpenAI", async (format) => {
    const inputImage = await image(format)
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(reply())
    const events = await collect(
      createBedrockConverseProvider({ ...options, fetchFn }),
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read this" }, inputImage],
          },
        ],
      }),
    )
    const firstCall = fetchFn.mock.calls[0]
    if (!firstCall) throw new Error("Missing request")
    const [url, init] = firstCall
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse",
    )
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer fixture-only" },
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      system: [{ text: "Be helpful" }],
      messages: [
        {
          role: "user",
          content: [
            { text: "Read this" },
            { image: { format, source: { bytes: inputImage.data } } },
          ],
        },
      ],
    })
    expect(events).toMatchObject([
      {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [{ type: "text", text: "Hello!" }],
          usage: { inputTokens: 240, outputTokens: 10 },
        },
      },
    ])
    expect(events[0]).toHaveProperty(
      "response.native.0.wireApi",
      "bedrock_converse",
    )
  })
  it("round-trips parallel tool calls, error results and images without changing history", async () => {
    const tools = [
      {
        name: "inspect",
        description: "inspect",
        inputSchema: { type: "object" },
      },
    ]
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply(
          [
            {
              toolUse: {
                name: "inspect",
                input: { path: "a" },
                toolUseId: "call:1.a",
              },
            },
            {
              toolUse: {
                name: "inspect",
                input: { path: "b" },
                toolUseId: "call_b",
              },
            },
          ],
          "tool_use",
        ),
      )
      .mockResolvedValueOnce(reply())
    const stream = createBedrockConverseProvider({ ...options, fetchFn })
    const first = await collect(
      stream,
      request({ tools, continuationScope: "account" }),
    )
    const event = first[0]
    if (event?.type !== "response" || !event.response.native)
      throw new Error("Expected response")
    const img = await image()
    const input = request({
      tools,
      continuationScope: "account",
      messages: [
        ...request().messages,
        {
          role: "assistant",
          content: event.response.content,
          native: event.response.native,
        },
        {
          role: "tool",
          toolCallId: "call_b",
          isError: true,
          content: [{ type: "text", text: "missing" }],
        },
        { role: "tool", toolCallId: "call:1.a", content: [img] },
      ],
    })
    const snapshot = structuredClone(input.messages)
    expect((await collect(stream, input))[0]).toHaveProperty("type", "response")
    expect(input.messages).toEqual(snapshot)
    const body = JSON.parse(fetchFn.mock.calls[1]?.[1]?.body as string)
    expect(body.messages[1].content[0]).toEqual({
      toolUse: { name: "inspect", input: { path: "a" }, toolUseId: "call:1.a" },
    })
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "call_b",
            status: "error",
            content: [{ text: "missing" }],
          },
        },
        {
          toolResult: {
            toolUseId: "call:1.a",
            status: "success",
            content: [
              { image: { format: "png", source: { bytes: img.data } } },
            ],
          },
        },
      ],
    })
  })
  it.each([
    "max_tokens",
    "content_filtered",
    "guardrail_intervened",
  ])("never executes or replays tools on %s", async (stop) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply([{ toolUse: { toolUseId: "c", name: "run", input: {} } }], stop),
      )
    const events = await collect(
      createBedrockConverseProvider({ ...options, fetchFn }),
    )
    expect(events).toMatchObject([
      {
        type: "response",
        response: { incompleteToolCalls: true, content: [], native: [] },
      },
    ])
  })
  it("rejects unmatched history and unplanned output tools", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(
          [{ toolUse: { toolUseId: "c", name: "run", input: {} } }],
          "tool_use",
        ),
      )
    const stream = createBedrockConverseProvider({ ...options, fetchFn })
    expect(
      (
        await collect(
          stream,
          request({
            messages: [
              ...request().messages,
              {
                role: "tool",
                toolCallId: "missing",
                content: [{ type: "text", text: "done" }],
              },
            ],
          }),
        )
      )[0],
    ).toMatchObject({ type: "failure", failure: { stage: "request_build" } })
    expect(fetchFn).not.toHaveBeenCalled()
    expect((await collect(stream))[0]).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
    })
  })
  it.each([
    {
      providerOptions: {
        provider: "nova",
        wireApi: "bedrock_converse" as const,
        body: { messages: [] },
      },
    },
    { parallelToolCalls: false },
    {
      target: {
        provider: "nova",
        model,
        instructionProfileId: "default",
        effort: "high",
      },
    },
    {
      target: {
        provider: "nova",
        model: "amazon.nova-micro-v1:0",
        instructionProfileId: "default",
      },
    },
  ])("rejects unsupported controls before network: %j", async (patch) => {
    const fetchFn = vi.fn<typeof fetch>()
    expect(
      (
        await collect(
          createBedrockConverseProvider({ ...options, fetchFn }),
          request(patch),
        )
      )[0],
    ).toMatchObject({ type: "failure", failure: { kind: "invalid_request" } })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it("rejects six images, oversize encoded bodies and corrupt pixels before network", async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const stream = createBedrockConverseProvider({ ...options, fetchFn })
    const img = await image()
    for (const content of [
      Array(6).fill(img),
      [{ type: "text" as const, text: "a".repeat(25_000_000) }],
      [{ ...img, data: "broken" }],
    ]) {
      expect(
        (
          await collect(
            stream,
            request({ messages: [{ role: "user", content }] }),
          )
        )[0],
      ).toHaveProperty("type", "failure")
    }
    expect(fetchFn).not.toHaveBeenCalled()
    const countFailure = await collect(
      stream,
      request({ messages: [{ role: "user", content: Array(6).fill(img) }] }),
    )
    expect(countFailure[0]).toMatchObject({
      type: "failure",
      failure: { message: expect.stringContaining("at most 5 image") },
    })
  })
  it("rejects image edge/byte limits without resizing source data", async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const stream = createBedrockConverseProvider({ ...options, fetchFn })
    const edge = await image("png", 8001)
    const oversized = {
      ...edge,
      data: Buffer.alloc(3_750_001).toString("base64"),
    }
    for (const img of [edge, oversized]) {
      expect(
        (
          await collect(
            stream,
            request({ messages: [{ role: "user", content: [img] }] }),
          )
        )[0],
      ).toMatchObject({ type: "failure", failure: { kind: "invalid_request" } })
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it("cancels a pending buffered request and releases the iterator", async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) throw new Error("Missing request cancellation signal")
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        }),
    )
    const stream = createModelRequestStream(
      createBedrockConverseProvider({ ...options, fetchFn }),
      { wireApi: "bedrock_converse", maxAttempts: 4 },
    )
    const pending = collect(stream, request({ signal: controller.signal }))
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await pending).toEqual([{ type: "cancelled" }])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it("does not retry uncertain idle timeouts even if caller requests retries", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) throw new Error("Missing request cancellation signal")
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        }),
    )
    const stream = createModelRequestStream(
      createBedrockConverseProvider({ ...options, fetchFn }),
      { wireApi: "bedrock_converse", maxAttempts: 5, streamIdleTimeoutMs: 30 },
    )
    const events = await collect(stream)
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: { kind: "idle_timeout", retryDecision: "fail" },
      },
    ])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it.each([
    401, 403, 429, 500,
  ])("does not retry HTTP %i or expose reflected credential text", async (status) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "fixture-only" }, { status }))
    const events = await collect(
      createModelRequestStream(
        createBedrockConverseProvider({ ...options, fetchFn }),
        { wireApi: "bedrock_converse", maxAttempts: 5 },
      ),
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(events)).not.toContain("fixture-only")
  })
  it("wires configured providers and static catalog without making discovery a credential check", async () => {
    const fetch = vi.mocked(bedrockFetch)
    fetch.mockClear()
    fetch.mockResolvedValueOnce(new BedrockResponse(await reply().text()))
    const models = await discoverProviderModels(config, "fixture-only")
    expect(models.map((item) => item.id)).toEqual([model])
    expect(fetch).not.toHaveBeenCalled()
    const provider = createConfiguredProvider("nova", config, "fixture-only")
    expect(provider.info.streamIdleTimeoutMs).toBe(3_600_000)
    const turn = provider.startTurn()
    expect((await collect(turn.stream))[0]).toHaveProperty("type", "response")
    await turn.close()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(providerPresets.some((preset) => preset.id === "amazon-nova")).toBe(
      true,
    )
    expect(
      providersFromConfig({ nova: providerConfigValue(config) }).nova?.wireApi,
    ).toBe("bedrock_converse")
    expect(() =>
      requireProviderConfiguration({
        ...config,
        baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com.evil.test",
      }),
    ).toThrow("us-east-1")
    expect(() =>
      requireProviderConfiguration({ ...config, authentication: "none" }),
    ).toThrow("bearer")
  })
  it("aborts a real pending HTTP response and never follows redirects with credentials", async () => {
    let received = 0
    let closed = 0
    let redirect = false
    let partialBody = false
    const server = createServer((incoming, outgoing) => {
      received++
      outgoing.on("close", () => {
        closed++
      })
      incoming.resume()
      if (redirect)
        outgoing.writeHead(307, { location: "/credential-target" }).end()
      else if (partialBody) {
        outgoing.writeHead(200, { "Content-Type": "application/json" })
        outgoing.write('{"output":')
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing server")
    const local = `http://127.0.0.1:${address.port}`
    const fetchFn: NonNullable<
      Parameters<typeof createBedrockConverseProvider>[0]["fetchFn"]
    > = (_url, init) => bedrockFetch(local, init)
    try {
      const controller = new AbortController()
      const run = collect(
        createBedrockConverseProvider({ ...options, fetchFn }),
        request({ signal: controller.signal }),
      )
      await vi.waitFor(() => expect(received).toBe(1))
      controller.abort()
      expect(await run).toEqual([{ type: "cancelled" }])
      await vi.waitFor(() => expect(closed).toBe(1))
      partialBody = true
      const bodyController = new AbortController()
      const partial = collect(
        createBedrockConverseProvider({ ...options, fetchFn }),
        request({ signal: bodyController.signal }),
      )
      await vi.waitFor(() => expect(received).toBe(2))
      bodyController.abort()
      expect(await partial).toEqual([{ type: "cancelled" }])
      await vi.waitFor(() => expect(closed).toBe(2))
      const timeout = await collect(
        createModelRequestStream(
          createBedrockConverseProvider({ ...options, fetchFn }),
          {
            wireApi: "bedrock_converse",
            maxAttempts: 5,
            streamIdleTimeoutMs: 40,
          },
        ),
      )
      expect(timeout.at(-1)).toMatchObject({
        type: "failure",
        failure: { kind: "idle_timeout", retryDecision: "fail" },
      })
      await vi.waitFor(() => expect(closed).toBe(3))
      expect(received).toBe(3)
      redirect = true
      const events = await collect(
        createBedrockConverseProvider({ ...options, fetchFn }),
      )
      expect(events[0]).toHaveProperty("type", "failure")
      expect(received).toBe(4)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
  it("does not retry local compaction truncation or interactive connection waits", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply([{ text: "partial" }], "max_tokens"))
    const stream = createModelRequestStream(
      createBedrockConverseProvider({ ...options, fetchFn }),
      { wireApi: "bedrock_converse", maxAttempts: 4 },
    )
    const events = await collect(
      stream,
      request({ compaction: "local", waitForConnection: true }),
    )
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { retryDecision: "fail" },
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it("drops foreign account native reasoning but preserves portable text", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(reply())
    await collect(
      createBedrockConverseProvider({ ...options, fetchFn }),
      request({
        continuationScope: "new-account",
        messages: [
          ...request().messages,
          {
            role: "assistant",
            content: [{ type: "text", text: "portable" }],
            native: [
              {
                provider: "nova",
                model,
                wireApi: "bedrock_converse",
                scope: "old-account",
                value: {
                  reasoningContent: {
                    reasoningText: { text: "opaque", signature: "secret" },
                  },
                },
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
      }),
    )
    const body = fetchFn.mock.calls[0]?.[1]?.body as string
    expect(body).toContain("portable")
    expect(body).not.toContain("secret")
    expect(body).not.toContain("opaque")
  })
  it("bounds buffered response memory and cancels oversized bodies", async () => {
    let cancelled = false
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(8_000_001))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    const events = await collect(
      createBedrockConverseProvider({ ...options, fetchFn }),
    )
    expect(events[0]).toMatchObject({
      type: "failure",
      failure: {
        kind: "protocol_error",
        message: expect.stringContaining("16 MB"),
      },
    })
    expect(cancelled).toBe(true)
  })
  it("rejects hosted server tool responses rather than executing them locally", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(
          [
            {
              toolUse: {
                type: "server_tool_use",
                toolUseId: "call:1.a",
                name: "run",
                input: {},
              },
            },
          ],
          "tool_use",
        ),
      )
    const events = await collect(
      createBedrockConverseProvider({ ...options, fetchFn }),
      request({
        tools: [
          {
            name: "run",
            description: "local",
            inputSchema: { type: "object" },
          },
        ],
      }),
    )
    expect(events[0]).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
    })
  })
})
