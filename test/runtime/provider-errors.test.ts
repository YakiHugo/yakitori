import { createServer } from "node:http"
import OpenAI from "openai"
import { describe, expect, it } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { createAnthropicTestStream } from "./anthropic-test-stream.ts"

const request: ModelRequest = {
  target: { provider: "test", model: "test", instructionProfileId: "test" },
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}

describe("provider error diagnostics", () => {
  it("does not retry SDK-wrapped invalid transport arguments while waiting for connectivity", async () => {
    let calls = 0
    const client = new OpenAI({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => {
        calls += 1
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("invalid onRequestStart method"), {
            code: "UND_ERR_INVALID_ARG",
          }),
        })
      },
    })
    const stream = createModelRequestStream(
      createOpenAIProvider({ client, apiKey: "test", model: "test" }),
      {
        wireApi: "openai_responses",
        // End a broken connectivity loop deterministically, without a timer.
        sleep: async () => {
          throw new Error("Local argument errors must never reach retry sleep.")
        },
      },
    )
    const events: ModelStreamEvent[] = []
    for await (const event of stream({ ...request, waitForConnection: true }))
      events.push(event)
    expect(calls).toBe(1)
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: {
          kind: "invalid_request",
          serverShouldRetry: false,
          attempt: 1,
          retryDecision: "fail",
          details: { causeCode: "UND_ERR_INVALID_ARG" },
        },
      },
    ])
  })

  it.each([
    {
      status: 403,
      reason:
        "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.",
      code: undefined,
      attempts: 1,
    },
    {
      status: 429,
      reason: "You have no credits remaining",
      code: undefined,
      attempts: 2,
    },
    {
      status: 429,
      reason: "Credits unavailable",
      code: "insufficient_quota",
      attempts: 1,
    },
    {
      status: 429,
      reason: "Credits unavailable",
      code: "usage_limit_reached",
      attempts: 1,
    },
    {
      status: 429,
      reason: "Credits unavailable",
      code: "credit_balance_exhausted",
      attempts: 1,
    },
  ])("uses HTTP $status and code $code for retry decisions independently of diagnostic text", async ({
    status,
    reason,
    code,
    attempts,
  }) => {
    let calls = 0
    const sleeps: number[] = []
    const server = createServer((_incoming, outgoing) => {
      calls += 1
      outgoing.writeHead(status, {
        "content-type": "application/json",
        "x-should-retry": "true",
      })
      outgoing.end(
        JSON.stringify({
          error: code === undefined ? reason : { message: reason, code },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new Error("Missing address")
    const stream = createModelRequestStream(
      createOpenAIProvider({
        apiKey: "test",
        model: "test",
        responseProfile: "grok",
        baseURL: `http://127.0.0.1:${address.port}`,
      }),
      {
        wireApi: "openai_responses",
        maxAttempts: 2,
        sleep: async (delayMs) => {
          sleeps.push(delayMs)
        },
      },
    )
    try {
      const events: ModelStreamEvent[] = []
      for await (const event of stream({ ...request, waitForConnection: true }))
        events.push(event)
      expect(calls).toBe(attempts)
      expect(sleeps).toHaveLength(attempts - 1)
      expect(events.filter((event) => event.type === "retry")).toHaveLength(
        attempts - 1,
      )
      expect(events.at(-1)).toMatchObject({
        type: "failure",
        failure: {
          kind: status === 403 ? "invalid_request" : "rate_limited",
          status,
          ...(code === undefined ? {} : { providerCode: code }),
          serverShouldRetry: code === undefined,
          retryDecision: "fail",
          details: { providerMessage: reason },
        },
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it.each([
    "responses",
    "chat",
  ] as const)("preserves xAI string error reasons through the %s SDK transport", async (api) => {
    const reason =
      "tool_search execution must be 'server' or not set; client-executed tool search is not supported"
    const server = createServer((_incoming, outgoing) => {
      outgoing.writeHead(400, { "content-type": "application/json" })
      outgoing.end(
        JSON.stringify({ error: reason, privateField: "private-data" }),
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
        : createChatCompletionsProvider(options)
    try {
      const events: ModelStreamEvent[] = []
      for await (const event of stream(request)) events.push(event)
      const failures = events.flatMap((event) =>
        event.type === "failure" ? [event.failure] : [],
      )
      expect(failures).toMatchObject([
        {
          kind: "invalid_request",
          status: 400,
          details: { providerMessage: reason },
        },
      ])
      expect(JSON.stringify(failures)).not.toContain("private-data")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

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
            ? createAnthropicTestStream(options)
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
