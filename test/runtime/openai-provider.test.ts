import type OpenAI from "openai"
import type { Response } from "openai/resources/responses/responses"
import { describe, expect, it } from "vitest"
import {
  createOpenAIProvider,
  fromOpenAIResponse,
  ModelStopReason,
  toOpenAIInput,
  toOpenAITools,
  type ModelRequest,
} from "../../src/index.ts"

describe("OpenAI Responses provider", () => {
  it("converts internal history and function tools", () => {
    expect(
      toOpenAIInput([
        { role: "user", content: [{ type: "text", text: "read" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            {
              type: "tool_call",
              id: "call_1",
              name: "read_file",
              input: { path: "a.txt" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          content: "not found",
          isError: true,
        },
      ]),
    ).toEqual([
      { role: "user", content: "read" },
      { role: "assistant", content: "checking" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "[tool_error]\nnot found",
      },
    ])
    expect(
      toOpenAITools([
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", additionalProperties: false },
        strict: false,
      },
    ])
  })

  it("maps text, function calls, usage, and incomplete responses", () => {
    expect(
      fromOpenAIResponse(
        responseFixture({
          output: [
            {
              type: "message",
              id: "message_1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "hello", annotations: [] },
              ],
            },
            {
              type: "function_call",
              id: "item_1",
              call_id: "call_1",
              name: "read_file",
              arguments: '{"path":"a.txt"}',
              status: "completed",
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      ),
    ).toEqual({
      stopReason: ModelStopReason.ToolUse,
      content: [
        { type: "text", text: "hello" },
        {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          input: { path: "a.txt" },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 4 },
      providerRequestId: "response_1",
    })

    expect(
      fromOpenAIResponse(
        responseFixture({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ).stopReason,
    ).toBe(ModelStopReason.Length)
  })

  it("streams full snapshots and uses the request's pinned model", async () => {
    let body: unknown
    const client = {
      responses: {
        async create(input: unknown) {
          body = input
          return (async function* () {
            yield { type: "response.output_text.delta", delta: "Hel" }
            yield { type: "response.output_text.delta", delta: "lo" }
            yield {
              type: "response.completed",
              response: responseFixture({
                output: [
                  {
                    type: "message",
                    id: "message_1",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Hello", annotations: [] },
                    ],
                  },
                ],
              }),
            }
          })()
        },
      },
    } as unknown as OpenAI
    const stream = createOpenAIProvider({
      apiKey: "test",
      model: "gpt-default",
      client,
    })

    const events = []
    for await (const event of stream(requestFixture())) events.push(event)

    expect(events).toEqual([
      { type: "snapshot", text: "Hel" },
      { type: "snapshot", text: "Hello" },
      {
        type: "response",
        response: expect.objectContaining({
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Hello" }],
        }),
      },
    ])
    expect(body).toMatchObject({
      model: "gpt-request",
      stream: true,
      store: false,
      parallel_tool_calls: false,
    })
  })
})

function requestFixture(): ModelRequest {
  return {
    provider: "openai",
    model: "gpt-request",
    system: "Be helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  }
}

function responseFixture(
  overrides: {
    readonly status?: Response["status"]
    readonly output?: Response["output"]
    readonly incomplete_details?: Response["incomplete_details"]
    readonly usage?: {
      readonly input_tokens: number
      readonly output_tokens: number
    }
  } = {},
): Response {
  return {
    id: "response_1",
    status: overrides.status ?? "completed",
    output: overrides.output ?? [],
    incomplete_details: overrides.incomplete_details ?? null,
    usage:
      overrides.usage === undefined
        ? undefined
        : {
            ...overrides.usage,
            total_tokens:
              overrides.usage.input_tokens + overrides.usage.output_tokens,
            input_tokens_details: {
              cached_tokens: 0,
              cache_write_tokens: 0,
            },
            output_tokens_details: { reasoning_tokens: 0 },
          },
    error: null,
  } as unknown as Response
}
