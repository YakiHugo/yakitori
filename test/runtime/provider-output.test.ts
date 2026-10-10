import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { describe, expect, it } from "vitest"
import {
  createAnthropicProvider,
  toAnthropicMessages,
} from "../../src/runtime/anthropic-provider.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"

describe("provider output completeness", () => {
  it.each([
    '{"path":"b.txt","content":"hello"',
    '{"path":"b.txt","content":"hel',
  ])("keeps the committed Anthropic prefix and rejects an unfinished tool input (%s)", async (input) => {
    const stream = anthropicStream([
      anthropicStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Inspecting." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_done",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "call_tail",
          name: "write_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: input },
      },
      { type: "content_block_stop", index: 2 },
      ...anthropicFinish("max_tokens"),
    ])
    const events = await collect(stream, request("anthropic"))
    const prefix = [
      { type: "text", text: "Inspecting." },
      {
        type: "tool_call",
        id: "call_done",
        name: "read_file",
        input: { path: "a.txt" },
      },
    ]
    expect(
      events
        .filter((event) => event.type === "output_item")
        .flatMap((event) => event.content),
    ).toEqual(prefix)
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        lengthReason: "output",
        rawStopReason: "max_tokens",
        incompleteToolCalls: true,
        content: prefix,
        usage: { inputTokens: 7, outputTokens: 12 },
      },
    })
  })

  it("publishes an Anthropic call before the provider delivers its terminal event", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        value.enqueue(
          new TextEncoder().encode(
            sse([
              anthropicStart(),
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "call_done",
                  name: "read_file",
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: '{"path":"a.txt"}',
                },
              },
              { type: "content_block_stop", index: 0 },
            ]),
          ),
        )
      },
    })
    const stream = createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client: new Anthropic({
        apiKey: "test",
        maxRetries: 0,
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      }),
    })
    const iterator = stream(request("anthropic"))[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({
      type: "output_item",
      content: [
        { type: "tool_call", id: "call_done", input: { path: "a.txt" } },
      ],
    })
    if (controller === undefined) throw new Error("Missing stream controller")
    controller.enqueue(
      new TextEncoder().encode(sse(anthropicFinish("max_tokens"))),
    )
    controller.close()
    expect((await iterator.next()).value).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        content: [{ type: "tool_call", id: "call_done" }],
      },
    })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it("retains partial Anthropic text without claiming an open block is complete", async () => {
    const events = await collect(
      anthropicStream([
        anthropicStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "An unfinished answer" },
        },
        ...anthropicFinish("max_tokens"),
      ]),
      request("anthropic"),
    )
    expect(
      events.filter((event) => event.type === "output_item"),
    ).toMatchObject([])
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "An unfinished answer" }],
      },
    })
  })

  it("replays the final complete Anthropic signature rather than concatenating snapshots", async () => {
    const events = await collect(
      anthropicStream([
        anthropicStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Inspect files" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "earlier_signature" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "complete_signature" },
        },
        { type: "content_block_stop", index: 0 },
        ...anthropicFinish("end_turn"),
      ]),
      { ...request("anthropic"), continuationScope: "backend_1" },
    )
    const terminal = events.at(-1)
    if (terminal?.type !== "response") throw new Error("Missing response")
    expect(
      toAnthropicMessages(
        [{ role: "assistant", content: terminal.response.content }],
        true,
        undefined,
        "anthropic",
        "backend_1",
      ),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Inspect files",
            signature: "complete_signature",
          },
        ],
      },
    ])
  })

  it.each([
    undefined,
    "partial_signature",
  ])("preserves open Anthropic thinking without replaying its unproven signature (%s)", async (signature) => {
    const events = await collect(
      anthropicStream([
        anthropicStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Partial reasoning" },
        },
        ...(signature === undefined
          ? []
          : [
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature },
              },
            ]),
        ...anthropicFinish("max_tokens"),
      ]),
      request("anthropic"),
    )
    const terminal = events.at(-1)
    if (terminal?.type !== "response") throw new Error("Missing response")
    expect(terminal.response.content).toEqual([
      { type: "reasoning", text: "Partial reasoning" },
    ])
    expect(
      toAnthropicMessages([
        { role: "assistant", content: terminal.response.content },
      ]),
    ).toEqual([])
  })

  it("rejects an Anthropic signature delta for a non-thinking block", async () => {
    const events = await collect(
      anthropicStream([
        anthropicStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "misplaced_signature" },
        },
      ]),
      request("anthropic"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
      usage: { inputTokens: 7, outputTokens: 0 },
    })
  })

  it.each([
    null,
    "unknown",
  ])("fails an unsupported Anthropic terminal reason explicitly (%s)", async (reason) => {
    const events = await collect(
      anthropicStream([anthropicStart(), ...anthropicFinish(reason)]),
      request("anthropic"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
      usage: { inputTokens: 7, outputTokens: 12 },
    })
    expect(events.some((event) => event.type === "response")).toBe(false)
  })

  it.each([
    ["refusal", ModelStopReason.ContentFilter, undefined],
    ["model_context_window_exceeded", ModelStopReason.Length, "context"],
  ])("distinguishes Anthropic refusals and exhausted context (%s)", async (reason, stopReason, lengthReason) => {
    const events = await collect(
      anthropicStream([
        anthropicStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Provider explanation" },
        },
        { type: "content_block_stop", index: 0 },
        ...anthropicFinish(reason),
      ]),
      request("anthropic"),
    )
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: "response",
      response: {
        stopReason,
        rawStopReason: reason,
        content: [{ type: "text", text: "Provider explanation" }],
      },
    })
    if (terminal?.type !== "response") throw new Error("Missing response")
    expect(terminal.response.lengthReason).toBe(lengthReason)
  })

  it.each([
    "anthropic",
    "openai",
  ])("preserves %s filtered text and discards its unfinished tool tail", async (provider) => {
    const text = "Cannot help with that."
    const frames =
      provider === "anthropic"
        ? [
            anthropicStart(),
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "call_tail",
                name: "write_file",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: '{"path":"unfinished.txt"}',
              },
            },
            ...anthropicFinish("refusal"),
          ]
        : [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "message_filtered",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "message_filtered",
              delta: text,
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: {
                type: "function_call",
                id: "tool_tail",
                call_id: "call_tail",
                name: "write_file",
                arguments: '{"path":"unfinished.txt"',
                status: "in_progress",
              },
            },
            openaiFinish("content_filter"),
          ]
    const events = await collect(
      provider === "anthropic" ? anthropicStream(frames) : openaiStream(frames),
      request(provider),
    )
    expect(
      events
        .filter((event) => event.type === "output_item")
        .flatMap((event) => event.content)
        .filter((block) => block.type === "tool_call"),
    ).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.ContentFilter,
        incompleteToolCalls: true,
        content: [{ type: "text", text }],
        usage: { inputTokens: 7, outputTokens: 12 },
      },
    })
  })

  it("treats a missing Anthropic message terminal as a disconnected stream", async () => {
    const transport = anthropicStream([
      anthropicStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "A complete prefix" },
      },
      { type: "content_block_stop", index: 0 },
    ])
    const stream = createModelRequestStream(transport, {
      wireApi: "anthropic_messages",
      maxAttempts: 1,
    })
    const events = await collect(stream, request("anthropic"))
    expect(events[0]).toMatchObject({
      type: "output_item",
      content: [{ type: "text", text: "A complete prefix" }],
    })
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "stream_disconnected", outputObserved: true },
    })
  })

  it("keeps OpenAI completed calls and partial deltas when a length terminal omits its output", async () => {
    const complete = {
      type: "function_call",
      id: "item_done",
      call_id: "call_done",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
      status: "completed",
    }
    const events = await collect(
      openaiStream([
        { type: "response.output_item.done", output_index: 0, item: complete },
        {
          type: "response.output_text.delta",
          item_id: "item_text",
          output_index: 1,
          content_index: 0,
          delta: "Partial answer",
        },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: {
            type: "function_call",
            id: "item_tail",
            call_id: "call_tail",
            name: "write_file",
            arguments: '{"path":"b.txt"',
            status: "in_progress",
          },
        },
        openaiFinish("max_output_tokens"),
      ]),
      request("codex"),
    )
    expect(
      events.filter((event) => event.type === "output_item"),
    ).toMatchObject([
      {
        type: "output_item",
        itemId: "item_done",
        content: [
          {
            type: "tool_call",
            id: "call_done",
            name: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
    ])
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        lengthReason: "unknown",
        incompleteToolCalls: true,
        content: [
          {
            type: "tool_call",
            id: "call_done",
            name: "read_file",
            input: { path: "a.txt" },
          },
          { type: "text", text: "Partial answer" },
        ],
      },
    })
  })

  it.each([
    { status: "incomplete", arguments: '{"path":"b.txt"}' },
    { status: "completed", arguments: '{"path":"b.txt"' },
  ])("does not commit OpenAI calls without complete items and complete JSON (%j)", async (tail) => {
    const item = {
      type: "function_call",
      id: "item_tail",
      call_id: "call_tail",
      name: "read_file",
      ...tail,
    }
    const events = await collect(
      openaiStream([
        { type: "response.output_item.done", output_index: 0, item },
        openaiFinish("max_output_tokens", [item]),
      ]),
      request("openai"),
    )
    expect(events.filter((event) => event.type === "output_item")).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        incompleteToolCalls: true,
        content: [],
      },
    })
  })

  it("keeps custom OpenAI calls pending until an output item completion", async () => {
    const events = await collect(
      openaiStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "custom_tool_call",
            id: "item_tail",
            call_id: "call_tail",
            name: "apply_patch",
            input: "*** Begin Patch",
          },
        },
        openaiFinish("max_output_tokens"),
      ]),
      request("openai"),
    )
    expect(events.filter((event) => event.type === "output_item")).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { incompleteToolCalls: true, content: [] },
    })
  })

  it("merges OpenAI deltas and authoritative terminal text once", async () => {
    const item = {
      type: "message",
      id: "item_text",
      role: "assistant",
      status: "incomplete",
      content: [
        { type: "output_text", text: "Partial answer", annotations: [] },
      ],
    }
    const events = await collect(
      openaiStream([
        {
          type: "response.output_text.delta",
          item_id: "item_text",
          output_index: 0,
          content_index: 0,
          delta: "Partial",
        },
        {
          type: "response.output_text.delta",
          item_id: "item_text",
          output_index: 0,
          content_index: 0,
          delta: " answer",
        },
        openaiFinish("max_output_tokens", [item]),
      ]),
      request("openai"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { content: [{ type: "text", text: "Partial answer" }] },
    })
  })

  it("retains refusal deltas as OpenAI refusal content", async () => {
    const events = await collect(
      openaiStream([
        {
          type: "response.refusal.delta",
          item_id: "refusal",
          output_index: 0,
          content_index: 0,
          delta: "Cannot help",
        },
        openaiFinish(undefined),
      ]),
      request("openai"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.ContentFilter,
        rawStopReason: "refusal",
        content: [{ type: "text", text: "Cannot help" }],
      },
    })
  })

  it("retains buffered OpenAI text when output_item.done is incomplete", async () => {
    const events = await collect(
      openaiStream([
        {
          type: "response.output_text.delta",
          item_id: "message_tail",
          output_index: 0,
          content_index: 0,
          delta: "A partial answer",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "message_tail",
            role: "assistant",
            status: "incomplete",
            content: [],
          },
        },
        openaiFinish("max_output_tokens"),
      ]),
      request("openai"),
    )
    expect(events.some((event) => event.type === "output_item")).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: { content: [{ type: "text", text: "A partial answer" }] },
    })
  })

  it("merges authoritative and buffered OpenAI content parts independently", async () => {
    const events = await collect(
      openaiStream([
        {
          type: "response.output_text.delta",
          item_id: "message_tail",
          output_index: 0,
          content_index: 0,
          delta: "First fragment",
        },
        {
          type: "response.refusal.delta",
          item_id: "message_tail",
          output_index: 0,
          content_index: 1,
          delta: "Cannot continue",
        },
        openaiFinish("max_output_tokens", [
          {
            type: "message",
            id: "message_tail",
            role: "assistant",
            status: "incomplete",
            content: [
              {
                type: "output_text",
                text: "Authoritative first part",
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ]),
      ]),
      request("openai"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        content: [
          { type: "text", text: "Authoritative first part" },
          { type: "text", text: "Cannot continue" },
        ],
      },
    })
  })

  it("fails an unknown OpenAI incomplete reason as a protocol failure", async () => {
    const events = await collect(
      openaiStream([openaiFinish("unexpected")]),
      request("openai"),
    )
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
      usage: { inputTokens: 7, outputTokens: 12 },
    })
  })

  it.each([
    ["max_prompt_tokens", "context"],
    ["max_time_limit", "unknown"],
  ] as const)("preserves Grok partial text and an unusable tool tail at %s", async (reason, lengthReason) => {
    const events = await collect(
      openaiStream([
        {
          type: "response.output_text.delta",
          item_id: "message_tail",
          output_index: 0,
          content_index: 0,
          delta: "Partial Grok answer",
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "tool_tail",
            call_id: "call_tail",
            name: "write_file",
            arguments: '{"path":"unfinished.txt"',
            status: "in_progress",
          },
        },
        openaiFinish(reason),
      ]),
      request("grok"),
    )
    expect(events.some((event) => event.type === "output_item")).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        stopReason: ModelStopReason.Length,
        rawStopReason: reason,
        lengthReason,
        incompleteToolCalls: true,
        content: [{ type: "text", text: "Partial Grok answer" }],
      },
    })
  })

  it.each([
    "max_prompt_tokens",
    "max_time_limit",
  ])("rejects the xAI-specific terminal reason %s for OpenAI", async (reason) => {
    const events = await collect(
      openaiStream([openaiFinish(reason)]),
      request("openai"),
    )
    expect(events.some((event) => event.type === "response")).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
      usage: { inputTokens: 7, outputTokens: 12 },
    })
  })
  it.each([
    "anthropic",
    "openai",
  ])("rejects a second %s terminal before considering compaction Length retry", async (provider) => {
    let attempts = 0
    const frames =
      provider === "anthropic"
        ? [
            anthropicStart(),
            ...anthropicFinish("max_tokens"),
            { type: "message_stop" },
          ]
        : [openaiFinish("max_output_tokens"), openaiFinish(undefined)]
    const stream = createModelRequestStream(
      streamWithFetch(provider, async () => {
        attempts += 1
        return new Response(sse(frames), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
      {
        wireApi:
          provider === "anthropic" ? "anthropic_messages" : "openai_responses",
        maxAttempts: 3,
        sleep: async () => {},
      },
    )
    const events = await collect(stream, {
      ...request(provider),
      compaction: "local",
    })
    expect(attempts).toBe(1)
    expect(events).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "protocol_error",
          attempt: 1,
          maxAttempts: 3,
          retryDecision: "fail",
        }),
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 12 }),
      }),
    ])
  })

  it.each([
    "anthropic",
    "openai",
  ])("retains %s usage and rejects a body error after a terminal event", async (provider) => {
    let attempts = 0
    const frames =
      provider === "anthropic"
        ? [anthropicStart(), ...anthropicFinish("max_tokens")]
        : [openaiFinish("max_output_tokens")]
    const stream = createModelRequestStream(
      streamWithFetch(provider, async () => {
        attempts += 1
        let prefixSent = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (prefixSent) {
              controller.error(new Error("Broken response body tail"))
              return
            }
            prefixSent = true
            controller.enqueue(new TextEncoder().encode(sse(frames)))
          },
        })
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        })
      }),
      {
        wireApi:
          provider === "anthropic" ? "anthropic_messages" : "openai_responses",
        maxAttempts: 3,
        sleep: async () => {},
      },
    )
    const events = await collect(stream, {
      ...request(provider),
      compaction: "local",
    })
    expect(attempts).toBe(1)
    expect(events).toEqual([
      expect.objectContaining({
        type: "failure",
        failure: expect.objectContaining({
          kind: "protocol_error",
          attempt: 1,
          maxAttempts: 3,
          retryDecision: "fail",
        }),
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 12 }),
      }),
    ])
  })
})

