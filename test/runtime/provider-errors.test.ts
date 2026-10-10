import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import { createAnthropicProvider } from "../../src/runtime/anthropic-provider.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"

const request: ModelRequest = {
  target: { provider: "test", model: "test", instructionProfileId: "test" },
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}

describe("provider error diagnostics", () => {
  it.each([
    "responses",
    "chat",
    "messages",
    "gemini",
  ] as const)("preserves the structured HTTP reason through the %s transport", async (api) => {
    const server = createServer((_incoming, outgoing) => {
      outgoing.writeHead(400, {
        "content-type": "application/json",
        "x-request-id": "request_rejected",
      })
      outgoing.end(
        JSON.stringify({
          type: "error",
          error: {
            message: "Tool result missing for call_a.",
            type: "invalid_request_error",
            code: "invalid_tool_history",
            status: "INVALID_ARGUMENT",
            privateField: "unselected-private-data",
          },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new Error("Missing address")
    const options = {
      apiKey: "test",
      model: "test",
      baseURL: `http://127.0.0.1:${address.port}`,
    }
    const stream =
      api === "responses"
        ? createOpenAIProvider(options)
        : api === "chat"
          ? createChatCompletionsProvider(options)
          : api === "messages"
            ? createAnthropicProvider(options)
            : createGeminiProvider(options)
    try {
      const events: ModelStreamEvent[] = []
      for await (const event of stream(request)) events.push(event)
      expect(events).toMatchObject([
        {
          type: "failure",
          failure: {
            kind: "invalid_request",
            status: 400,
            details: { providerMessage: "Tool result missing for call_a." },
          },
        },
      ])
      expect(
        JSON.stringify(
          events.flatMap((event) =>
            event.type === "failure" ? [event.failure] : [],
          ),
        ),
      ).not.toContain("unselected-private-data")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it("preserves a Gemini error delivered inside a successful SSE connection", async () => {
    const stream = createGeminiProvider({
      apiKey: "test",
      model: "test",
      baseURL: "https://test.invalid",
      fetchFn: async () =>
        new Response(
          `data: ${JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "Invalid function response.",
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const events: ModelStreamEvent[] = []
    for await (const event of stream(request)) events.push(event)
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: {
          stage: "model_event",
          providerCode: "INVALID_ARGUMENT",
          details: { providerMessage: "Invalid function response." },
        },
      },
    ])
  })
})
