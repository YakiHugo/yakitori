import OpenAI from "openai"
import { describe, expect, it } from "vitest"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"

const request: ModelRequest = {
  target: {
    provider: "openai",
    model: "fixture",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  toolWireProtocol: "eager",
}

function response(status: "completed" | "failed") {
  return new Response(
    `data: ${JSON.stringify({
      type: `response.${status}`,
      response: {
        id: `response_${status}`,
        status,
        output: [],
        usage: null,
        error: status === "failed" ? { code: "rate_limit_exceeded" } : null,
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("Responses nullable usage", () => {
  it("accepts a completed wire response with no usage sample", async () => {
    const snapshots: unknown[] = []
    const client = new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async () => response("completed"),
    })
    const stream = createOpenAIProvider({
      apiKey: "fixture",
      model: "fixture",
      client,
    })
    const events = await collect(
      stream({ ...request, onUsageSnapshot: (usage) => snapshots.push(usage) }),
    )
    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [],
          providerRequestId: "response_completed",
        },
      },
    ])
    expect(snapshots).toEqual([])
  })

  it.each([
    "omitted",
    "null",
  ])("preserves failure metadata when terminal output is %s", async (output) => {
    const client = new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "response.failed",
            response: {
              id: "response_failed",
              status: "failed",
              usage: null,
              ...(output === "null" ? { output: null } : {}),
              error: { code: "rate_limit_exceeded" },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const stream = createOpenAIProvider({
      apiKey: "fixture",
      model: "fixture",
      client,
    })
    expect(await collect(stream(request))).toMatchObject([
      {
        type: "failure",
        failure: {
          kind: "rate_limited",
          providerCode: "rate_limit_exceeded",
          providerRequestId: "response_failed",
        },
      },
    ])
  })

  it("preserves the error classification and retry when a failed wire response has null usage", async () => {
    let requests = 0
    const client = new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async () => response(++requests === 1 ? "failed" : "completed"),
    })
    const stream = createModelRequestStream(
      createOpenAIProvider({ apiKey: "fixture", model: "fixture", client }),
      {
        wireApi: "openai_responses",
        maxAttempts: 2,
        sleep: async () => {},
        random: () => 0,
      },
    )
    const events = await collect(stream(request))
    expect(events[0]).toMatchObject({
      type: "retry",
      failure: {
        kind: "rate_limited",
        providerCode: "rate_limit_exceeded",
        providerRequestId: "response_failed",
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { stopReason: "end_turn" },
    })
    expect(requests).toBe(2)
    expect(events.every((event) => !("usage" in event))).toBe(true)
  })
})
