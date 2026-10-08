import { once } from "node:events"
import { createServer } from "node:http"
import OpenAI from "openai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type WebSocket, WebSocketServer } from "ws"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createOpenAITurnTransport } from "../../src/runtime/openai-provider.ts"

const constructorState = vi.hoisted(() => ({ calls: 0, failNext: false }))
vi.mock("openai/resources/responses/ws", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openai/resources/responses/ws")>()
  return {
    ResponsesWS: class extends actual.ResponsesWS {
      constructor(...args: ConstructorParameters<typeof actual.ResponsesWS>) {
        constructorState.calls += 1
        if (constructorState.failNext) {
          constructorState.failNext = false
          throw new Error("Injected WebSocket constructor failure")
        }
        super(...args)
      }
    },
  }
})

const cleanup: (() => void)[] = []
beforeEach(() => {
  constructorState.calls = 0
  constructorState.failNext = false
})
afterEach(() => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) close()
})
const request: ModelRequest = {
  target: {
    provider: "openai",
    model: "fixture",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "prefix" }] }],
  tools: [],
  toolWireProtocol: "eager",
  continuationScope: "account",
}
function complete(id: string, output: unknown = []) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      ...(output === "omitted" ? {} : { output }),
      usage: null,
    },
  }
}
async function collect(stream: AsyncIterable<ModelStreamEvent> | undefined) {
  if (!stream) throw new Error("No warmup capability")
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
async function fixture(output: unknown = []) {
  const wsRequests: Record<string, unknown>[] = [],
    httpRequests: Record<string, unknown>[] = [],
    sockets: WebSocket[] = []
  const server = createServer((incoming, outgoing) => {
    let body = ""
    incoming.on("data", (chunk) => {
      body += String(chunk)
    })
    incoming.on("end", () => {
      httpRequests.push(JSON.parse(body))
      outgoing.writeHead(200, { "content-type": "text/event-stream" })
      outgoing.end(`data: ${JSON.stringify(complete("http"))}\n\n`)
    })
  })
  const websocket = new WebSocketServer({ server })
  websocket.on("connection", (socket) => {
    sockets.push(socket)
    socket.on("message", (value) => {
      const body = JSON.parse(String(value))
      wsRequests.push(body)
      socket.send(
        JSON.stringify(
          complete(
            body.generate === false ? "warm" : "generated",
            body.generate === false ? output : [],
          ),
        ),
      )
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (typeof address !== "object" || address === null)
    throw new Error("Missing address")
  const client = new OpenAI({
    apiKey: "fixture",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
  })
  function createTurn() {
    const turn = createOpenAITurnTransport({
      apiKey: "fixture",
      model: "fixture",
      baseURL: "https://api.openai.com/v1",
      client,
    })
    cleanup.push(() => {
      void turn.close()
    })
    return turn
  }
  cleanup.push(() => {
    for (const socket of sockets) socket.terminate()
    websocket.close()
    server.close()
  })
  return { createTurn, wsRequests, httpRequests, sockets }
}

describe("Responses warmup admission boundaries", () => {
  it("consumes one preparation attempt on synchronous SDK constructor failure, leaks no expiry, and preserves HTTP fallback and a fresh Turn", async () => {
    const f = await fixture()
    const turn = f.createTurn()
    constructorState.failNext = true
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    expect(await collect(turn.warmup?.(request))).toMatchObject([
      { type: "failure", failure: { kind: "provider_error" } },
    ])
    expect(constructorState.calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.sockets).toHaveLength(0)
    expect(await collect(turn.warmup?.(request))).toEqual([])
    expect(constructorState.calls).toBe(1)
    vi.useRealTimers()
    expect((await collect(turn.stream(request))).at(-1)).toMatchObject({
      type: "response",
      response: { providerRequestId: "http" },
    })
    expect(f.httpRequests[0]).toMatchObject({
      input: [{ role: "user", content: "prefix" }],
    })
    expect(f.httpRequests[0]).not.toHaveProperty("previous_response_id")
    await turn.close()
    await turn.close()
    expect(await collect(turn.warmup?.(request))).toEqual([])
    expect(
      (await collect(f.createTurn().warmup?.(request))).at(-1),
    ).toMatchObject({
      type: "response",
      response: { providerRequestId: "warm" },
    })
    expect(constructorState.calls).toBe(2)
    expect(f.wsRequests).toHaveLength(1)
  })

  it.each([
    "omitted",
    null,
  ])("captures a non-generating completed prefix when terminal output is %s", async (output) => {
    const f = await fixture(output)
    const turn = f.createTurn()
    expect(await collect(turn.warmup?.(request))).toMatchObject([
      {
        type: "response",
        response: { providerRequestId: "warm", content: [] },
      },
    ])
    expect(
      (
        await collect(
          turn.stream({
            ...request,
            messages: [
              ...request.messages,
              { role: "user", content: [{ type: "text", text: "suffix" }] },
            ],
          }),
        )
      ).at(-1),
    ).toMatchObject({
      type: "response",
      response: { providerRequestId: "generated" },
    })
    expect(f.httpRequests).toHaveLength(0)
    expect(f.wsRequests[1]).toMatchObject({
      previous_response_id: "warm",
      input: [{ role: "user", content: "suffix" }],
    })
  })
})
