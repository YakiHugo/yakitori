import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../src/kernel/index.ts"
import {
  createAnthropicProvider,
  toAnthropicMessages,
} from "../../src/runtime/anthropic-provider.ts"
import {
  createChatCompletionsProvider,
  toChatCompletionsMessages,
} from "../../src/runtime/chat-completions-provider.ts"
import {
  createGeminiProvider,
  toGeminiContents,
} from "../../src/runtime/gemini-provider.ts"
import type {
  ModelAssistantMessage,
  ModelNativeItem,
  ModelRequest,
  ModelResponse,
} from "../../src/runtime/model.ts"
import {
  createOpenAIProvider,
  toOpenAIInput,
} from "../../src/runtime/openai-provider.ts"

const cases: ReadonlyArray<{
  api: ModelNativeItem["wireApi"]
  values: JsonObject[]
  input?: JsonValue
}> = [
  {
    api: "openai_responses" as const,
    values: [
      {
        type: "reasoning",
        id: "reasoning",
        summary: [
          { type: "summary_text", text: "First" },
          { type: "summary_text", text: "Second" },
        ],
        content: [{ type: "reasoning_text", text: "Native thought" }],
        encrypted_content: "opaque",
      },
      {
        type: "function_call",
        id: "item_a",
        call_id: "call_a",
        name: "inspect",
        namespace: "yakitori",
        arguments: '{ "value" : 1.0 }',
        status: "completed",
      },
    ],
  },
  {
    api: "anthropic_messages" as const,
    values: [
      { type: "thinking", thinking: "Thought", signature: "signed" },
      {
        type: "server_tool_use",
        id: "server_a",
        name: "web_search",
        input: { query: "source" },
      },
      { type: "web_search_tool_result", tool_use_id: "server_a", content: [] },
      {
        type: "tool_use",
        id: "call_a",
        name: "inspect",
        input: { value: 1 },
        caller: { type: "direct" },
      },
    ],
  },
  {
    api: "openai_chat_completions" as const,
    values: [
      {
        role: "assistant",
        content: null,
        refusal: "Refused",
        reasoning: "Thought",
        reasoning_details: [
          {
            index: 0,
            type: "reasoning.encrypted",
            id: "trace",
            data: "opaque",
          },
        ],
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "inspect", arguments: '{ "value" : 1.0 }' },
          },
        ],
      },
    ],
  },
  {
    api: "openai_chat_completions",
    input: "print(1)\n",
    values: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "custom",
            custom: { name: "inspect", input: "print(1)\n" },
          },
        ],
      },
    ],
  },
  {
    api: "gemini_generate_content" as const,
    values: [
      { text: "Thought", thought: true, thoughtSignature: "signed" },
      {
        functionCall: { id: "call_a", name: "inspect", args: { value: 1 } },
        thoughtSignature: "tool_signature",
      },
      { executableCode: { language: "PYTHON", code: "print(1)" } },
      { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
      { thoughtSignature: "final_signature" },
    ],
  },
]

