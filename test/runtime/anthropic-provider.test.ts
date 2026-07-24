import { describe, expect, it } from "vitest"
import {
  fromAnthropicMessage,
  ModelStopReason,
  toAnthropicMessages,
  toAnthropicTools,
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
