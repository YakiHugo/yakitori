import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import type { Response } from "openai/resources/responses/responses"
import { expect, it } from "vitest"
import { ContextManager } from "../../src/core/context-manager.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { ModelMessage } from "../../src/kernel/index.ts"
import {
  createAnthropicProvider,
  fromAnthropicMessage,
  toAnthropicMessages,
} from "../../src/runtime/anthropic-provider.ts"
import {
  createOpenAIProvider,
  fromOpenAIResponse,
  toOpenAIInput,
} from "../../src/runtime/openai-provider.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const annotation = {
  type: "url_citation" as const,
  start_index: 0,
  end_index: 6,
  title: "Source",
  url: "https://example.com/source",
}
const citation = {
  type: "web_search_result_location",
  cited_text: "Source",
  encrypted_index: "opaque-source",
  title: "Source",
  url: "https://example.com/source",
}

it("preserves annotated OpenAI message boundaries and phase across durable replay", async () => {
  const message: Response["output"][number] = {
    type: "message",
    role: "assistant",
    id: "message_one",
    status: "completed",
    phase: "commentary",
    content: [
      { type: "output_text", text: "Source", annotations: [annotation] },
      { type: "output_text", text: " follows", annotations: [] },
    ],
  }
  const parsed = fromOpenAIResponse(
    response([message]),
    new Map(),
    "openai-work",
    "account-one",
  )
  const history = await persist([
    { role: "assistant", content: parsed.content },
  ])
  expect(history[0]).toMatchObject({
    content: [
      {
        text: "Source",
        providerMetadata: {
          openai: { part: { annotations: [annotation] }, phase: "commentary" },
        },
      },
      { text: " follows" },
    ],
  })
  expect(toOpenAIInput(history, true, "openai-work", "account-one")).toEqual([
    message,
  ])
  for (const [provider, scope] of [
    ["other", "account-one"],
    ["openai-work", "account-two"],
    ["openai-work", undefined],
  ])
    expect(toOpenAIInput(history, true, provider, scope)).toEqual([
      { role: "assistant", content: "Source follows" },
    ])
  expect(
    toChatCompletionsMessages(history, "openai-work", "account-one"),
  ).toEqual([{ role: "assistant", content: "Source follows" }])
})

it("accepts compatible text responses that omit optional citation metadata", () => {
  const output = [
    {
      type: "message",
      role: "assistant",
      id: "plain",
      status: "completed",
      content: [{ type: "output_text", text: "Plain" }],
    },
  ] as unknown as Response["output"]
  expect(fromOpenAIResponse(response(output)).content).toEqual([
    { type: "text", text: "Plain" },
  ])
})

it("retains refusal provenance without turning it into a tool or losing visible text", () => {
  const parsed = fromOpenAIResponse(
    response([
      {
        type: "message",
        role: "assistant",
        id: "refusal",
        status: "completed",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      },
    ]),
    new Map(),
    "openai",
    "account",
  )
  expect(parsed.content).toMatchObject([
    {
      type: "text",
      text: "Cannot comply",
      providerMetadata: { openai: { part: { type: "refusal" } } },
    },
  ])
  expect(
    toOpenAIInput(
      [{ role: "assistant", content: parsed.content }],
      true,
      "openai",
      "account",
    ),
  ).toMatchObject([
    { content: [{ type: "refusal", refusal: "Cannot comply" }] },
  ])
})

it("retains streamed OpenAI annotations when the terminal output is omitted", async () => {
  const client = {
    responses: {
      async create() {
        return (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              id: "streamed",
              status: "in_progress",
              phase: "final_answer",
              content: [],
            },
          }
          yield {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: "streamed",
            content_index: 0,
            delta: "Source",
          }
          yield {
            type: "response.output_text.annotation.added",
            output_index: 0,
            item_id: "streamed",
            content_index: 0,
            annotation_index: 0,
            annotation,
          }
          yield { type: "response.completed", response: response([]) }
        })()
      },
    },
  } as unknown as OpenAI
  const events = await collect(
    createOpenAIProvider({ apiKey: "fake", model: "model", client })(
      request("openai"),
    ),
  )
  expect(events.at(-1)).toMatchObject({
    type: "response",
    response: {
      content: [
        {
          type: "text",
          text: "Source",
          providerMetadata: {
            openai: {
              phase: "final_answer",
              part: { annotations: [annotation] },
            },
          },
        },
      ],
    },
  })
})

it("accumulates Anthropic citation deltas and preserves source metadata through durable replay", async () => {
  const client = {
    messages: {
      async create() {
        return (async function* () {
          yield {
            type: "message_start",
            message: { id: "cited", stop_reason: null, usage: {} },
          }
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: [] },
          }
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Source" },
          }
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "citations_delta", citation },
          }
          yield { type: "content_block_stop", index: 0 }
          yield {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          }
          yield { type: "message_stop" }
        })()
      },
    },
  } as unknown as Anthropic
  const events = await collect(
    createAnthropicProvider({ apiKey: "fake", model: "model", client })(
      request("anthropic"),
    ),
  )
  const terminal = events.at(-1)
  if (terminal?.type !== "response") throw new Error("Missing cited response")
  expect(events.find((event) => event.type === "output_item")).toMatchObject({
    content: [
      {
        text: "Source",
        providerMetadata: { anthropic: { citations: [citation] } },
      },
    ],
  })
  const history = await persist([
    { role: "assistant", content: terminal.response.content },
  ])
  expect(
    toAnthropicMessages(history, true, undefined, "anthropic", "account"),
  ).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "Source", citations: [citation] }],
    },
  ])
  for (const [provider, scope] of [
    ["other", "account"],
    ["anthropic", "other-account"],
    ["anthropic", undefined],
  ])
    expect(
      toAnthropicMessages(history, true, undefined, provider, scope),
    ).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Source" }] },
    ])
})

