import { mkdtemp, rm } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ContextManager } from "../../src/core/context-manager.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { isModelMessage, type ModelMessage } from "../../src/kernel/index.ts"
import {
  createGeminiProvider,
  toGeminiContents,
} from "../../src/runtime/gemini-provider.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

const signedParts = [
  { text: "Plan", thought: true, thoughtSignature: "reasoning-signature" },
  { text: "Checking" },
  {
    functionCall: { name: "inspect", args: { path: "a" }, id: "native_a" },
    thoughtSignature: "call-signature",
  },
  { functionCall: { name: "inspect", args: { path: "b" } } },
  { text: "", thoughtSignature: "empty-signature" },
]

describe("native Gemini provider", () => {
  it("uses header credentials and native text/image/system/tools with scoped exact parts", async () => {
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        expect(incoming.url).toBe(
          "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
        )
        expect(incoming.headers["x-goog-api-key"]).toBe("test-secret")
        expect(incoming.headers.authorization).toBeUndefined()
        body = await requestBody(incoming)
        send(outgoing, [
          chunk(signedParts.slice(0, 2)),
          chunk(signedParts.slice(2), "STOP"),
          {
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 3,
              totalTokenCount: 20,
              cachedContentTokenCount: 4,
            },
          },
        ])
      },
      async (baseURL) => {
        const snapshots: unknown[] = []
        const events = await collect(
          provider(baseURL)(
            request({
              streamOutputItems: true,
              maxOutputTokens: 100,
              onUsageSnapshot: (usage) => snapshots.push(usage),
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Look" },
                    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
                  ],
                },
              ],
            }),
          ),
        )
        const result = terminal(events)
        expect(result).toMatchObject({
          stopReason: "tool_use",
          rawStopReason: "STOP",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            activeContextTokens: 20,
            cacheReadInputTokens: 4,
          },
        })
        expect(snapshots).toEqual([result.usage])
        expect(
          events.filter((event) => event.type === "output_item"),
        ).toHaveLength(1)
        const assistant: ModelMessage = {
          role: "assistant",
          content: result.content,
        }
        expect(isModelMessage(assistant)).toBe(true)
        expect(
          toGeminiContents(
            [assistant],
            "custom_gemini",
            "scope_a",
            "gemini-test",
          ),
        ).toEqual([{ role: "model", parts: signedParts }])
        for (const [owner, scope, model] of [
          ["other", "scope_a", "gemini-test"],
          ["custom_gemini", "scope_b", "gemini-test"],
          ["custom_gemini", "scope_a", "other-model"],
        ]) {
          expect(
            JSON.stringify(
              toGeminiContents([assistant], owner ?? "", scope, model),
            ),
          ).not.toContain("-signature")
          expect(
            JSON.stringify(
              toGeminiContents([assistant], owner ?? "", scope, model),
            ),
          ).toContain('"thoughtSignature":"skip_thought_signature_validator"')
        }
        expect(body).toMatchObject({
          systemInstruction: { parts: [{ text: "System" }] },
          generationConfig: { candidateCount: 1, maxOutputTokens: 100 },
          tools: [
            {
              functionDeclarations: [
                {
                  name: "inspect",
                  description: "Inspect",
                  parametersJsonSchema: { type: "object" },
                },
              ],
            },
          ],
          contents: [
            {
              role: "user",
              parts: [
                { text: "Look" },
                { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
              ],
            },
          ],
        })
      },
    )
  })

  it("persists empty signed parts and parallel IDs through a real agent tool loop and reload", async () => {
    const bodies: Record<string, unknown>[] = []
    const executions: unknown[] = []
    await withServer(
      async (incoming, outgoing) => {
        bodies.push(await requestBody(incoming))
        send(
          outgoing,
          bodies.length === 1
            ? [chunk(signedParts, "STOP")]
            : [
                chunk(
                  [
                    { text: "Finished" },
                    { text: "", thoughtSignature: "final-signature" },
                  ],
                  "STOP",
                ),
              ],
        )
      },
      async (baseURL) => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-native-gemini-"))
        const store = new JsonlThreadStore({ root })
        const tools = createToolRegistry([
          {
            toolName: plainToolName("inspect"),
            description: "Inspect",
            inputSchema: { type: "object" },
            effect: "observe",
            approvalRequirement: { kind: "none" },
            async execute(input) {
              executions.push(input)
              return { ok: true, output: "Inspected", content: "Inspected" }
            },
          },
        ])
        const config = {
          name: "Gemini",
          wireApi: "gemini_generate_content" as const,
          baseURL,
          models: [{ id: "gemini-test" }],
        }
        const registry = createProviderRegistry({
          custom_gemini: createConfiguredProvider(
            "custom_gemini",
            config,
            "test-secret",
          ),
        })
        const manager = new ThreadManager({
          store,
          createTurnProcessor: () =>
            createTurnProcessor({
              modelClient: registry.createClient(),
              provider: "custom_gemini",
              model: "gemini-test",
              toolRegistry: tools,
              baseInstructions: "Test",
              loadProjectInstructions: async () => undefined,
            }),
        })
        try {
          const thread = await manager.createThread({
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
            .toEqual({ completed: "Finished" })
          expect(executions).toEqual([{ path: "a" }, { path: "b" }])
          const contents = bodies[1]?.contents
          expect(contents).toEqual(
            expect.arrayContaining([
              { role: "model", parts: signedParts },
              {
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      id: "native_a",
                      name: "inspect",
                      response: { output: "Inspected" },
                    },
                  },
                  {
                    functionResponse: {
                      name: "inspect",
                      response: { output: "Inspected" },
                    },
                  },
                ],
              },
            ]),
          )
          await manager.shutdown()
          const reopened = new JsonlThreadStore({ root })
          const stored = await reopened.readThread(thread.id)
          if (stored === undefined) throw new Error("Missing thread")
          const history = ContextManager.fromStoredThread(stored)
            .snapshot()
            .history.map((entry) => entry.item)
          expect(JSON.stringify(history)).toContain("empty-signature")
          expect(JSON.stringify(history)).toContain("final-signature")
          // A new configured provider has a stable scope after process reload.
          const reloaded = createConfiguredProvider(
            "custom_gemini",
            config,
            "test-secret",
          ).startTurn({ maxAttempts: 1 })
          await collect(reloaded.stream(request({ messages: history })))
          expect(JSON.stringify(bodies.at(-1)?.contents)).toContain(
            "empty-signature",
          )
          await reloaded.close()
          const switched = createConfiguredProvider(
            "custom_gemini",
            config,
            "other-key",
          ).startTurn({ maxAttempts: 1 })
          await collect(switched.stream(request({ messages: history })))
          expect(JSON.stringify(bodies.at(-1)?.contents)).not.toContain(
            "-signature",
          )
          expect(JSON.stringify(bodies.at(-1)?.contents)).toContain(
            '"thoughtSignature":"skip_thought_signature_validator"',
          )
          await switched.close()
        } finally {
          await manager.shutdown()
          await tools.dispose()
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  it.each([
    [
      "missing finish",
      [chunk([{ functionCall: { name: "inspect", args: {} } }])],
      "stream_disconnected",
    ],
    [
      "malformed arguments",
      [chunk([{ functionCall: { name: "inspect", args: "{" } }], "STOP")],
      "protocol_error",
    ],
    [
      "partial arguments",
      [
        chunk(
          [
            {
              functionCall: {
                name: "inspect",
                partialArgs: [],
                willContinue: true,
              },
            },
          ],
          "STOP",
        ),
      ],
      "protocol_error",
    ],
    [
      "duplicate IDs",
      [
        chunk(
          [
            { functionCall: { name: "inspect", id: "same" } },
            { functionCall: { name: "inspect", id: "same" } },
          ],
          "STOP",
        ),
      ],
      "protocol_error",
    ],
    [
      "multiple candidates",
      [{ candidates: [{ index: 0 }, { index: 1 }] }],
      "protocol_error",
    ],
    [
      "unexpected finish",
      [chunk([], "MALFORMED_FUNCTION_CALL")],
      "protocol_error",
    ],
    [
      "generated image",
      [
        chunk(
          [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
          "STOP",
        ),
      ],
      "protocol_error",
    ],
  ])("does not commit any executable output after %s", async (_name, chunks, kind) => {
    await withServer(
      (_incoming, outgoing) => send(outgoing, chunks),
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(request({ streamOutputItems: true })),
        )
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind },
        })
        expect(
          events.some(
            (event) =>
              event.type === "output_item" || event.type === "response",
          ),
        ).toBe(false)
      },
    )
  })

  it.each([
    "MAX_TOKENS",
    "SAFETY",
  ])("never executes a tool batch stopped by %s", async (finishReason) => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          chunk(
            [
              { text: "Partial" },
              { functionCall: { name: "inspect", args: {} } },
            ],
            finishReason,
          ),
        ]),
      async (baseURL) => {
        const response = terminal(await collect(provider(baseURL)(request())))
        expect(response).toMatchObject({
          stopReason:
            finishReason === "MAX_TOKENS" ? "length" : "content_filter",
          incompleteToolCalls: true,
          content: [{ type: "text", text: "Partial" }],
        })
      },
    )
  })

  it("maps prompt blocks without fabricating a completed tool response", async () => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [{ promptFeedback: { blockReason: "SAFETY" } }]),
      async (baseURL) => {
        expect(
          terminal(await collect(provider(baseURL)(request()))),
        ).toMatchObject({
          stopReason: "content_filter",
          rawStopReason: "SAFETY",
          content: [],
        })
      },
    )
  })

  it.each([
    [401, "authentication"],
    [429, "rate_limited"],
    [503, "server_error"],
  ])("maps HTTP %s with retry timing without leaking credentials", async (status, kind) => {
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(status as number, { "retry-after": "2" })
        outgoing.end("test-secret private error")
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind, status, retryAfterMs: 2000 },
        })
        expect(JSON.stringify(events)).not.toContain("test-secret")
      },
    )
  })

  it("retains observed usage on mid-stream API errors", async () => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          { usageMetadata: { promptTokenCount: 7 } },
          { error: { code: 429, message: "private detail" } },
        ]),
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind: "rate_limited", status: 429 },
          usage: { inputTokens: 7 },
        })
        expect(JSON.stringify(events)).not.toContain("private detail")
      },
    )
  })

  it("cancels after provisional text and usage without committing functions", async () => {
    const controller = new AbortController()
    await withServer(
      (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "text/event-stream" })
        outgoing.write(
          `data: ${JSON.stringify({ ...chunk([{ text: "Partial" }, { functionCall: { name: "inspect", args: {} } }]), usageMetadata: { promptTokenCount: 9 } })}\n\n`,
        )
      },
      async (baseURL) => {
        const events: ModelStreamEvent[] = []
        for await (const event of provider(baseURL)(
          request({ signal: controller.signal, streamOutputItems: true }),
        )) {
          events.push(event)
          if (event.type === "delta") controller.abort()
        }
        expect(events.at(-1)).toMatchObject({
          type: "cancelled",
          usage: { inputTokens: 9 },
        })
        expect(events.some((event) => event.type === "output_item")).toBe(false)
      },
    )
  })

  it("handles byte-split Unicode, CRLF, comments and multiline SSE data", async () => {
    const raw = `: comment\r\ndata: {"candidates":\r\ndata: [{"content":{"role":"model","parts":[{"text":"你好"}]},"finishReason":"STOP"}]}\r\n\r\n`
    const bytes = new TextEncoder().encode(raw)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const fakeFetch: typeof fetch = async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const events = await collect(
      createGeminiProvider({
        apiKey: "fake",
        model: "gemini-test",
        baseURL: "https://example.com",
        fetchFn: fakeFetch,
      })(request()),
    )
    expect(terminal(events).content).toMatchObject([
      { type: "text", text: "你好" },
    ])
  })

  it.each([
    "data: {bad}\n\n",
    'data: {"candidates": []}',
    'data: {"candidates": []}\n',
  ])("rejects malformed or unterminated SSE %s", async (raw) => {
    const fakeFetch: typeof fetch = async () =>
      new Response(raw, { headers: { "content-type": "text/event-stream" } })
    const events = await collect(
      createGeminiProvider({
        apiKey: "fake",
        model: "gemini-test",
        baseURL: "https://example.com",
        fetchFn: fakeFetch,
      })(request()),
    )
    expect(events.at(-1)?.type).toBe("failure")
  })

  it("blocks HTTP redirects before a custom endpoint can forward the API key", async () => {
    let forwarded = 0
    await withServer(
      async (incoming, outgoing) => {
        if (incoming.url === "/forwarded") {
          forwarded++
          send(outgoing, [chunk([], "STOP")])
          return
        }
        outgoing.writeHead(307, { location: "/forwarded" })
        outgoing.end()
      },
      async (baseURL) => {
        const events = await collect(provider(baseURL)(request()))
        expect(events.at(-1)?.type).toBe("failure")
        expect(forwarded).toBe(0)
      },
    )
  })

  it("round-trips custom tool JSON fallbacks and source-labelled tool images", async () => {
    await withServer(
      (_incoming, outgoing) =>
        send(outgoing, [
          chunk(
            [{ functionCall: { name: "evaluate", args: { code: "1+1" } } }],
            "STOP",
          ),
        ]),
      async (baseURL) => {
        const response = terminal(
          await collect(
            provider(baseURL)(
              request({
                tools: [
                  {
                    name: "evaluate",
                    description: "Evaluate",
                    kind: "custom",
                    customInputFallbackKey: "code",
                    inputSchema: { type: "object" },
                  },
                ],
              }),
            ),
          ),
        )
        const call = response.content[0]
        if (call?.type !== "tool_call") throw new Error("Missing custom call")
        expect(call).toMatchObject({
          toolKind: "custom",
          input: "1+1",
          customInputFallbackKey: "code",
        })
        const contents = toGeminiContents(
          [
            { role: "assistant", content: response.content },
            {
              role: "tool",
              toolCallId: call.id,
              content: [
                { type: "text", text: "2" },
                { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
              ],
            },
          ],
          "custom_gemini",
          "scope_a",
          "gemini-test",
        )
        expect(contents[0]).toEqual({
          role: "model",
          parts: [
            { functionCall: { name: "evaluate", args: { code: "1+1" } } },
          ],
        })
        expect(contents[1]).toEqual({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "evaluate",
                response: {
                  output: [
                    { text: "2" },
                    {
                      text: `[Image from tool evaluate, call ${call.id}, content part 2; image follows the function response.]`,
                    },
                  ],
                },
              },
            },
            {
              text: `[Image from tool evaluate, call ${call.id}, content part 2]`,
            },
            { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
          ],
        })
      },
    )
  })

  it.each([
    "gemini-3-flash-preview",
    "models/gemini-3.8-flash",
  ])("binds parallel tool images inside native function responses for %s", async (model) => {
    const messages = imageToolHistory(model)
    const original = structuredClone(messages)
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        body = await requestBody(incoming)
        send(outgoing, [chunk([{ text: "Images inspected" }], "STOP")])
      },
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(
            request({
              target: {
                provider: "custom_gemini",
                model,
                instructionProfileId: "default",
              },
              messages,
            }),
          ),
        )
        expect(terminal(events).content).toMatchObject([
          { type: "text", text: "Images inspected" },
        ])
      },
    )
    expect(messages).toEqual(original)
    expect(body?.contents).toMatchObject([
      {
        role: "model",
        parts: [
          { functionCall: { name: "inspect", id: "native_a" } },
          { functionCall: { name: "inspect", id: "native_b" } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "inspect",
              id: "native_a",
              response: {
                error: [
                  { text: "Partial first result" },
                  { $ref: "tool_0_image_0" },
                  { $ref: "tool_0_image_1" },
                ],
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "YWJj",
                    displayName: "tool_0_image_0",
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/webp",
                    data: "ZGVm",
                    displayName: "tool_0_image_1",
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              name: "inspect",
              id: "native_b",
              response: {
                output: [{ text: "Second result" }, { $ref: "tool_1_image_0" }],
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: "Z2hp",
                    displayName: "tool_1_image_0",
                  },
                },
              ],
            },
          },
        ],
      },
    ])
    const contents = body?.contents as Array<{
      parts: Array<Record<string, unknown>>
    }>
    expect(contents).toHaveLength(2)
    expect(contents[1]?.parts).toHaveLength(2)
    expect(
      contents[1]?.parts.every(
        (part) => Object.keys(part).join() === "functionResponse",
      ),
    ).toBe(true)
  })

  it.each([
    "gemini-3.8-flash",
    "models/gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
  ])("keeps PDF and image references inside their signed owning responses for %s", async (model) => {
    const messages = pdfToolHistory(model)
    const original = structuredClone(messages)
    let body: Record<string, unknown> | undefined
    await withServer(
      async (incoming, outgoing) => {
        body = await requestBody(incoming)
        send(outgoing, [chunk([{ text: "Read" }], "STOP")])
      },
      async (baseURL) => {
        const events = await collect(
          provider(baseURL)(
            request({
              target: {
                provider: "custom_gemini",
                model,
                instructionProfileId: "default",
              },
              messages,
            }),
          ),
        )
        expect(terminal(events).content).toMatchObject([
          { type: "text", text: "Read" },
        ])
      },
    )
    expect(body?.contents).toEqual([
      {
        role: "model",
        parts: ["a", "b"].map((id) => ({
          functionCall: {
            name: "inspect",
            id: `native_${id}`,
            args: { path: id },
          },
          thoughtSignature: `signature_${id}`,
        })),
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "inspect",
              id: "native_a",
              response: {
                error: [
                  { text: "Before" },
                  { $ref: "tool_0_pdf_0" },
                  { text: "Between" },
                  { $ref: "tool_0_image_0" },
                  { text: "After" },
                  { $ref: "tool_0_pdf_1" },
                ],
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    displayName: "tool_0_pdf_0",
                    data: "JVBERi0x",
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/png",
                    displayName: "tool_0_image_0",
                    data: "YWJj",
                  },
                },
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    displayName: "tool_0_pdf_1",
                    data: "JVBERi0y",
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              name: "inspect",
              id: "native_b",
              response: {
                output: [
                  { text: "Before" },
                  { $ref: "tool_1_pdf_0" },
                  { text: "Between" },
                  { $ref: "tool_1_image_0" },
                  { text: "After" },
                  { $ref: "tool_1_pdf_1" },
                ],
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    displayName: "tool_1_pdf_0",
                    data: "JVBERi0x",
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/png",
                    displayName: "tool_1_image_0",
                    data: "YWJj",
                  },
                },
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    displayName: "tool_1_pdf_1",
                    data: "JVBERi0y",
                  },
                },
              ],
            },
          },
        ],
      },
    ])
    expect(messages).toEqual(original)
  })

  it.each([
    "gemini-2.5-pro",
    "gemini-3-custom",
    "gemini-4-pro",
    undefined,
  ])("does not send native PDFs for unsupported or unconfirmed model %s", (model) => {
    const contents = toGeminiContents(
      pdfToolHistory(model ?? "gemini-test"),
      "custom_gemini",
      "scope_a",
      model,
    )
    const serialized = JSON.stringify(contents)
    expect(serialized).not.toContain("application/pdf")
    expect(serialized).not.toContain("JVBERi0")
    expect(
      serialized.match(/native PDF input is not enabled for Gemini/g),
    ).toHaveLength(4)
  })

  it("rejects unhydrated native PDFs before fetch without changing history", async () => {
    const model = "gemini-3-flash-preview"
    const messages = pdfToolHistory(model).map((message) =>
      message.role !== "tool"
        ? message
        : {
            ...message,
            content: message.content.map((block) => {
              if (block.type !== "document") return block
              const { data: _data, ...unresolved } = block
              return unresolved
            }),
          },
    )
    const original = structuredClone(messages)
    let requests = 0
    const events = await collect(
      createGeminiProvider({
        apiKey: "fake",
        model,
        baseURL: "https://example.com",
        fetchFn: async () => {
          requests++
          throw new Error("Unexpected fetch")
        },
      })(
        request({
          target: {
            provider: "custom_gemini",
            model,
            instructionProfileId: "default",
          },
          messages,
        }),
      ),
    )
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: { kind: "protocol_error", stage: "request_build" },
      },
    ])
    expect(requests).toBe(0)
    expect(messages).toEqual(original)
  })

  it.each([
    { model: "gemini-3-flash-preview", source: "tool" },
    { model: "gemini-2.5-pro", source: "user" },
  ] as const)("bounds the entire $source PDF request to $model at 100 MB of serialized UTF-8 before fetch", async ({
    model,
    source,
  }) => {
    const document = {
      type: "document" as const,
      name: "report.pdf",
      mediaType: "application/pdf" as const,
      sizeBytes: 1,
      file: { rolloutId: "rollout_test", path: "report.pdf" },
      data: "",
    }
    const base = request({
      target: {
        provider: "custom_gemini",
        model,
        instructionProfileId: "default",
      },
      system: [{ id: "system", revision: "1", text: "a" }],
      messages:
        source === "user"
          ? [{ role: "user", content: [document, document] }]
          : [
              {
                role: "assistant",
                content: [
                  { type: "tool_call", id: "call", name: "inspect", input: {} },
                ],
              },
              {
                role: "tool",
                toolCallId: "call",
                content: [document, document],
              },
            ],
    })
    const lengths: number[] = []
    const stream = createGeminiProvider({
      apiKey: "fake",
      model,
      baseURL: "https://example.com",
      fetchFn: async (_url, init) => {
        lengths.push(Buffer.byteLength(String(init?.body), "utf8"))
        return new Response(
          `data: ${JSON.stringify(chunk([{ text: "Read" }], "STOP"))}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      },
    })
    // Measure the fixture's non-binary wire bytes, then fill the independent
    // documented boundary exactly with two PDFs, each below 50 MB decoded.
    terminal(await collect(stream(base)))
    const padding = 100_000_000 - (lengths[0] ?? 0)
    const firstLength = Math.floor(padding / 2)
    const secondLength = padding - firstLength
    const boundary = {
      ...base,
      messages: base.messages.map((message) =>
        message.role !== "tool" && message.role !== "user"
          ? message
          : {
              ...message,
              content: [firstLength, secondLength].map((length) => ({
                ...document,
                data: "A".repeat(length),
                sizeBytes: Math.ceil((length * 3) / 4),
              })),
            },
      ),
    }
    terminal(await collect(stream(boundary)))
    expect(lengths[1]).toBe(100_000_000)
    // Same JS character count, two more UTF-8 bytes from the system prompt.
    const events = await collect(
      stream({
        ...boundary,
        system: [{ id: "system", revision: "1", text: "界" }],
      }),
    )
    expect(lengths).toHaveLength(2)
    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          provider: "custom_gemini",
          wireApi: "gemini_generate_content",
          stage: "request_build",
          kind: "invalid_request",
          message:
            "The Gemini request exceeds the 100 MB inline limit. Retry with fewer PDF pages, smaller attachments or less request content.",
        },
      },
    ])
  })

  it.each([
    "gemini-2.5-pro",
    "gemini-test",
    "gemini-4-pro",
    undefined,
  ])("retains the labeled fallback for older or unconfirmed model %s", (model) => {
    const contents = toGeminiContents(
      imageToolHistory(model ?? "gemini-test"),
      "custom_gemini",
      "scope_a",
      model,
    )
    const parts = contents[1]?.parts ?? []
    expect(parts.filter((part) => part.inlineData !== undefined)).toHaveLength(
      3,
    )
    expect(
      parts.filter((part) => part.functionResponse !== undefined),
    ).toHaveLength(2)
    expect(JSON.stringify(parts)).not.toContain("displayName")
    expect(parts).toContainEqual({
      text: "[Image from tool inspect, call call_a, content part 2]",
    })
    expect(parts).toContainEqual({
      text: "[Image from tool inspect, call call_b, content part 2]",
    })
  })

  it("rejects unsupported native tool image formats before issuing a request", async () => {
    let requests = 0
    const model = "gemini-3-flash-preview"
    const history = imageToolHistory(model)
    const messages: ModelMessage[] = history.map((message) =>
      message.role === "tool"
        ? {
            ...message,
            content: [{ type: "image", mediaType: "image/gif", data: "R0lG" }],
          }
        : message,
    )
    const events = await collect(
      createGeminiProvider({
        apiKey: "fake",
        model,
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        fetchFn: async () => {
          requests += 1
          throw new Error("Unexpected network request")
        },
      })(
        request({
          target: {
            provider: "custom_gemini",
            model,
            instructionProfileId: "default",
          },
          messages,
        }),
      ),
    )
    expect(requests).toBe(0)
    expect(events).toMatchObject([
      {
        type: "failure",
        failure: { kind: "protocol_error", stage: "request_build" },
      },
    ])
  })

  it("rejects unmatched results before connecting", async () => {
    let requests = 0
    const fakeFetch: typeof fetch = async () => {
      requests++
      throw new Error("Unexpected fetch")
    }
    const stream = createGeminiProvider({
      apiKey: "fake",
      model: "gemini-test",
      baseURL: "https://example.com",
      fetchFn: fakeFetch,
    })
    const events = await collect(
      stream(
        request({
          messages: [
            {
              role: "tool",
              toolCallId: "missing",
              content: [{ type: "text", text: "result" }],
            },
          ],
        }),
      ),
    )
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { stage: "request_build" },
    })
    expect(requests).toBe(0)
  })
})

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "custom_gemini",
      model: "gemini-test",
      instructionProfileId: "default",
    },
    continuationScope: "scope_a",
    system: [{ id: "system", revision: "1", text: "System" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect" }] }],
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
    toolWireProtocol: "eager",
    ...overrides,
  }
}
function provider(baseURL: string) {
  return createGeminiProvider({
    apiKey: "test-secret",
    model: "gemini-test",
    baseURL,
  })
}
function imageToolHistory(model: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: ["a", "b"].map((id) => ({
        type: "tool_call" as const,
        id: `call_${id}`,
        name: "inspect",
        input: { path: id },
        providerMetadata: {
          gemini: {
            provider: "custom_gemini",
            scope: "scope_a",
            model,
            part: {
              functionCall: {
                name: "inspect",
                id: `native_${id}`,
                args: { path: id },
              },
              thoughtSignature: `signature_${id}`,
            },
          },
        },
      })),
    },
    {
      role: "tool",
      toolCallId: "call_a",
      content: [
        { type: "text", text: "Partial first result" },
        { type: "image", mediaType: "image/png", data: "YWJj" },
        { type: "image", mediaType: "image/webp", data: "ZGVm" },
      ],
      isError: true,
    },
    {
      role: "tool",
      toolCallId: "call_b",
      content: [
        { type: "text", text: "Second result" },
        { type: "image", mediaType: "image/jpeg", data: "Z2hp" },
      ],
    },
  ]
}

function pdfToolHistory(model: string): ModelMessage[] {
  const pdf = {
    type: "document" as const,
    name: "report.pdf",
    mediaType: "application/pdf" as const,
    sizeBytes: 6,
    file: { rolloutId: "rollout_test", path: "report.pdf" },
    data: "JVBERi0x",
  }
  return imageToolHistory(model).map((message) =>
    message.role !== "tool"
      ? message
      : {
          ...message,
          content: [
            { type: "text", text: "Before" },
            pdf,
            { type: "text", text: "Between" },
            { type: "image", mediaType: "image/png", data: "YWJj" },
            { type: "text", text: "After" },
            { ...pdf, data: "JVBERi0y" },
          ],
        },
  )
}

function chunk(parts: readonly unknown[], finishReason?: string) {
  return {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
  }
}
function send(response: ServerResponse, chunks: readonly unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(
    chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""),
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
    await run(`http://127.0.0.1:${address.port}/v1beta`)
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
