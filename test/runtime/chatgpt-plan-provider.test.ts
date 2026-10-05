import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { describe, expect, it } from "vitest"
import {
  createChatGPTPlanProvider,
  discoverChatGPTPlanModels,
  type ChatGPTPlanAccess,
} from "../../src/runtime/chatgpt-plan-provider.ts"
import { toChatGPTPlanRequest } from "../../src/runtime/chatgpt-plan-request.ts"
import { createOpenAITurnTransport } from "../../src/runtime/openai-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const access = {
  clientId: "oaiapp_fake",
  subject: "subject-a",
  accessToken: "fake-access",
}
const request: ModelRequest = {
  target: {
    provider: "chatgpt-plan",
    model: "gpt-fake",
    instructionProfileId: "gpt-fake",
  },
  system: [{ id: "base", revision: "1", text: "Use local tools." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  toolWireProtocol: "openai_deferred",
  maxOutputTokens: 10,
}
function completed(output: unknown[] = []) {
  return {
    type: "response.completed",
    response: {
      id: "r1",
      model: "gpt-fake",
      status: "completed",
      output,
      error: null,
      incomplete_details: null,
    },
  }
}
function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}
async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

describe("ChatGPT plan inference", () => {
  it("uses public Responses with a preview-safe body and eager local tool search", async () => {
    let body: Record<string, unknown> = {}
    const stream = createChatGPTPlanProvider({
      auth: { resolve: async () => access },
      fetchFn: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/responses")
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fake-access",
        )
        expect(init?.redirect).toBe("error")
        body = JSON.parse(String(init?.body))
        return sse([
          completed([
            {
              id: "tool1",
              type: "function_call",
              call_id: "c1",
              namespace: "yakitori",
              name: "shell",
              arguments: "{}",
              status: "completed",
            },
          ]),
        ])
      },
    })
    const events = await collect(
      stream({
        ...request,
        tools: [
          {
            name: "tool_search",
            kind: "tool_search",
            description: "Search local tools",
            inputSchema: { type: "object" },
          },
          {
            name: "shell",
            description: "Run a shell command",
            inputSchema: { type: "object" },
            deferLoading: true,
          },
        ],
      }),
    )
    expect(body).toMatchObject({
      store: false,
      stream: true,
      instructions: "Use local tools.",
      tools: [
        {
          type: "namespace",
          name: "yakitori",
          tools: [
            { type: "function", name: "tool_search" },
            { type: "function", name: "shell" },
          ],
        },
      ],
    })
    expect(body).not.toHaveProperty("max_output_tokens")
    expect(JSON.stringify(body)).not.toContain('"type":"tool_search"')
    expect(JSON.stringify(body)).not.toContain("defer_loading")
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: "tool_use",
        content: [{ type: "tool_call", name: "shell" }],
      },
    })
  })

  it("replays tool-search history as ordinary calls, preserving full history and source objects", async () => {
    let body: Record<string, unknown> = {}
    const stream = createChatGPTPlanProvider({
      auth: { resolve: async () => access },
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return sse([completed()])
      },
    })
    const messages: ModelRequest["messages"] = [
      ...request.messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolKind: "tool_search",
            id: "search1",
            name: "tool_search",
            input: { query: "shell" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "search1",
        content: "Found shell",
        toolSearch: {
          tools: [
            {
              name: "shell",
              description: "shell",
              inputSchema: { type: "object" },
            },
          ],
        },
      },
    ]
    const original = JSON.stringify(messages)
    await collect(stream({ ...request, messages }))
    expect(body.input).toEqual([
      { role: "user", content: "hello" },
      {
        type: "function_call",
        call_id: "search1",
        name: "tool_search",
        namespace: "yakitori",
        arguments: '{"query":"shell"}',
      },
      {
        type: "function_call_output",
        call_id: "search1",
        output: "Found shell",
      },
    ])
    expect(JSON.stringify(messages)).toBe(original)
    expect(body).not.toHaveProperty("previous_response_id")
  })

  it("uses models[] in server order and retains account-specific discovery identity", async () => {
    const catalog = await discoverChatGPTPlanModels({
      auth: { resolve: async () => access },
      fetchFn: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/models")
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fake-access",
        )
        return Response.json({
          models: [
            { slug: "model-b", display_name: "B", visibility: "list" },
            { slug: "hidden", display_name: "Hidden", visibility: "hide" },
            { slug: "model-a", display_name: "A", visibility: "list" },
          ],
        })
      },
    })
    expect(catalog.models).toEqual([
      { id: "model-b", displayName: "B" },
      { id: "model-a", displayName: "A" },
    ])
    expect(catalog.identity).toMatch(/^chatgpt-plan:/)
    expect(catalog.identity).not.toContain("subject-a")
    await expect(
      discoverChatGPTPlanModels({
        auth: { resolve: async () => access },
        fetchFn: async () => Response.json({ data: [] }),
      }),
    ).rejects.toThrow("invalid model catalog")
  })

  it("allows token rotation but prevents cross-account requests within a Turn", async () => {
    let token: ChatGPTPlanAccess = access
    let requests = 0
    const stream = createChatGPTPlanProvider({
      auth: { resolve: async () => token },
      fetchFn: async () => {
        requests++
        return sse([completed()])
      },
    })
    await collect(stream(request))
    token = { ...access, accessToken: "fake-rotated" }
    await collect(stream(request))
    token = { ...access, subject: "different-account" }
    expect((await collect(stream(request))).at(-1)).toMatchObject({
      type: "failure",
      failure: { providerCode: "chatgpt_account_changed" },
    })
    expect(requests).toBe(2)
  })

  it("does not send after the credential owner's session signal is aborted", async () => {
    let requests = 0
    const stream = createChatGPTPlanProvider({
      auth: {
        resolve: async () => ({ ...access, signal: AbortSignal.abort() }),
      },
      fetchFn: async () => {
        requests++
        return sse([completed()])
      },
    })
    expect(await collect(stream(request))).toEqual([{ type: "cancelled" }])
    expect(requests).toBe(0)
  })

  it.each([
    [[], "stream_protocol"],
    [
      [
        {
          type: "response.failed",
          response: {
            ...completed().response,
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Plan limit reached",
            },
          },
        },
      ],
      "subscription_sharing_usage_limit_exceeded",
    ],
  ])("requires a completed stream or reports the terminal failure", async (events, code) => {
    const stream = createChatGPTPlanProvider({
      auth: { resolve: async () => access },
      fetchFn: async () => sse(events as unknown[]),
    })
    const result = await collect(stream(request))
    expect(result.some((event) => event.type === "response")).toBe(false)
    expect(result.at(-1)).toMatchObject({ type: "failure" })
    if (code !== "stream_protocol")
      expect(result.at(-1)).toMatchObject({ failure: { providerCode: code } })
  })

  it("lets the Yak retry owner recover an interrupted stream", async () => {
    let attempts = 0
    const provider = createChatGPTPlanProvider({
      auth: { resolve: async () => access },
      fetchFn: async () => sse(++attempts === 1 ? [] : [completed()]),
    })
    const stream = createModelRequestStream(provider, {
      wireApi: "openai_responses",
      maxAttempts: 2,
      baseDelayMs: 0,
    })
    const events = await collect(stream(request))
    expect(attempts).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: "response" })
  })

  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429, 1],
    ["subscription_sharing_usage_unavailable", 503, 2],
    ["subscription_sharing_user_unavailable", 503, 2],
  ] as const)("applies plan-specific recovery for %s", async (code, status, expectedAttempts) => {
    for (const transport of ["http", "sse"] as const) {
      let attempts = 0
      const provider = createChatGPTPlanProvider({
        auth: { resolve: async () => access },
        fetchFn: async () => {
          if (++attempts > 1) return sse([completed()])
          const error = { code, message: "fake failure" }
          return transport === "http"
            ? Response.json({ error }, { status })
            : sse([
                {
                  type: "response.failed",
                  response: {
                    ...completed().response,
                    status: "failed",
                    error,
                  },
                },
              ])
        },
      })
      const events = await collect(
        createModelRequestStream(provider, {
          wireApi: "openai_responses",
          maxAttempts: 2,
          baseDelayMs: 0,
        })(request),
      )
      expect(attempts).toBe(expectedAttempts)
      expect(events.at(-1)).toMatchObject({
        type: expectedAttempts === 1 ? "failure" : "response",
      })
    }
  })

  it("rejects foreign namespaces before committing any output tool", async () => {
    const stream = createChatGPTPlanProvider({
      auth: { resolve: async () => access },
      fetchFn: async () =>
        sse([
          completed([
            {
              id: "t1",
              type: "function_call",
              call_id: "c1",
              name: "shell",
              namespace: "foreign",
              arguments: "{}",
              status: "completed",
            },
          ]),
        ]),
    })
    const events = await collect(
      stream({ ...request, streamOutputItems: true }),
    )
    expect(
      events.some(
        (event) => event.type === "output_item" || event.type === "response",
      ),
    ).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "failure" })
  })

  it("does not expose the API-key warmup transport for the subscription route", () => {
    const transport = createOpenAITurnTransport({
      apiKey: "fake",
      model: "gpt-fake",
      requestProfile: "chatgpt-plan",
    })
    expect(transport.warmup).toBeUndefined()
    transport.close()
  })

  it("drops unsupported API-key fields and rejects unsupported tool/history forms", () => {
    const body = toChatGPTPlanRequest({
      model: "gpt-fake",
      input: [],
      stream: true,
      temperature: 1,
      metadata: { private: "x" },
      max_output_tokens: 100,
      previous_response_id: "old",
      store: true,
    })
    for (const key of [
      "temperature",
      "metadata",
      "max_output_tokens",
      "previous_response_id",
    ])
      expect(body).not.toHaveProperty(key)
    expect(() =>
      toChatGPTPlanRequest({
        model: "gpt-fake",
        input: [],
        stream: true,
        tools: [{ type: "tool_search", execution: "client" }],
      }),
    ).toThrow("local function/custom")
    expect(() =>
      toChatGPTPlanRequest({
        model: "gpt-fake",
        input: [{ role: "system", content: "No" }],
        stream: true,
      }),
    ).toThrow("developer")
  })
})
