import Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it } from "vitest"
import {
  createAnthropicProvider,
  fromAnthropicMessage,
  ModelStopReason,
  toAnthropicMessages,
  toAnthropicSystem,
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

  it("maps summarized and redacted thinking with continuation metadata", () => {
    expect(
      fromAnthropicMessage({
        stop_reason: "end_turn",
        content: [
          {
            type: "thinking",
            thinking: "Inspect the event log.",
            signature: "signature_1",
          },
          { type: "redacted_thinking", data: "redacted_1" },
          { type: "text", text: "Done." },
        ],
      }).content,
    ).toEqual([
      {
        type: "reasoning",
        text: "Inspect the event log.",
        providerMetadata: {
          anthropic: { signature: "signature_1" },
        },
      },
      {
        type: "reasoning",
        text: "",
        providerMetadata: {
          anthropic: { redactedData: "redacted_1" },
        },
      },
      { type: "text", text: "Done." },
    ])

    expect(
      toAnthropicMessages([
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Inspect the event log.",
              providerMetadata: {
                anthropic: { signature: "signature_1" },
              },
            },
            {
              type: "reasoning",
              text: "",
              providerMetadata: {
                anthropic: { redactedData: "redacted_1" },
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Inspect the event log.",
            signature: "signature_1",
          },
          { type: "redacted_thinking", data: "redacted_1" },
        ],
      },
    ])
  })

  it("requests and streams summarized adaptive thinking", async () => {
    let body: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(input: Record<string, unknown>) {
          body = input
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "content_block_delta",
                delta: { type: "thinking_delta", thinking: "Inspect" },
              }
              yield {
                type: "content_block_delta",
                delta: { type: "thinking_delta", thinking: " files" },
              }
            },
            async finalMessage() {
              return {
                id: "msg_reasoning",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "Done." }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-sonnet-4-6",
      client,
    })
    const request: ModelRequest = {
      target: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        promptId: "anthropic",
      },
      system: [],
      contextual: [],
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [],
    }

    const events: ModelStreamEvent[] = []
    for await (const event of stream(request)) events.push(event)

    expect(body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
    })
    expect(events).toEqual([
      { type: "reasoning_snapshot", text: "Inspect" },
      { type: "reasoning_snapshot", text: "Inspect files" },
      expect.objectContaining({ type: "response" }),
    ])
  })

  it("places cache breakpoints after tools, stable system prefixes, and dynamic history", async () => {
    let body: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(input: Record<string, unknown>) {
          body = input
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_cache",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client,
    })
    const request: ModelRequest = {
      target: {
        provider: "anthropic",
        model: "claude-test",
        promptId: "anthropic",
      },
      system: [
        { id: "base", revision: "base-1", text: "base" },
        { id: "environment", revision: "environment-1", text: "environment" },
      ],
      contextual: [
        {
          id: "project.instructions",
          revision: "project-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "project rules" }],
          },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ],
    }

    for await (const _event of stream(request)) void _event

    expect(body).toMatchObject({
      system: [
        {
          type: "text",
          text: "base",
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "environment",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        expect.objectContaining({
          name: "read_file",
          cache_control: { type: "ephemeral" },
        }),
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "project rules",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    })
  })

  it("moves the dynamic breakpoint through a tool loop", async () => {
    let body: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(input: Record<string, unknown>) {
          body = input
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_tool_cache",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client,
    })

    for await (const _event of stream({
      target: {
        provider: "anthropic",
        model: "claude-test",
        promptId: "anthropic",
      },
      system: [{ id: "base", revision: "base-1", text: "base" }],
      contextual: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "read" }] },
        {
          role: "assistant",
          content: [
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
      ],
      tools: [],
    })) {
      void _event
    }

    expect(body?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "read" }],
      },
      {
        role: "assistant",
        content: [
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
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  it("keeps cache-control extensions off Anthropic-compatible providers", () => {
    const request: ModelRequest = {
      target: {
        provider: "kimi",
        model: "kimi-for-coding",
        promptId: "kimi",
      },
      system: [
        { id: "base", revision: "base-1", text: "base" },
        { id: "environment", revision: "environment-1", text: "environment" },
      ],
      contextual: [],
      messages: [],
      tools: [],
    }

    expect(toAnthropicSystem(request.system)).toBe("base\n\nenvironment")
  })

  it("adds output_config and the effort beta header for official anthropic", async () => {
    let body: Record<string, unknown> | undefined
    let options: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts: Record<string, unknown>) {
          body = input
          options = opts
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_effort",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client,
    })

    for await (const _event of stream(effortRequest("anthropic", "high")))
      void _event

    expect(body).toMatchObject({
      model: "claude-test",
      output_config: { effort: "high" },
    })
    expect(options).toMatchObject({
      headers: { "anthropic-beta": "effort-2025-11-24" },
    })
  })

  it("omits output_config and the beta header without an effort", async () => {
    let body: Record<string, unknown> | undefined
    let options: unknown = "not-passed"
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts?: unknown) {
          body = input
          options = opts ?? "not-passed"
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_no_effort",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client,
    })

    for await (const _event of stream(effortRequest("anthropic", undefined)))
      void _event

    expect(body).not.toHaveProperty("output_config")
    expect(options).toBe("not-passed")
  })

  it("sends the effort beta for the kimi coding endpoint", async () => {
    let body: Record<string, unknown> | undefined
    let options: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts: Record<string, unknown>) {
          body = input
          options = opts
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_kimi_effort",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "kimi-for-coding",
      client,
    })

    for await (const _event of stream(effortRequest("kimi", "max"))) void _event

    expect(body).toMatchObject({
      model: "kimi-for-coding",
      output_config: { effort: "max" },
    })
    expect(options).toMatchObject({
      headers: { "anthropic-beta": "effort-2025-11-24" },
    })
    // Cache-control stays official-Anthropic-only, even with effort.
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("omits output_config and the beta header for kimi without an effort", async () => {
    let body: Record<string, unknown> | undefined
    let options: unknown = "not-passed"
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts?: unknown) {
          body = input
          options = opts ?? "not-passed"
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_kimi_plain",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "kimi-for-coding",
      client,
    })

    for await (const _event of stream(effortRequest("kimi", undefined)))
      void _event

    expect(body).not.toHaveProperty("output_config")
    expect(options).toBe("not-passed")
  })

  it("maps effort off to thinking.disabled without the beta header", async () => {
    let body: Record<string, unknown> | undefined
    let options: unknown = "not-passed"
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts?: unknown) {
          body = input
          options = opts ?? "not-passed"
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_kimi_off",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "kimi-for-coding",
      client,
    })

    for await (const _event of stream(effortRequest("kimi", "off"))) void _event

    expect(body).toMatchObject({ thinking: { type: "disabled" } })
    expect(body).not.toHaveProperty("output_config")
    // The effort beta header belongs to output_config only.
    expect(options).toBe("not-passed")
  })

  it("sends nothing for effort on (the endpoint default)", async () => {
    let body: Record<string, unknown> | undefined
    let options: unknown = "not-passed"
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts?: unknown) {
          body = input
          options = opts ?? "not-passed"
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_kimi_on",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "kimi-for-coding",
      client,
    })

    for await (const _event of stream(effortRequest("kimi", "on"))) void _event

    expect(body).not.toHaveProperty("output_config")
    expect(body).not.toHaveProperty("thinking")
    expect(options).toBe("not-passed")
  })

  it("omits the effort beta for compatible-but-not-official providers", async () => {
    let body: Record<string, unknown> | undefined
    let options: unknown = "not-passed"
    const client = {
      messages: {
        stream(input: Record<string, unknown>, opts?: unknown) {
          body = input
          options = opts ?? "not-passed"
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return {
                id: "msg_other_effort",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              }
            },
          }
        },
      },
    } as unknown as Anthropic
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "other-model",
      client,
    })

    for await (const _event of stream(effortRequest("other", "high")))
      void _event

    expect(body).not.toHaveProperty("output_config")
    expect(options).toBe("not-passed")
  })
})

function effortRequest(
  provider: string,
  effort: string | undefined,
): ModelRequest {
  const known: Record<
    string,
    { readonly model: string; readonly promptId: string }
  > = {
    anthropic: { model: "claude-test", promptId: "anthropic" },
    kimi: { model: "kimi-for-coding", promptId: "kimi" },
  }
  const target = known[provider] ?? {
    model: "other-model",
    promptId: "default",
  }
  return {
    target: {
      provider,
      model: target.model,
      promptId: target.promptId,
      ...(effort === undefined ? {} : { effort }),
    },
    system: [{ id: "base", revision: "base-1", text: "Be helpful." }],
    contextual: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  }
}

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
    target: {
      provider: "anthropic",
      model: "claude-test",
      promptId: "anthropic",
    },
    system: [{ id: "base", revision: "base-1", text: "Be helpful." }],
    contextual: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  }
  const events: ModelStreamEvent[] = []
  for await (const event of stream(request)) events.push(event)
  return events
}
