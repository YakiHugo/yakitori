import { describe, expect, it } from "vitest"
import {
  createFauxProvider,
  ModelStopReason,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/index.ts"

describe("faux provider", () => {
  it("emits scripted snapshots then a terminal response in order", async () => {
    const provider = createFauxProvider([
      {
        snapshots: ["Hel", "Hello"],
        content: [{ type: "text", text: "Hello" }],
        stopReason: ModelStopReason.EndTurn,
        usage: { inputTokens: 3, outputTokens: 1 },
        providerRequestId: "faux_1",
      },
    ])

    const events = await collect(provider.stream(baseRequest()))

    expect(events).toEqual([
      { type: "snapshot", text: "Hel" },
      { type: "snapshot", text: "Hello" },
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Hello" }],
          usage: { inputTokens: 3, outputTokens: 1 },
          providerRequestId: "faux_1",
        },
      },
    ])
  })

  it("advances multi-call scripts once per model request", async () => {
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "first" }],
      },
      {
        content: [
          {
            type: "tool_call",
            id: "tool_1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
        stopReason: ModelStopReason.ToolUse,
      },
      {
        content: [{ type: "text", text: "done" }],
      },
    ])

    const first = await collect(provider.stream(baseRequest({ model: "a" })))
    const second = await collect(provider.stream(baseRequest({ model: "b" })))
    const third = await collect(provider.stream(baseRequest({ model: "c" })))

    expect(first.at(-1)).toMatchObject({
      type: "response",
      response: { content: [{ type: "text", text: "first" }] },
    })
    expect(second.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.ToolUse,
        content: [{ type: "tool_call", id: "tool_1", name: "read_file" }],
      },
    })
    expect(third.at(-1)).toMatchObject({
      type: "response",
      response: { content: [{ type: "text", text: "done" }] },
    })
    expect(provider.callCount).toBe(3)
    expect(provider.requests.map((request) => request.model)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("keeps mid-stream throw, premature end, explicit error, and abort distinct", async () => {
    const throwDuring = createFauxProvider([
      {
        snapshots: ["partial"],
        throwDuring: new Error("stream broke"),
      },
    ])
    await expect(collect(throwDuring.stream(baseRequest()))).rejects.toThrow(
      "stream broke",
    )

    const premature = createFauxProvider([{ endWithoutResponse: true }])
    expect(await collect(premature.stream(baseRequest()))).toEqual([])

    const explicitError = createFauxProvider([
      {
        stopReason: ModelStopReason.Error,
        error: { code: "provider_error", message: "rate limited" },
      },
    ])
    expect(await collect(explicitError.stream(baseRequest()))).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: { code: "provider_error", message: "rate limited" },
        },
      },
    ])

    const controller = new AbortController()
    const waiting = createFauxProvider([{ waitForAbort: true }])
    const pending = collect(
      waiting.stream(baseRequest({ signal: controller.signal })),
    )
    controller.abort()
    expect(await pending).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Aborted,
          content: [],
        },
      },
    ])
  })

  it("retains requests for whole-object assertions without mutation", async () => {
    const provider = createFauxProvider([
      {
        assertRequest: (request) => {
          expect(request.system).toBe("be careful")
          expect(request.messages).toEqual([
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ])
        },
        content: [{ type: "text", text: "ok" }],
      },
    ])

    const request = baseRequest({
      system: "be careful",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    })
    await collect(provider.stream(request))

    const retained = provider.requests[0]
    expect(retained).toEqual(request)
    if (retained === undefined)
      throw new Error("Expected retained request.")
      // Mutating the retained copy must not change the provider's next read.
    ;(retained as { system: string }).system = "mutated"
    expect(provider.requests[0]?.system).toBe("be careful")
  })

  it("throws when the script is exhausted", async () => {
    const provider = createFauxProvider([])
    expect(() => provider.stream(baseRequest())).toThrow(
      "Faux provider has no scripted response for model call 1.",
    )
  })
})

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: "system",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ],
    tools: [],
    provider: "faux",
    model: "scripted",
    ...overrides,
  }
}

async function collect(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