function request(provider: string): ModelRequest {
  return {
    target: { provider, model: "test-model", instructionProfileId: "test" },
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "eager",
    streamOutputItems: true,
  }
}

async function collect(
  stream: StreamFn,
  input: ModelRequest,
): Promise<ModelStreamEvent[]> {
  const events = []
  for await (const event of stream(input)) events.push(event)
  return events
}

type SseFrame = Readonly<{ type: string } & Record<string, unknown>>

function sse(frames: readonly SseFrame[]): string {
  return frames
    .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("")
}

function anthropicStart() {
  return {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-test",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  }
}

function anthropicFinish(reason: string | null) {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ]
}

function anthropicStream(frames: readonly SseFrame[]): StreamFn {
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async () =>
      new Response(sse(frames), {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  return createAnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    client,
  })
}

function openaiFinish(
  reason: string | undefined,
  output: readonly unknown[] = [],
) {
  return {
    type: reason === undefined ? "response.completed" : "response.incomplete",
    response: {
      id: "response_test",
      model: "gpt-test",
      status: reason === undefined ? "completed" : "incomplete",
      incomplete_details: reason === undefined ? null : { reason },
      output,
      error: null,
      usage: { input_tokens: 7, output_tokens: 12, total_tokens: 19 },
    },
  }
}

function openaiStream(frames: readonly SseFrame[]): StreamFn {
  const client = new OpenAI({
    apiKey: "test",
    maxRetries: 0,
    fetch: async () =>
      new Response(sse(frames), {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  return createOpenAIProvider({ apiKey: "test", model: "gpt-test", client })
}

function streamWithFetch(
  provider: string,
  fetch: () => Promise<Response>,
): StreamFn {
  if (provider === "anthropic")
    return createAnthropicProvider({
      apiKey: "test",
      model: "claude-test",
      client: new Anthropic({ apiKey: "test", maxRetries: 0, fetch }),
    })
  return createOpenAIProvider({
    apiKey: "test",
    model: "gpt-test",
    client: new OpenAI({ apiKey: "test", maxRetries: 0, fetch }),
  })
}
