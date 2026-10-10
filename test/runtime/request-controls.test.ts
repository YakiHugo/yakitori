import { createServer } from "node:http"
import { expect, it } from "vitest"
import { isJsonObject, type JsonObject } from "../../src/kernel/index.ts"
import { createAnthropicProvider } from "../../src/runtime/anthropic-provider.ts"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createGeminiProvider } from "../../src/runtime/gemini-provider.ts"
import type { ModelNativeItem, ModelRequest } from "../../src/runtime/model.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"

const apis: ModelNativeItem["wireApi"][] = [
  "openai_responses",
  "openai_chat_completions",
  "anthropic_messages",
  "gemini_generate_content",
]

it.each(
  apis,
)("serializes common controls and native extensions through the %s HTTP boundary", async (api) => {
  let body: JsonObject | undefined
  let beta: string | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!isJsonObject(parsed)) throw new Error("Invalid request")
    body = parsed
    beta = String(request.headers["anthropic-beta"] ?? "")
    response.writeHead(400, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        error: { message: "Captured request", type: "invalid_request_error" },
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
    api === "openai_responses"
      ? createOpenAIProvider(options)
      : api === "anthropic_messages"
        ? createAnthropicProvider(options)
        : api === "openai_chat_completions"
          ? createChatCompletionsProvider(options)
          : createGeminiProvider(options)
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const provider = api === "anthropic_messages" ? "anthropic" : "test"
  const nativeText: JsonObject = { type: "text", text: "Previous answer" }
  const input: ModelRequest = {
    target: { provider, model: "test", instructionProfileId: "test" },
    continuationScope: "owner",
    messages:
      api === "anthropic_messages"
        ? [
            {
              role: "assistant",
              content: [{ type: "text", text: "Previous answer" }],
              native: [
                {
                  provider,
                  model: "test",
                  scope: "owner",
                  wireApi: api,
                  value: nativeText,
                },
              ],
            },
          ]
        : [],
    system: [],
    toolWireProtocol: "eager",
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    toolChoice: { name: "inspect" },
    parallelToolCalls: true,
    outputFormat: { type: "json_schema", name: "answer", schema },
    providerOptions: {
      provider,
      wireApi: api,
      body:
        api === "gemini_generate_content"
          ? {
              generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
              tools: [{ googleSearch: {} }],
            }
          : api === "anthropic_messages"
            ? {
                thinking: { type: "enabled", budget_tokens: 2048 },
                tools: [{ type: "web_search_20250305", name: "web_search" }],
              }
            : { reasoning: { enabled: true }, tools: [{ type: "web_search" }] },
      ...(api === "anthropic_messages" ? { betas: ["test-feature"] } : {}),
    },
  }
  try {
    for await (const event of stream(input))
      if (event.type === "failure")
        expect(event.failure.details).toMatchObject({
          providerMessage: "Captured request",
        })
    expect(body).toBeDefined()
    if (api === "anthropic_messages") {
      expect(body?.messages).toMatchObject([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Previous answer",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ])
      expect(nativeText).toEqual({ type: "text", text: "Previous answer" })
    }
    if (api === "openai_responses")
      expect(body).toMatchObject({
        tool_choice: { type: "function", name: "inspect" },
        parallel_tool_calls: true,
        text: {
          format: { type: "json_schema", name: "answer", schema, strict: true },
        },
        tools: [{ type: "function", strict: true }, { type: "web_search" }],
        reasoning: { enabled: true },
      })
    else if (api === "openai_chat_completions") {
      expect(body).toMatchObject({
        tool_choice: { type: "function", function: { name: "inspect" } },
        parallel_tool_calls: true,
        response_format: {
          type: "json_schema",
          json_schema: { schema, strict: true },
        },
        tools: [
          { type: "function", function: { strict: true } },
          { type: "web_search" },
        ],
      })
      for await (const event of stream({
        ...input,
        tools: [],
        toolChoice: "none",
      }))
        expect(event.type).toBe("failure")
      expect(body).toMatchObject({
        tool_choice: "none",
        tools: [{ type: "web_search" }],
      })
    } else if (api === "anthropic_messages") {
      expect(body).toMatchObject({
        tool_choice: {
          type: "tool",
          name: "inspect",
          disable_parallel_tool_use: false,
        },
        thinking: { type: "enabled", budget_tokens: 2048 },
        output_config: { format: { type: "json_schema", schema } },
        tools: [{ name: "inspect", strict: true }, { name: "web_search" }],
      })
      expect(beta).toContain("test-feature")
    } else
      expect(body).toMatchObject({
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["inspect"],
          },
        },
        generationConfig: {
          candidateCount: 1,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
        tools: [
          { functionDeclarations: [{ name: "inspect" }] },
          { googleSearch: {} },
        ],
      })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it.each([
  { provider: "foreign", wireApi: "openai_responses" as const, body: {} },
  { provider: "test", wireApi: "openai_chat_completions" as const, body: {} },
  {
    provider: "test",
    wireApi: "openai_responses" as const,
    body: { input: [] },
  },
])("rejects provider controls that change owner, protocol or execution-loop input", async (providerOptions) => {
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: "test",
    baseURL: "http://127.0.0.1:1",
  })
  const events = []
  for await (const event of stream({
    target: { provider: "test", model: "test", instructionProfileId: "test" },
    messages: [],
    tools: [],
    system: [],
    toolWireProtocol: "eager",
    providerOptions,
  }))
    events.push(event)
  expect(events).toMatchObject([
    {
      type: "failure",
      failure: { stage: "request_build", kind: "invalid_request" },
    },
  ])
})