it.each(
  cases,
)("retains native $api output through SDK parsing, persistence and same-owner replay", async ({
  api,
  values,
  input,
}) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-native-replay-"))
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "request_one",
    })
    const event = (type: string, payload: object) => {
      response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    if (api === "openai_responses") {
      values.forEach((item, output_index) => {
        event("response.output_item.done", {
          type: "response.output_item.done",
          item,
          output_index,
        })
      })
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "response_one",
          model: "test",
          vendor_metadata: { trace: "envelope" },
          status: "completed",
          output: values,
          usage: null,
          error: null,
          incomplete_details: null,
        },
      })
    } else if (api === "anthropic_messages") {
      event("message_start", {
        type: "message_start",
        message: {
          id: "response_one",
          role: "assistant",
          vendor_metadata: { trace: "envelope" },
          model: "test",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      })
      values.forEach((content_block, index) => {
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block,
        })
        event("content_block_stop", { type: "content_block_stop", index })
      })
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 3 },
      })
      event("message_stop", { type: "message_stop" })
    } else if (api === "openai_chat_completions") {
      const message = values[0]
      event("chunk", {
        id: "response_one",
        vendor_metadata: { trace: "envelope" },
        choices: [
          {
            index: 0,
            delta: {
              ...message,
              role: "assistant",
              tool_calls:
                input === undefined
                  ? [
                      {
                        index: 0,
                        id: "call_a",
                        type: "function",
                        function: {
                          name: "inspect",
                          arguments: '{ "value" : 1.0 }',
                        },
                      },
                    ]
                  : [
                      {
                        index: 0,
                        id: "call_a",
                        type: "custom",
                        custom: { name: "inspect", input },
                      },
                    ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
      response.write("data: [DONE]\n\n")
    } else
      event("chunk", {
        responseId: "response_one",
        vendor_metadata: { trace: "envelope" },
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 2,
          totalTokenCount: 12,
        },
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: values },
            finishReason: "STOP",
          },
        ],
      })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing server address")
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
  const request: ModelRequest = {
    target: { provider: "test", model: "test", instructionProfileId: "test" },
    continuationScope: "owner_a",
    system: [],
    messages: [],
    tools: [],
    toolWireProtocol: "eager",
    streamOutputItems: true,
  }
  const store = new JsonlThreadStore({ root })
  const id = "thread_native"
  let writer: JsonlThreadStore | undefined
  try {
    let terminal: ModelResponse | undefined
    for await (const event of stream(request)) {
      if (event.type === "failure") throw new Error(event.failure.message)
      if (event.type === "response") terminal = event.response
    }
    if (terminal === undefined) throw new Error("Missing terminal response")
    expect(terminal).toMatchObject({
      providerRequestId: "request_one",
      providerResponseId: "response_one",
    })
    const native = terminal.native
    if (native === undefined) throw new Error("Missing native output")
    expect(native.map((item) => item.value)).toEqual(values)
    expect(terminal.nativeMetadata?.value).toMatchObject({
      vendor_metadata: { trace: "envelope" },
    })
    if (api === "gemini_generate_content")
      expect(terminal.nativeMetadata?.value.usageMetadata).toMatchObject({
        thoughtsTokenCount: 2,
      })
    // Hosted provider tools are retained without becoming local execution calls.
    expect(
      terminal.content.filter((block) => block.type === "tool_call"),
    ).toMatchObject([
      { id: "call_a", name: "inspect", input: input ?? { value: 1 } },
    ])
    const now = new Date().toISOString()
    await store.createThread({
      id,
      conversationId: id,
      createdAt: now,
      updatedAt: now,
    })
    writer = store
    await store.persistThread(id, "turn_start")
    await store.appendItems(id, [
      {
        type: "model_attempt",
        turnId: "turn_a",
        attempt: {
          origin: {
            callId: "call",
            attemptId: "attempt",
            attempt: 1,
            provider: "test",
            model: "test",
          },
          outcome: "completed",
          wireApi: api,
          ...(terminal.nativeMetadata === undefined
            ? {}
            : { responseMetadata: terminal.nativeMetadata }),
        },
      },
      {
        type: "response_item",
        item: {
          id: "message_a",
          turnId: "turn_a",
          createdAt: now,
          providerMetadata: { callIndex: 1 },
          item: {
            role: "assistant",
            content: terminal.content,
            native,
            response: {
              callId: "call",
              attemptId: "attempt",
              attempt: 1,
              provider: "test",
              model: "test",
            },
          },
        },
      },
    ])
    await store.shutdownThread(id)
    writer = undefined
    const reopened = new JsonlThreadStore({ root })
    const saved = await reopened.resumeThread(id)
    expect(
      saved?.rollout.find(({ item }) => item.type === "model_attempt")?.item,
    ).toMatchObject({
      type: "model_attempt",
      attempt: {
        responseMetadata: { value: { vendor_metadata: { trace: "envelope" } } },
      },
    })
    writer = reopened
    const message = saved?.rollout.find(
      ({ item }) => item.type === "response_item",
    )?.item
    if (
      message?.type !== "response_item" ||
      message.item.item.role !== "assistant"
    )
      throw new Error("Missing saved assistant")
    const assistant: ModelAssistantMessage = message.item.item
    const project = (provider: string, scope: string, model = "test") => {
      if (api === "openai_responses")
        return toOpenAIInput(
          [assistant],
          true,
          provider,
          scope,
          new Map(),
          model,
        )
      if (api === "anthropic_messages")
        return toAnthropicMessages(
          [assistant],
          true,
          undefined,
          provider,
          scope,
          new Map(),
          model,
        )[0]?.content
      if (api === "openai_chat_completions")
        return toChatCompletionsMessages(
          [assistant],
          provider,
          scope,
          "generic",
          model,
        )
      return toGeminiContents([assistant], provider, scope, model)[0]?.parts
    }
    expect(project("test", "owner_a")).toEqual(values)
    for (const foreign of [
      project("other", "owner_a"),
      project("test", "owner_b"),
      project("test", "owner_a", "other"),
    ]) {
      expect(JSON.stringify(foreign)).not.toContain("opaque")
      expect(JSON.stringify(foreign)).not.toContain("signed")
      expect(JSON.stringify(foreign)).not.toContain("tool_signature")
    }
    expect(isJsonObject(assistant.native?.[0]?.value)).toBe(true)
    await reopened.shutdownThread(id)
    writer = undefined
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await writer?.shutdownThread(id)
    await rm(root, { recursive: true, force: true })
  }
})
