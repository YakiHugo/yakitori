import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const request: ModelRequest = {
  target: {
    provider: "personal",
    model: "step-5-preview",
    instructionProfileId: "default",
  },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
  toolWireProtocol: "eager",
}
afterEach(() => vi.restoreAllMocks())
async function collect(
  response: Response,
  flavor: "stepfun" | "generic" = "stepfun",
) {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response)
  const events: ModelStreamEvent[] = []
  const stream = createChatCompletionsProvider({
    apiKey: "test",
    baseURL: "https://api.stepfun.ai/v1",
    model: "step-5-preview",
    flavor,
  })
  for await (const event of stream(request)) events.push(event)
  return { events, fetch }
}
function sse(terminal: boolean) {
  const chunks = [
    {
      id: "chat_test",
      choices: [{ index: 0, delta: { reasoning: "Think" }, finish_reason: "" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 1,
        total_tokens: 101,
        cached_tokens: 60,
      },
    },
    ...(terminal
      ? [
          {
            id: "chat_test",
            choices: [
              { index: 0, delta: { content: "Hello" }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cached_tokens: 60,
            },
          },
        ]
      : []),
  ]
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
it("understands StepFun empty nonterminal reasons, reasoning and top-level cache usage", async () => {
  const { events } = await collect(sse(true))
  expect(events).toContainEqual(
    expect.objectContaining({ type: "reasoning_delta", text: "Think" }),
  )
  expect(events.at(-1)).toMatchObject({
    type: "response",
    response: {
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        activeContextTokens: 120,
        cacheReadInputTokens: 60,
      },
    },
  })
})
it("does not accept an unfinished StepFun stream as a completed response", async () => {
  expect((await collect(sse(false))).events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "stream_disconnected" },
  })
})
it("does not broaden the generic Chat finish-reason contract", async () => {
  expect((await collect(sse(true), "generic")).events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "protocol_error" },
  })
})
it.each([
  { status: 400, kind: "invalid_request" },
  { status: 401, kind: "authentication" },
  { status: 402, kind: "invalid_request" },
  { status: 429, kind: "rate_limited" },
  { status: 451, kind: "invalid_request" },
  { status: 503, kind: "server_error" },
])("keeps HTTP $status provider detail and never retries inside the SDK", async ({
  status,
  kind,
}) => {
  const { events, fetch } = await collect(
    new Response(
      JSON.stringify({
        error: {
          message: "StepFun request diagnostic",
          code: "step_diagnostic",
        },
      }),
      {
        status,
        headers: {
          "content-type": "application/json",
          "x-request-id": "trace_test",
          "retry-after": "2",
        },
      },
    ),
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      kind,
      status,
      providerCode: "step_diagnostic",
      details: { providerMessage: "StepFun request diagnostic" },
      providerRequestId: "trace_test",
      retryAfterMs: 2000,
    },
  })
})
