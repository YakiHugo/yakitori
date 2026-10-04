import { once } from "node:events"
import { createServer } from "node:http"
import OpenAI from "openai"
import type { Response } from "openai/resources/responses/responses"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { createOpenAITurnTransport } from "../../src/runtime/openai-provider.ts"
import { supportsOpenAIRequestWarmup } from "../../src/shared/request-warmup-policy.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) close()
})

async function fixture(
  onRequest?: (socket: WebSocket, body: Record<string, unknown>) => void,
) {
  const requests: Record<string, unknown>[] = []
  const httpRequests: Record<string, unknown>[] = []
  const authHeaders: Array<string | undefined> = []
  let connections = 0
  let httpCalls = 0
  const server = createServer((request, reply) => {
    httpCalls += 1
    let body = ""
    request.on("data", (bytes) => {
      body += bytes.toString()
    })
    request.on("end", () => {
      httpRequests.push(JSON.parse(body))
      reply.writeHead(200, { "content-type": "text/event-stream" })
      reply.end(
        `data: ${JSON.stringify({ type: "response.completed", response: response("http") })}\n\n`,
      )
    })
  })
  const ws = new WebSocketServer({ server })
  ws.on("connection", (socket, request) => {
    authHeaders.push(request.headers.authorization)
    connections += 1
    socket.on("message", (bytes) => {
      const body = JSON.parse(bytes.toString()) as Record<string, unknown>
      requests.push(body)
      if (onRequest) return onRequest(socket, body)
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: response(body.generate === false ? "warm" : "generated"),
        }),
      )
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address")
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
  })
  // The endpoint guard is exercised separately; only this injected test SDK
  // routes traffic to the local mock, never to the live paid API.
  const transport = createOpenAITurnTransport({
    apiKey: "test-key",
    model: "gpt-test",
    baseURL: "https://api.openai.com/v1",
    client,
  })
  const warmup = transport.warmup
  if (warmup === undefined)
    throw new Error("Test endpoint requires warmup capability")
  cleanup.push(() => {
    transport.close()
    for (const socket of ws.clients) socket.terminate()
    ws.close()
    server.close()
  })
  return {
    transport: { ...transport, warmup },
    requests,
    httpRequests,
    authHeaders,
    get connections() {
      return connections
    },
    get httpCalls() {
      return httpCalls
    },
  }
}
function response(id: string): Response {
  return {
    id,
    status: "completed",
    model: "gpt-test",
    output: [],
    usage: {
      input_tokens: 100,
      output_tokens: 0,
      total_tokens: 100,
      input_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as Response
}
function request(patch: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "openai",
      model: "gpt-test",
      instructionProfileId: "gpt-test",
    },
    system: [{ id: "system", revision: "1", text: "Be helpful" }],
    messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    tools: [],
    toolWireProtocol: "eager",
    continuationScope: "account-1",
    ...patch,
  }
}
async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("OpenAI non-generating warmup", () => {
  it.each([
    "https://chatgpt.com/backend-api/codex",
    "https://api.x.ai/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com.example/v1",
    "https://api.openai.com/v1?x=1",
  ])("does not probe unsupported endpoint %s", (url) => {
    expect(supportsOpenAIRequestWarmup(url)).toBe(false)
    const transport = createOpenAITurnTransport({
      apiKey: "test",
      model: "m",
      baseURL: url,
    })
    expect(transport.warmup).toBeUndefined()
    transport.close()
  })
  it("reuses the authenticated socket and exact prefix after a tool gap, retaining reported usage", async () => {
    const f = await fixture()
    const warm = await collect(f.transport.warmup(request()))
    expect(warm).toMatchObject([
      {
        type: "response",
        response: {
          content: [],
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            cacheReadInputTokens: 60,
            cacheWriteInputTokens: 40,
          },
        },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    const generated = await collect(
      f.transport.stream(
        request({
          messages: [
            ...request().messages,
            { role: "user", content: [{ type: "text", text: "Next" }] },
          ],
        }),
      ),
    )
    expect(generated.at(-1)).toMatchObject({
      type: "response",
      response: { providerRequestId: "generated" },
    })
    expect(f.connections).toBe(1)
    expect(f.authHeaders).toEqual(["Bearer test-key"])
    expect(f.httpCalls).toBe(0)
    expect(f.requests[0]).toMatchObject({
      type: "response.create",
      generate: false,
      store: false,
    })
    expect(f.requests[0]).not.toHaveProperty("stream")
    expect(f.requests[1]).toMatchObject({
      previous_response_id: "warm",
      store: false,
      input: [{ role: "user", content: "Next" }],
    })
    expect(f.requests[1]).not.toHaveProperty("generate")
  })
  it.each([
    { continuationScope: "new-account" },
    {
      target: {
        provider: "openai",
        model: "other-model",
        instructionProfileId: "gpt-test",
      },
    },
    { system: [{ id: "system", revision: "2", text: "New instructions" }] },
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "Changed epoch" }] },
      ],
    },
  ] satisfies Partial<ModelRequest>[])("falls back with complete history after identity or prefix changes: %j", async (patch) => {
    const f = await fixture()
    await collect(f.transport.warmup(request()))
    await collect(f.transport.stream(request(patch)))
    expect(f.requests).toHaveLength(1)
    expect(f.httpCalls).toBe(1)
  })
  it("never waits for unfinished warmup or retries an unused preparation", async () => {
    const f = await fixture(() => {})
    const pending = collect(f.transport.warmup(request()))
    while (f.requests.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1))
    await collect(f.transport.stream(request()))
    await pending
    await collect(f.transport.warmup(request()))
    expect(f.connections).toBe(1)
    expect(f.httpCalls).toBe(1)
    expect(f.requests).toHaveLength(1)
  })
  it("cancels warmup without generating or executing tools", async () => {
    const f = await fixture(() => {})
    const controller = new AbortController()
    const pending = collect(
      f.transport.warmup(request({ signal: controller.signal })),
    )
    while (f.requests.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort()
    expect(await pending).toEqual([{ type: "cancelled" }])
    expect(f.requests).toHaveLength(1)
    expect(f.httpCalls).toBe(0)
  })
  it("replays complete input only for an explicit missing cached prefix", async () => {
    const f = await fixture((socket, body) => {
      socket.send(
        JSON.stringify(
          body.generate === false
            ? { type: "response.completed", response: response("warm") }
            : {
                type: "error",
                code: "previous_response_not_found",
                message: "Prefix expired",
                param: null,
              },
        ),
      )
    })
    await collect(f.transport.warmup(request()))
    const events = await collect(f.transport.stream(request()))
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { providerRequestId: "http" },
    })
    expect(f.httpCalls).toBe(1)
    expect(f.requests).toHaveLength(2)
    expect(f.httpRequests[0]).toMatchObject({
      input: [{ role: "user", content: "First" }],
      store: false,
    })
    expect(f.httpRequests[0]).not.toHaveProperty("previous_response_id")
  })
  it("does not silently replay a generated request after an ambiguous disconnect", async () => {
    const f = await fixture((socket, body) => {
      if (body.generate === false)
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: response("warm"),
          }),
        )
      else socket.terminate()
    })
    await collect(f.transport.warmup(request()))
    const events = await collect(f.transport.stream(request()))
    expect(events.at(-1)).toMatchObject({ type: "failure" })
    expect(f.httpCalls).toBe(0)
    expect(f.requests).toHaveLength(2)
    await collect(f.transport.stream(request()))
    expect(f.httpCalls).toBe(1)
    expect(f.connections).toBe(1)
  })
  it("does not expose unexpected warmup tools and retains their terminal usage", async () => {
    const f = await fixture((socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: {
            ...response("warm"),
            output: [
              {
                type: "function_call",
                id: "item",
                call_id: "call",
                name: "shell",
                arguments: "{}",
                status: "completed",
              },
            ],
          },
        }),
      ),
    )
    const events = await collect(f.transport.warmup(request()))
    expect(events).toMatchObject([
      { type: "failure", usage: { inputTokens: 100, outputTokens: 0 } },
    ])
    await collect(f.transport.stream(request()))
    expect(f.httpCalls).toBe(1)
  })
  it("expires unused warmups without issuing another preparation", async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    await collect(f.transport.warmup(request()))
    await vi.advanceTimersByTimeAsync(15_000)
    vi.useRealTimers()
    await collect(f.transport.stream(request()))
    expect(f.httpCalls).toBe(1)
    expect(f.requests).toHaveLength(1)
    await collect(f.transport.warmup(request()))
    expect(f.requests).toHaveLength(1)
  })
})
