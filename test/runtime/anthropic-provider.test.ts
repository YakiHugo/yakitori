import Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it } from "vitest"
import {
  createAnthropicProvider,
  fromAnthropicMessage,
  ModelStopReason,
  toAnthropicMessages,
  toAnthropicTools,
  type ModelRequest,
  type ModelStreamEvent,
} from "../../src/index.ts"

describe("anthropic provider conversion", () => {
  it("builds Anthropic messages from internal history with tools and results", () => {
    const messages = toAnthropicMessages([
      {
        role: "user",
        content: [{ type: "text", text: "read it" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "sure" },
          {
            type: "tool_call",
            id: "tool_1",
            name: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "tool_1",
        content: "file body",
      },
    ])

    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "read it" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "sure" },
          {
            type: "tool_use",
            id: "tool_1",
            name: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "file body",
          },
        ],
      },
    ])

    expect(
      toAnthropicTools([
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ]),
    ).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object" },
      },
    ])
  })

  it("maps text, tool use, length, and usage from fixture messages", () => {
    expect(
      fromAnthropicMessage({
        id: "msg_1",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 },
        content: [{ type: "text", text: "hello" }],
      }),
    ).toEqual({
      stopReason: ModelStopReason.EndTurn,
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 10, outputTokens: 4 },
      providerRequestId: "msg_1",
    })

    expect(
      fromAnthropicMessage({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "read_file",
            input: { path: "x" },
          },
        ],
      }),
    ).toMatchObject({
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "tool_1",
          name: "read_file",
          input: { path: "x" },
        },
      ],
    })

    expect(
      fromAnthropicMessage({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "cut" }],
      }).stopReason,
    ).toBe(ModelStopReason.Length)
  })
})

describe("anthropic provider error classification", () => {
  it("marks a 429 API error as retryable with its status", async () => {
    const error = new Anthropic.APIError(
      429,
      undefined,
      undefined,
      new Headers(),
    )

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "anthropic_error",
            message: error.message,
            details: { retryable: true, status: 429 },
          },
        },
      },
    ])
  })

  it("keeps a 400 API error free of retry details", async () => {
    const error = new Anthropic.APIError(
      400,
      undefined,
      undefined,
      new Headers(),
    )

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: { code: "anthropic_error", message: error.message },
        },
      },
    ])
  })

  it("marks connection errors without a status as retryable", async () => {
    const error = new Anthropic.APIConnectionError({
      message: "socket hang up",
    })

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "anthropic_error",
            message: error.message,
            details: { retryable: true },
          },
        },
      },
    ])
  })

  it("marks a mid-stream overloaded_error API error as retryable by type", async () => {
    // The SDK throws an APIError with an undefined status for mid-stream SSE
    // error events; only the body type classifies them.
    const error = new Anthropic.APIError(
      undefined,
      undefined,
      undefined,
      new Headers(),
      "overloaded_error",
    )
    const client = {
      messages: {
        stream() {
          return (async function* () {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "par" },
            }
            throw error
          })()
        },
      },
    } as unknown as Anthropic

    const events = await collectWithClient(client)

    expect(events).toEqual([
      { type: "snapshot", text: "par" },
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "anthropic_error",
            message: error.message,
            details: { retryable: true, type: "overloaded_error" },
          },
        },
      },
    ])
  })
})

async function collectWithThrowingClient(
  error: unknown,
): Promise<ModelStreamEvent[]> {
  const client = {
    messages: {
      stream() {
        throw error
      },
    },
  } as unknown as Anthropic
  return collectWithClient(client)
}

async function collectWithClient(
  client: Anthropic,
): Promise<ModelStreamEvent[]> {
  const stream = createAnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    client,
  })

  const request: ModelRequest = {
    provider: "anthropic",
    model: "claude-test",
    system: "Be helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  }
  const events: ModelStreamEvent[] = []
  for await (const event of stream(request)) events.push(event)
  return events
}