it("retains Anthropic source provenance without replaying unbound request-relative indices", () => {
  const source = {
    type: "page_location",
    cited_text: "Quote",
    document_index: 0,
    document_title: "Report",
    start_page_number: 1,
    end_page_number: 2,
    file_id: "provider-file",
  }
  const parsed = fromAnthropicMessage(
    {
      content: [{ type: "text", text: "Quote", citations: [source] }],
      stop_reason: "end_turn",
    },
    new Map(),
    "anthropic",
    "account",
  )
  expect(parsed.content).toMatchObject([
    { providerMetadata: { anthropic: { citations: [source] } } },
  ])
  const wire = toAnthropicMessages(
    [{ role: "assistant", content: parsed.content }],
    true,
    undefined,
    "anthropic",
    "account",
  )
  expect(wire).toEqual([
    { role: "assistant", content: [{ type: "text", text: "Quote" }] },
  ])
})

it.each([
  "audio",
  "video",
  "future_content",
])("rejects unsupported semantic output %s instead of reporting silent success", (type) => {
  expect(() =>
    fromAnthropicMessage({
      content: [{ type, data: "unhandled" }],
      stop_reason: "end_turn",
    }),
  ).toThrow("Unsupported Anthropic content type")
  expect(() =>
    fromOpenAIResponse(
      response([
        { type, id: "unhandled" } as unknown as Response["output"][number],
      ]),
    ),
  ).toThrow("Unsupported OpenAI output type")
})

it.each([
  "response.audio.delta",
  "response.audio.done",
  "response.audio.transcript.delta",
  "response.audio.transcript.done",
  "response.image_generation_call.partial_image",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
])("rejects unsupported semantic stream event %s even when terminal output is empty", async (type) => {
  const client = {
    responses: {
      async create() {
        return (async function* () {
          yield { type, delta: "unhandled", partial_image_b64: "unhandled" }
          yield { type: "response.completed", response: response([]) }
        })()
      },
    },
  } as unknown as OpenAI
  const events = await collect(
    createOpenAIProvider({ apiKey: "fake", model: "model", client })(
      request("openai"),
    ),
  )
  expect(events).toMatchObject([
    {
      type: "failure",
      failure: { kind: "protocol_error", stage: "response_body" },
    },
  ])
})

it.each([
  "response.content_part.added",
  "response.content_part.done",
])("rejects unsupported parts from %s before an empty terminal success", async (type) => {
  const client = {
    responses: {
      async create() {
        return (async function* () {
          yield {
            type,
            output_index: 0,
            item_id: "native",
            content_index: 0,
            part: { type: "reasoning_text", text: "unhandled" },
          }
          yield { type: "response.completed", response: response([]) }
        })()
      },
    },
  } as unknown as OpenAI
  const events = await collect(
    createOpenAIProvider({ apiKey: "fake", model: "model", client })(
      request("openai"),
    ),
  )
  expect(events).toMatchObject([
    {
      type: "failure",
      failure: { kind: "protocol_error", stage: "response_body" },
    },
  ])
})

it("rejects native reasoning content instead of silently replacing it with an empty summary", () => {
  expect(() =>
    fromOpenAIResponse(
      response([
        {
          type: "reasoning",
          id: "native-reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: "Meaningful reasoning" }],
        },
      ]),
    ),
  ).toThrow("Unsupported OpenAI native reasoning content")
})

it("fails an unsupported completed output item before publishing following tool calls", async () => {
  const client = {
    responses: {
      async create() {
        return (async function* () {
          yield {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "future_output", id: "unknown", status: "completed" },
          }
          yield {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "function_call",
              id: "tool",
              call_id: "call",
              name: "execute",
              arguments: "{}",
              status: "completed",
            },
          }
          yield { type: "response.completed", response: response([]) }
        })()
      },
    },
  } as unknown as OpenAI
  const events = await collect(
    createOpenAIProvider({ apiKey: "fake", model: "model", client })(
      request("openai"),
    ),
  )
  expect(events).toMatchObject([
    {
      type: "failure",
      failure: { kind: "protocol_error", stage: "response_body" },
    },
  ])
  expect(events.some((event) => event.type === "output_item")).toBe(false)
})

function response(output: Response["output"]): Response {
  return {
    id: "response",
    model: "model",
    status: "completed",
    output,
    incomplete_details: null,
    error: null,
  } as Response
}
function request(provider: string): ModelRequest {
  return {
    target: { provider, model: "model", instructionProfileId: "default" },
    continuationScope: "account",
    streamOutputItems: true,
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "eager",
  }
}
async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
async function persist(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-citations-"))
  const store = new JsonlThreadStore({ root })
  let writerOpen = false
  try {
    await store.createThread({
      id: "thread_content",
      conversationId: "conversation",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    })
    writerOpen = true
    await store.appendItems(
      "thread_content",
      messages.map((item, index) => ({
        type: "response_item",
        item: {
          id: `item_${index}`,
          turnId: "turn_one",
          createdAt: "2026-10-05T00:00:00.000Z",
          item,
        },
      })),
    )
    await store.persistThread("thread_content", "turn_start")
    await store.shutdownThread("thread_content")
    writerOpen = false
    const stored = await new JsonlThreadStore({ root }).readThread(
      "thread_content",
    )
    if (stored === undefined) throw new Error("Missing persisted content")
    const history = ContextManager.fromStoredThread(stored)
      .snapshot()
      .history.map((entry) => entry.item)
    expect(history).toEqual(messages)
    return history
  } finally {
    if (writerOpen) await store.shutdownThread("thread_content")
    await rm(root, { recursive: true, force: true })
  }
}
