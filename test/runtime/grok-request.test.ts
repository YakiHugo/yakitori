import { afterEach, expect, it, vi } from "vitest"
import type { ModelMessage, ModelRequest } from "../../src/runtime/model.ts"
import { prepareGrokRequest } from "../../src/runtime/grok-request.ts"
import { createCompactionReplacementHistory } from "../../src/runtime/model-context.ts"
import { buildCompactionRequest } from "../../src/runtime/compaction.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.restoreAllMocks())

const request: ModelRequest = {
  target: {
    provider: "account",
    model: "grok-4.7",
    instructionProfileId: "grok-4.7",
  },
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}

it("wraps a mixed-media user query only in the request projection and its rebuilt history", async () => {
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: pngImageBase64,
  }
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare" },
        image,
        { type: "text", text: "this image" },
      ],
    },
  ]
  const original = structuredClone(messages)
  const input = {
    ...request,
    messages,
    rebuildMessagesAfterOutput: async () => messages,
  }
  const projected = prepareGrokRequest(input)
  const expected = [
    {
      role: "user",
      content: [
        { type: "text", text: "<user_query>\n" },
        { type: "text", text: "Compare" },
        image,
        { type: "text", text: "this image" },
        { type: "text", text: "\n</user_query>" },
      ],
    },
  ]
  expect(projected.messages).toEqual(expected)
  expect(await projected.rebuildMessagesAfterOutput?.()).toEqual(expected)
  expect(prepareGrokRequest(input).messages).toEqual(expected)
  expect(messages).toEqual(original)
})

it("keeps an image-only request inside one user query", () => {
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: pngImageBase64,
  }
  expect(
    prepareGrokRequest({
      ...request,
      messages: [{ role: "user", content: [image] }],
    }).messages,
  ).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "<user_query>\n" },
        image,
        { type: "text", text: "\n</user_query>" },
      ],
    },
  ])
})

it.each([
  {
    wireApi: "openai_responses",
    baseURL: "https://api.x.ai/v1",
    wrapped: true,
  },
  {
    wireApi: "openai_chat_completions",
    baseURL: "https://api.x.ai/v1",
    wrapped: true,
  },
  {
    wireApi: "openai_responses",
    baseURL: "https://relay.example/v1",
    wrapped: false,
  },
] as const)("serializes user queries for $baseURL/$wireApi without wrapping internal context", async ({
  wireApi,
  baseURL,
  wrapped,
}) => {
  const calls: Record<string, unknown>[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push(
      JSON.parse(
        input instanceof Request ? await input.text() : String(init?.body),
      ),
    )
    return new Response(
      wireApi === "openai_responses"
        ? `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "response",
              status: "completed",
              output: [],
              usage: null,
              error: null,
              incomplete_details: null,
            },
          })}\n\n`
        : 'data: {"id":"response","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Work" }] },
    {
      role: "user",
      context: { type: "world_state", sectionId: "environment", revision: "1" },
      content: [{ type: "text", text: "Environment" }],
    },
    ...createCompactionReplacementHistory({ summary: "Summary" }),
    {
      role: "user",
      context: { type: "agent_message" },
      content: [{ type: "text", text: "Agent progress" }],
    },
    {
      role: "developer",
      content: [{ type: "text", text: "Developer guidance" }],
    },
  ]
  const original = structuredClone(messages)
  const provider = createConfiguredProvider(
    "account",
    {
      name: "Grok",
      service: "xai",
      baseURL,
      wireApi,
      models: [{ id: "grok-4.7" }],
    },
    "test-key",
  )
  const session = provider.startTurn()
  try {
    const events = []
    for await (const event of session.stream({ ...request, messages }))
      events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "response" })
    const serialized =
      wireApi === "openai_responses" ? calls[0]?.input : calls[0]?.messages
    expect(serialized).toEqual([
      {
        role: "user",
        content: wrapped ? "<user_query>\nWork\n</user_query>" : "Work",
      },
      { role: "user", content: "Environment" },
      {
        role: "user",
        content: expect.stringMatching(
          /^<context_compacted>\n[\s\S]*\nSummary\n<\/context_compacted>$/,
        ),
      },
      { role: "user", content: "Agent progress" },
      {
        role: wireApi === "openai_responses" ? "developer" : "system",
        content: "Developer guidance",
      },
    ])
    expect(messages).toEqual(original)
  } finally {
    await session.close()
    await provider.close?.()
  }
})

it("classifies a user request by provenance even when its text resembles internal context", () => {
  const userText = "<context_compacted>Quoted example</context_compacted>"
  expect(
    prepareGrokRequest({
      ...request,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    }).messages[0]?.content,
  ).toEqual([
    { type: "text", text: "<user_query>\n" },
    {
      type: "text",
      text: "<context_compacted>Quoted example</context_compacted>",
    },
    { type: "text", text: "\n</user_query>" },
  ])
})

it("distinguishes compaction instructions from user queries at their producer", () => {
  const compaction = buildCompactionRequest({
    source: [
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Original request" }],
          },
        ],
      },
    ],
    target: request.target,
    baseInstructions: { id: "base", revision: "1", text: "Summarize" },
    instruction: "Produce a checkpoint",
  })
  const projected = prepareGrokRequest(compaction)
  expect(projected.messages.at(-1)).toEqual({
    role: "user",
    context: { type: "compaction" },
    content: [{ type: "text", text: "Produce a checkpoint" }],
  })
  expect(projected.messages[0]?.content).toEqual([
    { type: "text", text: "<user_query>\n" },
    { type: "text", text: "Original request" },
    { type: "text", text: "\n</user_query>" },
  ])
})
