import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { ContextManager } from "../../src/core/context-manager.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { isModelMessage, type ModelMessage } from "../../src/kernel/index.ts"
import {
  createChatCompletionsProvider,
  toChatCompletionsMessages,
} from "../../src/runtime/chat-completions-provider.ts"
import {
  type ModelRequest,
  type ModelStreamEvent,
  ModelStopReason,
} from "../../src/runtime/model.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

describe("Chat Completions provider", () => {
  it.each([
    { model: "gpt-6-astra", effort: "high", withTools: true },
    { model: "gpt-6.1-sol", effort: "low", withTools: true },
    { model: "gpt-6-sol", effort: "medium", withTools: true },
    { model: "gpt-6-luna", effort: undefined, withTools: true },
    { model: "gpt-5.1-codex", effort: undefined, withTools: false },
  ])("rejects incompatible $model Chat requests locally before fetch", async ({
    model,
    effort,
    withTools,
  }) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const input = request({
      target: {
        provider: "personal-openai",
        model,
        instructionProfileId: "default",
        ...(effort === undefined ? {} : { effort }),
      },
      ...(withTools ? {} : { tools: [] }),
    })
    const events = await collect(
      createChatCompletionsProvider({
        apiKey: "unused",
        model: "fallback",
        baseURL: "https://api.openai.com/v1",
      })(input),
    )
    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          provider: "personal-openai",
          wireApi: "openai_chat_completions",
          stage: "request_build",
          kind: "invalid_request",
          message: expect.stringContaining("Responses API"),
        },
      },
    ])
    expect(fetch).not.toHaveBeenCalled()
    expect(input.target.effort).toBe(effort)
  })

  it("rejects incompatible replayed Chat tool history even with an empty tool catalog", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const stream = createChatCompletionsProvider({
      apiKey: "unused",
      model: "gpt-6-astra",
      baseURL: "https://api.openai.com/v1",
    })
    const events = await collect(
      stream(
        request({
          target: {
            provider: "personal",
            model: "gpt-6-astra",
            instructionProfileId: "default",
          },
          tools: [],
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_call", id: "read", name: "read_file", input: {} },
              ],
            },
            {
              role: "tool",
              toolCallId: "read",
              content: [{ type: "text", text: "contents" }],
            },
          ],
        }),
      ),
    )
    expect(events[0]).toMatchObject({
      type: "failure",
      failure: {
        kind: "invalid_request",
        message: expect.stringContaining("tool history"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("streams channels and assembles interleaved calls with complete usage", async () => {
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        expect(incoming.url).toBe("/v1/chat/completions")
        expect(incoming.headers.authorization).toBe("Bearer test-key")
        expect(incoming.headers["x-endpoint"]).toBe("test")
        body = await requestBody(incoming)
        send(outgoing, [
          chunk({ reasoning_content: "Inspect ", content: "I will " }),
          chunk({
            reasoning_content: "the repo",
            content: "read files.",
            tool_calls: [
              {
                index: 1,
                id: "call_eval",
                type: "function",
                function: { name: "evaluate", arguments: '{"code":"' },
              },
              {
                index: 0,
                id: "call_read",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"' },
              },
            ],
          }),
          chunk({
            tool_calls: [
              { index: 0, function: { arguments: 'index.ts"}' } },
              { index: 1, function: { arguments: '1 + 1"}' } },
            ],
          }),
          chunk({}, "tool_calls"),
          usageChunk(),
        ])
      },
      async (baseURL) => {
        const events = await collect(
          createChatCompletionsProvider({
            apiKey: "test-key",
            model: "fallback",
            baseURL,
            defaultHeaders: { "x-endpoint": "test" },
          })(request({ streamOutputItems: true, maxOutputTokens: 200 })),
        )
        expect(
          events
            .filter((event) => event.type === "delta")
            .map((event) => event.text),
        ).toEqual(["I will ", "read files."])
        expect(
          events
            .filter((event) => event.type === "reasoning_delta")
            .map((event) => event.text),
        ).toEqual(["Inspect ", "the repo"])
        expect(
          events.filter((event) => event.type === "output_item"),
        ).toHaveLength(1)
        expect(terminal(events)).toMatchObject({
          stopReason: ModelStopReason.ToolUse,
          rawStopReason: "tool_calls",
          providerRequestId: "request-http",
          content: [
            { type: "reasoning", text: "Inspect the repo" },
            { type: "text", text: "I will read files." },
            {
              type: "tool_call",
              id: "call_read",
              name: "read_file",
              input: { path: "index.ts" },
            },
            {
              type: "tool_call",
              id: "call_eval",
              name: "evaluate",
              input: "1 + 1",
              toolKind: "custom",
              customInputFallbackKey: "code",
            },
          ],
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            activeContextTokens: 18,
            cacheReadInputTokens: 3,
          },
        })
      },
    )
    expect(body).toMatchObject({
      model: "unknown-model",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 200,
      messages: [
        { role: "system", content: "System instruction" },
        { role: "user", content: "Inspect the repo" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read_file", parameters: { type: "object" } },
        },
        {
          type: "function",
          function: {
            name: "evaluate",
            parameters: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
        },
      ],
    })
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body).not.toHaveProperty("thinking")
  })

  it("replays custom calls using their durable JSON fallback", () => {
    expect(
      toChatCompletionsMessages(
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "call_eval",
                name: "evaluate",
                input: "1 + 1",
                toolKind: "custom",
                customInputFallbackKey: "code",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_eval",
            content: [{ type: "text", text: "2" }],
          },
        ],
        "custom_1",
      ),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            id: "call_eval",
            function: { name: "evaluate", arguments: '{"code":"1 + 1"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_eval", content: "2" },
    ])
  })

  it("forwards an explicitly configured model effort without enabling extra thinking fields", async () => {
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        body = await requestBody(incoming)
        send(outgoing, [chunk({ content: "Answer" }, "stop")])
      },
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(
            request({
              target: {
                provider: "configured_1",
                model: "configured-model",
                instructionProfileId: "default",
                effort: "max",
              },
            }),
          ),
        )
        expect(terminal(events).stopReason).toBe(ModelStopReason.EndTurn)
        expect(body?.reasoning_effort).toBe("max")
        expect(body).not.toHaveProperty("thinking")
        expect(body).not.toHaveProperty("max_tokens")
      },
    )
  })

  it.each([
    ["stop", ModelStopReason.EndTurn],
    ["length", ModelStopReason.Length],
    ["content_filter", ModelStopReason.ContentFilter],
  ])("preserves the provider's %s completion reason", async (reason, mapped) => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [chunk({ content: "Answer" }, reason)]),
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(terminal(events)).toMatchObject({
          stopReason: mapped,
          rawStopReason: reason,
          content: [{ type: "text", text: "Answer" }],
        })
        if (reason === "length")
          expect(terminal(events).lengthReason).toBe("output")
      },
    )
  })

  it("keeps a complete call and marks a truncated tool tail unexecutable", async () => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          chunk(
            {
              content: "Inspecting",
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
                {
                  index: 1,
                  id: "call_tail",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"b' },
                },
              ],
            },
            "length",
          ),
        ]),
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(request({ streamOutputItems: true })),
        )
        expect(terminal(events)).toMatchObject({
          stopReason: ModelStopReason.Length,
          incompleteToolCalls: true,
          content: [
            { type: "text", text: "Inspecting" },
            { type: "tool_call", id: "call_read", input: { path: "a.ts" } },
          ],
        })
        expect(
          JSON.stringify(
            events.filter((event) => event.type === "output_item"),
          ),
        ).not.toContain("call_tail")
      },
    )
  })

  it("preserves Length alongside a complete call for the runtime recovery budget", async () => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_complete",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
            "length",
          ),
        ]),
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(terminal(events)).toMatchObject({
          stopReason: ModelStopReason.Length,
          rawStopReason: "length",
          content: [{ type: "tool_call", id: "call_complete", input: {} }],
        })
        expect(terminal(events).incompleteToolCalls).toBeUndefined()
      },
    )
  })

  it.each([
    [
      "invalid arguments",
      [
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "read_file", arguments: "{" },
              },
            ],
          },
          "tool_calls",
        ),
      ],
    ],
    [
      "duplicate call identities",
      [
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "same",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
              {
                index: 1,
                id: "same",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        ),
      ],
    ],
    [
      "output after finish",
      [chunk({ content: "First" }, "stop"), chunk({ content: "Late" })],
    ],
  ])("reports %s without publishing executable output", async (_name, chunks) => {
    await withServer(
      (_incoming, outgoing) => send(outgoing, chunks),
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(request({ streamOutputItems: true })),
        )
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: {
            kind: "protocol_error",
            wireApi: "openai_chat_completions",
          },
        })
        expect(
          events.filter(
            (event) =>
              event.type === "output_item" || event.type === "response",
          ),
        ).toEqual([])
      },
    )
  })

  it("treats EOF before finish as a disconnected stream", async () => {
    await withServer(
      (_incoming, outgoing) => send(outgoing, [chunk({ content: "Partial" })]),
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind: "stream_disconnected", stage: "response_body" },
        })
      },
    )
  })

  it("reports malformed SSE as a decode failure", async () => {
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.end("data: {invalid-json\n\ndata: [DONE]\n\n")
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind: "protocol_error", stage: "sse_decode" },
        })
      },
    )
  })

  it("reports a broken response body and keeps its request identity", async () => {
    let response: ServerResponse | undefined
    await withServer(
      (_incoming, outgoing) => {
        response = outgoing
        outgoing.writeHead(200, {
          "content-type": "text/event-stream",
          "x-request-id": "body-broken",
        })
        outgoing.write(
          `data: ${JSON.stringify(chunk({ content: "Partial" }))}\n\n`,
        )
      },
      async (baseURL) => {
        const iterator = provider(baseURL)(request())[Symbol.asyncIterator]()
        expect((await iterator.next()).value).toMatchObject({
          type: "delta",
          text: "Partial",
        })
        if (response === undefined)
          throw new Error("Missing response connection")
        response.destroy()
        expect((await iterator.next()).value).toMatchObject({
          type: "failure",
          failure: {
            kind: "stream_disconnected",
            stage: "response_body",
            providerRequestId: "body-broken",
          },
        })
        expect((await iterator.next()).done).toBe(true)
      },
    )
  })

  it("preserves DeepSeek reasoning only within its provider continuation scope", async () => {
    const bodies: Record<string, unknown>[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        send(outgoing, [
          chunk({ reasoning_content: "Check files", content: "Done" }, "stop"),
        ])
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL, "deepseek")(request()))
        const history: ModelMessage[] = [
          { role: "assistant", content: terminal(events).content },
        ]
        expect(
          toChatCompletionsMessages(
            history,
            "custom_1",
            "endpoint_1",
            "deepseek",
          ),
        ).toEqual([
          {
            role: "assistant",
            content: "Done",
            reasoning_content: "Check files",
          },
        ])
        await collect(
          provider(
            baseURL,
            "deepseek",
          )(
            request({
              messages: [
                ...history,
                { role: "user", content: [{ type: "text", text: "Next" }] },
              ],
            }),
          ),
        )
        expect(bodies[1]?.messages).toEqual([
          { role: "system", content: "System instruction" },
          {
            role: "assistant",
            content: "Done",
            reasoning_content: "Check files",
          },
          { role: "user", content: "Next" },
        ])
        for (const [id, scope, flavor] of [
          ["custom_2", "endpoint_1", "deepseek"],
          ["custom_1", "endpoint_2", "deepseek"],
          ["custom_1", undefined, "deepseek"],
        ] as const)
          expect(toChatCompletionsMessages(history, id, scope, flavor)).toEqual(
            [{ role: "assistant", content: "Done" }],
          )
        expect(
          toChatCompletionsMessages(
            history,
            "custom_1",
            "endpoint_1",
            "generic",
          ),
        ).toEqual([
          {
            role: "assistant",
            content: "Done",
            reasoning_content: "Check files",
          },
        ])
      },
    )
  })

  it("persists Gemini call signatures and replays grouped calls with the same owner", async () => {
    const bodies: Record<string, unknown>[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        if (bodies.length > 1) {
          send(outgoing, [chunk({ content: "Finished" }, "stop")])
          return
        }
        send(outgoing, [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
                extra_content: {
                  google: { thought_signature: "old-signature" },
                },
              },
              {
                index: 1,
                id: "call_b",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          }),
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  extra_content: {
                    google: { thought_signature: "complete-signature" },
                  },
                },
              ],
            },
            "tool_calls",
          ),
        ])
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL, "gemini")(request()))
        const assistant: ModelMessage = {
          role: "assistant",
          content: terminal(events).content,
        }
        const root = await mkdtemp(join(tmpdir(), "yakitori-chat-history-"))
        const store = new JsonlThreadStore({ root })
        let writerOpen = false
        try {
          await store.createThread({
            id: "thread_signature",
            conversationId: "conversation_signature",
            createdAt: "2026-10-04T00:00:00.000Z",
            updatedAt: "2026-10-04T00:00:00.000Z",
          })
          writerOpen = true
          await store.appendItems("thread_signature", [
            {
              type: "response_item",
              item: {
                id: "item_assistant",
                turnId: "turn_one",
                createdAt: "2026-10-04T00:00:00.000Z",
                item: assistant,
              },
            },
          ])
          await store.persistThread("thread_signature", "turn_start")
          await store.shutdownThread("thread_signature")
          writerOpen = false
          const reopened = new JsonlThreadStore({ root })
          const stored = await reopened.readThread("thread_signature")
          if (stored === undefined) throw new Error("Missing durable history")
          const history = ContextManager.fromStoredThread(stored)
            .snapshot()
            .history.map((entry) => entry.item)
          expect(history).toEqual([assistant])
          const replay = toChatCompletionsMessages(
            history,
            "custom_1",
            "endpoint_1",
            "gemini",
          )
          expect(replay).toEqual([
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_a",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                  extra_content: {
                    google: { thought_signature: "complete-signature" },
                  },
                },
                {
                  id: "call_b",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          ])
          const next = await collect(
            provider(
              baseURL,
              "gemini",
            )(
              request({
                messages: [
                  ...history,
                  {
                    role: "tool",
                    toolCallId: "call_a",
                    content: [{ type: "text", text: "First result" }],
                  },
                  {
                    role: "tool",
                    toolCallId: "call_b",
                    content: [{ type: "text", text: "Second result" }],
                  },
                ],
              }),
            ),
          )
          expect(terminal(next).content).toEqual([
            { type: "text", text: "Finished" },
          ])
          expect(bodies[1]?.messages).toEqual([
            { role: "system", content: "System instruction" },
            ...replay,
            {
              role: "tool",
              tool_call_id: "call_a",
              content: "First result",
            },
            { role: "tool", tool_call_id: "call_b", content: "Second result" },
          ])
          expect(
            JSON.stringify(
              toChatCompletionsMessages(
                history,
                "custom_1",
                "endpoint_changed",
                "gemini",
              ),
            ),
          ).not.toContain("thought_signature")
          expect(
            JSON.stringify(
              toChatCompletionsMessages(
                history,
                "another_provider",
                "endpoint_1",
                "gemini",
              ),
            ),
          ).not.toContain("thought_signature")
          expect(
            isModelMessage({
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "invalid",
                  name: "read_file",
                  input: {},
                  providerMetadata: "signature",
                },
              ],
            }),
          ).toBe(false)
        } finally {
          if (writerOpen) await store.shutdownThread("thread_signature")
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  it.each([
    "end",
    "assistant",
    "user",
    "developer",
  ] as const)("projects tool media after all results before %s without mutating history", (boundary) => {
    const image = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: "YWJj",
      detail: "original" as const,
    }
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect" }, image],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "first", name: "inspect", input: {} },
          { type: "tool_call", id: "plain", name: "inspect", input: {} },
          { type: "tool_call", id: "last", name: "inspect", input: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "first",
        content: [{ type: "text", text: "First result" }, image, image],
      },
      {
        role: "tool",
        toolCallId: "plain",
        content: [{ type: "text", text: "No image" }],
      },
      {
        role: "tool",
        toolCallId: "last",
        content: [
          { type: "text", text: "Partial result" },
          { ...image, data: "ZGVm" },
          {
            type: "document",
            name: "report.pdf",
            mediaType: "application/pdf",
            file: { rolloutId: "rollout_test", path: "report.pdf" },
            sizeBytes: 10,
            data: "JVBERi0x",
          },
        ],
        isError: true,
      },
      ...(boundary === "end"
        ? []
        : [
            {
              role: boundary,
              content: [{ type: "text" as const, text: "Next" }],
            },
          ]),
    ]
    const original = structuredClone(messages)
    const converted = toChatCompletionsMessages(messages, "custom_1")
    const wireImage = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,YWJj", detail: "high" },
    }
    expect(converted[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Inspect" }, wireImage],
    })
    expect(converted.slice(2, 6)).toEqual([
      {
        role: "tool",
        tool_call_id: "first",
        content:
          'First result\n[Image from tool result "first", content part 2; image follows the tool-result batch.]\n[Image from tool result "first", content part 3; image follows the tool-result batch.]',
      },
      { role: "tool", tool_call_id: "plain", content: "No image" },
      {
        role: "tool",
        tool_call_id: "last",
        content:
          '[tool_error]\nPartial result\n[Image from tool result "last", content part 2; image follows the tool-result batch.]\n[PDF from tool result "last", content part 3; PDF follows the tool-result batch.]',
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Image from tool result "first", content part 2:',
          },
          wireImage,
          {
            type: "text",
            text: 'Image from tool result "first", content part 3:',
          },
          wireImage,
          {
            type: "text",
            text: 'Image from tool result "last", content part 2:',
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,ZGVm", detail: "high" },
          },
          {
            type: "text",
            text: 'PDF from tool result "last", content part 3:',
          },
          {
            type: "file",
            file: {
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0x",
            },
          },
        ],
      },
    ])
    expect(converted).toHaveLength(boundary === "end" ? 6 : 7)
    if (boundary !== "end")
      expect(converted[6]).toEqual({
        role: boundary === "developer" ? "system" : boundary,
        content: "Next",
      })
    expect(messages).toEqual(original)
    expect(toChatCompletionsMessages(messages, "custom_1")).toEqual(converted)
  })

  it("serializes mixed tool PDFs and images once after the complete parallel batch", async () => {
    const pdf = {
      type: "document" as const,
      name: "résumé.pdf",
      mediaType: "application/pdf" as const,
      sizeBytes: 6,
      file: { rolloutId: "rollout_test", path: "report.pdf" },
      data: "JVBERi0x",
    }
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: ["a", "b"].map((id) => ({
          type: "tool_call",
          id,
          name: "inspect",
          input: {},
        })),
      },
      {
        role: "tool",
        toolCallId: "a",
        content: [
          { type: "text", text: "Before" },
          pdf,
          { type: "text", text: "Between" },
          { type: "image", mediaType: "image/png", data: "YWJj" },
          { type: "text", text: "After" },
        ],
      },
      { role: "tool", toolCallId: "b", content: [pdf] },
    ]
    const original = structuredClone(messages)
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        body = await requestBody(incoming)
        send(outgoing, [chunk({ content: "Read" }, "stop")])
      },
      async (baseURL) => {
        expect(
          terminal(await collect(provider(baseURL)(request({ messages }))))
            .content,
        ).toEqual([{ type: "text", text: "Read" }])
      },
    )
    expect(body?.messages).toEqual([
      { role: "system", content: "System instruction" },
      {
        role: "assistant",
        content: "",
        tool_calls: ["a", "b"].map((id) => ({
          id,
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        })),
      },
      {
        role: "tool",
        tool_call_id: "a",
        content:
          'Before\n[PDF from tool result "a", content part 2; PDF follows the tool-result batch.]\nBetween\n[Image from tool result "a", content part 4; image follows the tool-result batch.]\nAfter',
      },
      {
        role: "tool",
        tool_call_id: "b",
        content:
          '[PDF from tool result "b", content part 1; PDF follows the tool-result batch.]',
      },
      {
        role: "user",
        content: [
          { type: "text", text: 'PDF from tool result "a", content part 2:' },
          {
            type: "file",
            file: {
              filename: "résumé.pdf",
              file_data: "data:application/pdf;base64,JVBERi0x",
            },
          },
          { type: "text", text: 'Image from tool result "a", content part 4:' },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YWJj", detail: "high" },
          },
          { type: "text", text: 'PDF from tool result "b", content part 1:' },
          {
            type: "file",
            file: {
              filename: "résumé.pdf",
              file_data: "data:application/pdf;base64,JVBERi0x",
            },
          },
        ],
      },
    ])
    expect(messages).toEqual(original)
  })

  it("keeps images with their own tool batch and leaves text-only batches unchanged", () => {
    const call: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool_call", id: "call", name: "inspect", input: {} }],
    }
    const result: ModelMessage = {
      role: "tool",
      toolCallId: "call",
      content: [{ type: "text", text: "" }],
    }
    const image = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: "YWJj",
    }
    const messages = toChatCompletionsMessages(
      [
        call,
        { ...result, content: [...result.content, image] },
        call,
        result,
        call,
        { ...result, content: [...result.content, image] },
      ],
      "custom_1",
    )
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
    ])
    expect(messages[2]).toEqual(messages[7])
    expect(messages[4]).toEqual({
      role: "tool",
      tool_call_id: "call",
      content: "",
    })
  })

  it.each([
    "deepseek",
    "gemini",
  ] as const)("carries %s continuation through a real durable tool loop", async (flavor) => {
    const bodies: Record<string, unknown>[] = []
    let executions = 0
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        send(
          outgoing,
          bodies.length === 1
            ? [
                chunk(
                  {
                    reasoning_content: "Inspect the tool output",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_runtime",
                        type: "function",
                        function: { name: "inspect", arguments: "{}" },
                        ...(flavor === "gemini"
                          ? {
                              extra_content: {
                                google: {
                                  thought_signature: "runtime-signature",
                                },
                              },
                            }
                          : {}),
                      },
                    ],
                  },
                  "tool_calls",
                ),
              ]
            : [chunk({ content: "Executed" }, "stop")],
        )
      },
      async (baseURL) => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-chat-tool-loop-"))
        const store = new JsonlThreadStore({ root })
        const tools = createToolRegistry([
          {
            toolName: plainToolName("inspect"),
            description: "Inspect",
            inputSchema: { type: "object" },
            effect: "observe",
            approvalRequirement: { kind: "none" },
            async execute() {
              executions += 1
              return { ok: true, output: "Inspected", content: "Inspected" }
            },
          },
        ])
        const registry = createProviderRegistry({
          custom_1: createModelProvider({
            info: {
              id: "custom_1",
              wireApi: "openai_chat_completions",
              capabilities: { remoteCompaction: false },
            },
            models: createConfiguredModelsManager({
              provider: "custom_1",
              wireApi: "openai_chat_completions",
              models: [{ id: "configured-model" }],
            }),
            continuationScope: "endpoint_1",
            stream: provider(baseURL, flavor),
          }),
        })
        const manager = new ThreadManager({
          store,
          createTurnProcessor: () =>
            createTurnProcessor({
              modelClient: registry.createClient(),
              provider: "custom_1",
              model: "configured-model",
              toolRegistry: tools,
              baseInstructions: "Tool loop test",
              loadProjectInstructions: async () => undefined,
            }),
        })
        let threadId: string | undefined
        try {
          const thread = await manager.createThread({
            workingDirectory: root,
            mateId: "mate_test",
            mateRevisionId: "revision_test",
          })
          threadId = thread.id
          await thread.startIfIdle({
            content: {
              kind: "parts" as const,
              parts: [{ type: "text" as const, text: "Inspect" }],
            },
          })
          await expect
            .poll(() => thread.agentStatus)
            .toEqual({ completed: "Executed" })
          expect(executions).toBe(1)
          const messages = bodies[1]?.messages
          if (!Array.isArray(messages))
            throw new Error("Missing second model request")
          const assistant = messages.find(
            (message: unknown) =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "assistant",
          )
          expect(assistant).toMatchObject({
            role: "assistant",
            reasoning_content: "Inspect the tool output",
            tool_calls: [
              {
                id: "call_runtime",
                function: { name: "inspect", arguments: "{}" },
              },
            ],
          })
          if (flavor === "gemini")
            expect(assistant).toMatchObject({
              tool_calls: [
                {
                  extra_content: {
                    google: { thought_signature: "runtime-signature" },
                  },
                },
              ],
            })
          expect(messages).toContainEqual({
            role: "tool",
            tool_call_id: "call_runtime",
            content: "Inspected",
          })
          await manager.shutdown()
          if (threadId === undefined)
            throw new Error("Missing completed thread")
          const reopened = new JsonlThreadStore({ root })
          const stored = await reopened.readThread(threadId)
          if (stored === undefined)
            throw new Error("Missing persisted tool loop")
          const history = ContextManager.fromStoredThread(stored)
            .snapshot()
            .history.map((entry) => entry.item)
          const replay = toChatCompletionsMessages(
            history,
            "custom_1",
            "endpoint_1",
            flavor,
          )
          expect(JSON.stringify(replay)).toContain("Inspect the tool output")
          if (flavor === "gemini")
            expect(JSON.stringify(replay)).toContain("runtime-signature")
        } finally {
          await manager.shutdown()
          await tools.dispose()
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  it.each([
    "image",
    "document",
  ] as const)("rejects unresolved tool %s references before sending a request", async (type) => {
    let requests = 0
    await withServer(
      (_incoming, outgoing) => {
        requests += 1
        send(outgoing, [chunk({ content: "Unexpected" }, "stop")])
      },
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(
            request({
              messages: [
                {
                  role: "tool",
                  toolCallId: "image",
                  content: [
                    { type: "text", text: "Screenshot" },
                    {
                      ...(type === "image"
                        ? { type, mediaType: "image/png" as const }
                        : {
                            type,
                            mediaType: "application/pdf" as const,
                            name: "report.pdf",
                          }),
                      sizeBytes: 10,
                      file: { rolloutId: "rollout_test", path: "image.png" },
                    },
                  ],
                },
              ],
            }),
          ),
        )
        expect(events).toMatchObject([
          { type: "failure", failure: { stage: "request_build" } },
        ])
        expect(requests).toBe(0)
      },
    )
  })

  it("rehydrates persisted tool images into wire-only messages after reopening a thread", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
      "base64",
    )
    const bodies: Record<string, unknown>[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        send(
          outgoing,
          bodies.length === 1
            ? [
                chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_image",
                        type: "function",
                        function: {
                          name: "view_image",
                          arguments: JSON.stringify({ path: "screen.png" }),
                        },
                      },
                    ],
                  },
                  "tool_calls",
                ),
              ]
            : [chunk({ content: "Inspected" }, "stop")],
        )
      },
      async (baseURL) => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-chat-images-"))
        await writeFile(join(root, "screen.png"), png)
        const tools = createToolRegistry()
        const openManager = () => {
          const store = new JsonlThreadStore({ root })
          const assets = createRolloutAssets(root, {
            withMutationLease: async (id, mutate) => {
              await mkdir(join(root, "rollouts", id), { recursive: true })
              return mutate()
            },
          })
          const manager = new ThreadManager({
            store,
            createTurnProcessor: () =>
              createTurnProcessor({
                modelClient: createProviderRegistry({
                  custom_1: createModelProvider({
                    info: {
                      id: "custom_1",
                      wireApi: "openai_chat_completions",
                      capabilities: { remoteCompaction: false },
                    },
                    models: createConfiguredModelsManager({
                      provider: "custom_1",
                      wireApi: "openai_chat_completions",
                      models: [
                        {
                          id: "configured-model",
                          inputModalities: ["text", "image"],
                        },
                      ],
                    }),
                    stream: provider(baseURL),
                  }),
                }).createClient(),
                provider: "custom_1",
                model: "configured-model",
                toolRegistry: tools,
                rolloutAssets: assets,
                baseInstructions: "Image test",
                loadProjectInstructions: async () => undefined,
              }),
          })
          return { manager, store, assets }
        }
        let runtime = openManager()
        try {
          const thread = await runtime.manager.createThread({
            workingDirectory: root,
            mateId: "mate_test",
            mateRevisionId: "revision_test",
          })
          await thread.startIfIdle({
            content: {
              kind: "parts" as const,
              parts: [{ type: "text" as const, text: "Inspect" }],
            },
          })
          await expect
            .poll(() => thread.agentStatus)
            .toEqual({ completed: "Inspected" })
          const expectedImageMessage = {
            role: "user",
            content: [
              {
                type: "text",
                text: 'Image from tool result "call_image", content part 2:',
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${png.toString("base64")}`,
                  detail: "high",
                },
              },
            ],
          }
          const second = bodies[1]?.messages
          if (!Array.isArray(second)) throw new Error("Missing image request")
          expect(second.slice(-2)).toEqual([
            {
              role: "tool",
              tool_call_id: "call_image",
              content:
                'Read image: screen.png\n[Image from tool result "call_image", content part 2; image follows the tool-result batch.]',
            },
            expectedImageMessage,
          ])
          const canonicalHistory = thread
            .snapshot()
            .context.history.map((entry) => entry.item)
          await runtime.manager.shutdown()
          runtime = openManager()
          const stored = await runtime.store.readThread(thread.id)
          if (stored === undefined)
            throw new Error("Missing durable image history")
          const history = ContextManager.fromStoredThread(stored)
            .snapshot()
            .history.map((entry) => entry.item)
          expect(history).toEqual(canonicalHistory)
          expect(
            history.filter(
              (message) =>
                message.role === "user" && message.context === undefined,
            ),
          ).toHaveLength(1)
          expect(JSON.stringify(history)).not.toContain(
            "Images from tool result",
          )
          const tool = history.find((message) => message.role === "tool")
          const image = tool?.content.find((block) => block.type === "image")
          if (image?.file === undefined)
            throw new Error("Missing stored image reference")
          expect(image.data).toBeUndefined()
          expect(await runtime.assets.read(image.file)).toEqual(png)
          const resumed = await runtime.manager.resumeThread(thread.id)
          if (resumed === undefined) throw new Error("Missing resumed thread")
          await resumed.startIfIdle({
            content: {
              kind: "parts" as const,
              parts: [{ type: "text" as const, text: "Continue" }],
            },
          })
          await expect
            .poll(() => resumed.agentStatus)
            .toEqual({ completed: "Inspected" })
          const third = bodies[2]?.messages
          if (!Array.isArray(third)) throw new Error("Missing resumed request")
          expect(third).toContainEqual(expectedImageMessage)
          expect(
            third.filter(
              (message) =>
                JSON.stringify(message) ===
                JSON.stringify(expectedImageMessage),
            ),
          ).toHaveLength(1)
          expect(bodies).toHaveLength(3)
        } finally {
          await runtime.manager.shutdown()
          await tools.dispose()
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  it("preserves streamed completion annotations and rejects unsupported semantic media", async () => {
    const annotation = {
      type: "url_citation",
      url_citation: {
        start_index: 0,
        end_index: 6,
        title: "Source",
        url: "https://example.com/source",
      },
    }
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          chunk({ content: "Source", annotations: [annotation] }, "stop"),
        ]),
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(terminal(events).content).toMatchObject([
          {
            type: "text",
            text: "Source",
            providerMetadata: {
              chatCompletions: { annotations: [annotation] },
            },
          },
        ])
      },
    )
    for (const field of ["audio", "images", "video", "function_call"]) {
      await withServer(
        (_incoming, outgoing) =>
          send(outgoing, [chunk({ [field]: {} }, "stop")]),
        async (baseURL) => {
          const events = await collect(provider(baseURL)(request()))
          expect(events.at(-1)).toMatchObject({
            type: "failure",
            failure: { kind: "protocol_error", stage: "response_body" },
          })
          expect(events.some((event) => event.type === "response")).toBe(false)
        },
      )
    }
  })

  it("reports HTTP errors and retry hints without an SDK retry", async () => {
    let count = 0
    await withServer(
      (_incoming, outgoing) => {
        count += 1
        outgoing.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "2",
          "x-should-retry": "false",
          "x-request-id": "limited-http",
        })
        outgoing.end(
          JSON.stringify({
            error: { message: "Limited", code: "rate_limit_exceeded" },
          }),
        )
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: {
            kind: "rate_limited",
            status: 429,
            retryAfterMs: 2000,
            serverShouldRetry: false,
            providerRequestId: "limited-http",
          },
        })
        expect(count).toBe(1)
      },
    )
  })

  it("cancels during streaming with a single terminal cancellation", async () => {
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.write(
          `data: ${JSON.stringify(chunk({ content: "Started" }))}\n\n`,
        )
      },
      async (baseURL) => {
        const controller = new AbortController()
        const iterator = provider(baseURL)(
          request({ signal: controller.signal }),
        )[Symbol.asyncIterator]()
        expect((await iterator.next()).value).toMatchObject({
          type: "delta",
          text: "Started",
        })
        controller.abort()
        expect((await iterator.next()).value).toEqual({ type: "cancelled" })
        expect((await iterator.next()).done).toBe(true)
      },
    )
  })

  it("retains reported usage when a raw stream is cancelled after output", async () => {
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.write(
          [usageChunk(), chunk({ content: "Started" })]
            .map((value) => `data: ${JSON.stringify(value)}\n\n`)
            .join(""),
        )
      },
      async (baseURL) => {
        const controller = new AbortController()
        const iterator = provider(baseURL)(
          request({ signal: controller.signal }),
        )[Symbol.asyncIterator]()
        expect((await iterator.next()).value).toMatchObject({ type: "delta" })
        controller.abort()
        expect((await iterator.next()).value).toEqual({
          type: "cancelled",
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            activeContextTokens: 18,
            cacheReadInputTokens: 3,
          },
        })
        expect((await iterator.next()).done).toBe(true)
      },
    )
  })

  it.each([
    "cancel",
    "timeout",
  ])("retains usage while the request wrapper wins a stalled stream with %s", async (ending) => {
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.write(`data: ${JSON.stringify(usageChunk())}\n\n`)
      },
      async (baseURL) => {
        const controller = new AbortController()
        const stream = createModelRequestStream(provider(baseURL), {
          wireApi: "openai_chat_completions",
          maxAttempts: 1,
          streamIdleTimeoutMs: 200,
        })
        const events = await collect(
          stream(
            request({
              signal: controller.signal,
              onUsageSnapshot() {
                if (ending === "cancel") controller.abort()
              },
            }),
          ),
        )
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          type: ending === "cancel" ? "cancelled" : "failure",
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            activeContextTokens: 18,
            cacheReadInputTokens: 3,
          },
          ...(ending === "timeout"
            ? { failure: { kind: "idle_timeout" } }
            : {}),
        })
      },
    )
  })

  it("does not connect after caller cancellation or for unsupported remote compaction", async () => {
    let count = 0
    await withServer(
      (_incoming, outgoing) => {
        count += 1
        send(outgoing, [])
      },
      async (baseURL) => {
        const controller = new AbortController()
        controller.abort()
        expect(
          await collect(
            provider(baseURL)(request({ signal: controller.signal })),
          ),
        ).toEqual([{ type: "cancelled" }])
        expect(
          (
            await collect(
              provider(baseURL)(request({ compaction: "remote_v2" })),
            )
          ).at(-1),
        ).toMatchObject({
          type: "failure",
          failure: { stage: "request_build", kind: "protocol_error" },
        })
        expect(count).toBe(0)
      },
    )
  })
})

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "custom_1",
      model: "unknown-model",
      instructionProfileId: "default",
    },
    continuationScope: "endpoint_1",
    system: [{ id: "system", revision: "1", text: "System instruction" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the repo" }] },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read file",
        inputSchema: { type: "object" },
      },
      {
        name: "evaluate",
        description: "Evaluate",
        kind: "custom",
        customInputFallbackKey: "code",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
      },
    ],
    toolWireProtocol: "eager",
    ...overrides,
  }
}

function provider(
  baseURL: string,
  flavor: "generic" | "deepseek" | "gemini" = "generic",
) {
  return createChatCompletionsProvider({
    apiKey: "test-key",
    model: "default-model",
    baseURL,
    flavor,
  })
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: "completion_test",
    object: "chat.completion.chunk",
    created: 123,
    model: "model-test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function usageChunk() {
  return {
    id: "completion_test",
    object: "chat.completion.chunk",
    created: 123,
    model: "model-test",
    choices: [],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  }
}

function send(response: ServerResponse, chunks: readonly unknown[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-request-id": "request-http",
  })
  response.end(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
  )
}

async function requestBody(
  incoming: IncomingMessage,
): Promise<Record<string, unknown>> {
  const pieces: Buffer[] = []
  for await (const piece of incoming) pieces.push(Buffer.from(piece))
  return JSON.parse(Buffer.concat(pieces).toString("utf8")) as Record<
    string,
    unknown
  >
}

async function withServer(
  handler: (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => void | Promise<void>,
  run: (baseURL: string) => Promise<void>,
) {
  const failures: unknown[] = []
  const server = createServer((incoming, outgoing) => {
    Promise.resolve()
      .then(() => handler(incoming, outgoing))
      .catch((error: unknown) => {
        failures.push(error)
        outgoing.destroy()
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing HTTP address")
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
    if (failures.length > 0) throw failures[0]
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    )
  }
}

async function collect(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function terminal(events: readonly ModelStreamEvent[]) {
  const last = events.at(-1)
  if (last?.type !== "response")
    throw new Error(`Missing response: ${JSON.stringify(last)}`)
  return last.response
}
