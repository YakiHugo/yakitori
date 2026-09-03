import OpenAI from "openai"
import type { Response } from "openai/resources/responses/responses"
import { describe, expect, it } from "vitest"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
} from "../../src/runtime/model.ts"
import {
  createOpenAIProvider,
  fromOpenAIResponse,
  toOpenAIInput,
  toOpenAITools,
} from "../../src/runtime/openai-provider.ts"

describe("OpenAI Responses provider", () => {
  it("converts internal history and function tools", () => {
    expect(
      toOpenAIInput([
        {
          role: "developer",
          content: [{ type: "text", text: "state update" }],
        },
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
      { role: "developer", content: "state update" },
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

  it("round-trips client tool search as protocol items and loads the matched definition", () => {
    const searchCall = fromOpenAIResponse(
      responseFixture({
        output: [
          {
            type: "tool_search_call",
            id: "item_search_1",
            call_id: "search_1",
            execution: "client",
            status: "completed",
            arguments: { query: "calendar events", limit: 5 },
          },
        ] as Response["output"],
      }),
    )
    expect(searchCall).toMatchObject({
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "search_1",
          name: "tool_search",
          input: { query: "calendar events", limit: 5 },
          toolKind: "tool_search",
        },
      ],
    })

    const deferred = {
      name: "calendar__search_events",
      description: "Search calendar events",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" } },
      },
      deferLoading: true,
    }
    expect(
      toOpenAITools([
        {
          name: "tool_search",
          description: "Find tools",
          inputSchema: { type: "object" },
          kind: "tool_search",
        },
        deferred,
      ]),
    ).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description: "Find tools",
        parameters: { type: "object" },
      },
    ])
    expect(
      toOpenAIInput([
        { role: "assistant", content: searchCall.content },
        {
          role: "tool",
          toolCallId: "search_1",
          content: JSON.stringify({ tools: [deferred] }),
          toolSearch: { tools: [deferred] },
        },
      ]),
    ).toEqual([
      {
        type: "tool_search_call",
        call_id: "search_1",
        execution: "client",
        status: "completed",
        arguments: { query: "calendar events", limit: 5 },
      },
      {
        type: "tool_search_output",
        call_id: "search_1",
        execution: "client",
        status: "completed",
        tools: [
          {
            type: "function",
            name: "calendar__search_events",
            description: "Search calendar events",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
    ])
  })

  it("round-trips custom freeform tools and their outputs", () => {
    const grammar = {
      type: "grammar" as const,
      syntax: "lark" as const,
      definition: 'start: "patch"',
    }
    expect(
      toOpenAITools([
        {
          name: "apply_patch",
          description: "Apply a patch",
          kind: "custom",
          inputFormat: grammar,
          inputSchema: { type: "object" },
        },
      ]),
    ).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: grammar,
      },
    ])
    expect(
      toOpenAIInput([
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "patch_1",
              name: "apply_patch",
              input: "*** Begin Patch",
              toolKind: "custom",
              customInputFallbackKey: "patch",
            },
          ],
        },
        { role: "tool", toolCallId: "patch_1", content: "Done" },
      ]),
    ).toEqual([
      {
        type: "custom_tool_call",
        call_id: "patch_1",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
      {
        type: "custom_tool_call_output",
        call_id: "patch_1",
        output: "Done",
      },
    ])

    expect(
      fromOpenAIResponse(
        responseFixture({
          output: [
            {
              type: "custom_tool_call",
              id: "item_patch_1",
              call_id: "patch_1",
              name: "apply_patch",
              input: "*** Begin Patch",
            },
          ],
        }),
        new Map([["apply_patch", "patch"]]),
      ).content,
    ).toEqual([
      {
        type: "tool_call",
        id: "patch_1",
        name: "apply_patch",
        input: "*** Begin Patch",
        toolKind: "custom",
        customInputFallbackKey: "patch",
      },
    ])
  })

  it("parses custom calls with the exact definition loaded by tool search", async () => {
    const historical = {
      name: "demo__evaluate",
      description: "Evaluate code",
      inputSchema: {
        type: "object" as const,
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      kind: "custom" as const,
      inputFormat: {
        type: "grammar" as const,
        syntax: "lark" as const,
        definition: "start: /.+/",
      },
      customInputFallbackKey: "code",
      deferLoading: true,
    }
    const current = {
      ...historical,
      inputSchema: {
        type: "object" as const,
        properties: { script: { type: "string" } },
        required: ["script"],
      },
      customInputFallbackKey: "script",
    }
    const toolSearch = {
      name: "tool_search",
      description: "Find tools",
      inputSchema: { type: "object" as const },
      kind: "tool_search" as const,
    }
    const unrelated = {
      name: "calendar__list_events",
      description: "List events",
      inputSchema: { type: "object" as const },
      deferLoading: true,
    }
    const messages: ModelRequest["messages"] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "search_1",
            name: "tool_search",
            input: { query: "evaluate" },
            toolKind: "tool_search",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "search_1",
        content: JSON.stringify({ tools: [historical] }),
        toolSearch: { tools: [historical] },
      },
    ]
    const call = {
      type: "custom_tool_call" as const,
      id: "item_eval_1",
      call_id: "eval_1",
      name: "demo__evaluate",
      input: "1 + 1",
    }

    for (const tools of [
      [toolSearch, unrelated],
      [toolSearch, current],
    ]) {
      const client = {
        responses: {
          async create() {
            return (async function* () {
              yield {
                type: "response.completed",
                response: responseFixture({ output: [call] }),
              }
            })()
          },
        },
      } as unknown as OpenAI
      const stream = createOpenAIProvider({
        apiKey: "test",
        model: "gpt-test",
        client,
      })
      const events = []
      for await (const event of stream(
        requestFixture({
          tools,
          messages,
          toolWireProtocol: "openai_deferred",
        }),
      )) {
        events.push(event)
      }

      expect(events).toEqual([
        {
          type: "response",
          response: expect.objectContaining({
            content: [
              expect.objectContaining({
                type: "tool_call",
                name: "demo__evaluate",
                toolKind: "custom",
                customInputFallbackKey: "code",
              }),
            ],
          }),
        },
      ])
    }
  })

  it("converts attached images into Responses API input blocks", () => {
    expect(
      toOpenAIInput([
        {
          role: "user",
          content: [{ type: "text", text: "Inspect this" }],
          images: [
            { type: "image", mediaType: "image/webp", data: "aGVsbG8=" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this" },
          {
            type: "input_image",
            detail: "high",
            image_url: "data:image/webp;base64,aGVsbG8=",
          },
        ],
      },
    ])
  })

  it("preserves original image detail on the wire", () => {
    const input = toOpenAIInput([
      {
        role: "user",
        content: [],
        images: [
          {
            type: "image",
            mediaType: "image/png",
            detail: "original",
            data: "aGVsbG8=",
          },
        ],
      },
    ])

    expect(input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            detail: "original",
            image_url: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
    ])
  })

  it("restores durable reasoning items for a tool continuation", () => {
    expect(
      toOpenAIInput([
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Inspect the repository first.",
              providerMetadata: {
                openai: {
                  id: "reasoning_1",
                  encryptedContent: "encrypted_1",
                  status: "completed",
                },
              },
            },
            {
              type: "tool_call",
              id: "call_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "reasoning",
        id: "reasoning_1",
        summary: [
          { type: "summary_text", text: "Inspect the repository first." },
        ],
        encrypted_content: "encrypted_1",
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    ])
  })

  it("does not replay reasoning owned by a different provider identity", () => {
    expect(
      toOpenAIInput(
        [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "Private continuation state.",
                providerMetadata: {
                  openai: {
                    provider: "codex",
                    id: "reasoning_1",
                    encryptedContent: "encrypted_1",
                  },
                },
              },
              { type: "text", text: "Visible answer." },
            ],
          },
        ],
        true,
        "openai",
      ),
    ).toEqual([{ role: "assistant", content: "Visible answer." }])
  })

  it("does not replay reasoning owned by a different backend scope", () => {
    expect(
      toOpenAIInput(
        [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "Private continuation state.",
                providerMetadata: {
                  openai: {
                    provider: "openai",
                    scope: "account-a",
                    id: "reasoning_1",
                    encryptedContent: "encrypted_1",
                  },
                },
              },
              { type: "text", text: "Visible answer." },
            ],
          },
        ],
        true,
        "openai",
        "account-b",
      ),
    ).toEqual([{ role: "assistant", content: "Visible answer." }])
  })

  it("uses xAI context details for active context size", () => {
    const response = responseFixture({
      usage: {
        input_tokens: 40,
        output_tokens: 8,
        total_tokens: 48,
        context_details: { input_tokens: 30, output_tokens: 6 },
      } as never,
    })

    expect(fromOpenAIResponse(response, new Map(), "grok").usage).toMatchObject(
      { activeContextTokens: 36 },
    )
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
            {
              type: "function_call",
              id: "item_2",
              call_id: "call_2",
              name: "grep",
              arguments: '{"pattern":"needle"}',
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
        {
          type: "tool_call",
          id: "call_2",
          name: "grep",
          input: { pattern: "needle" },
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        activeContextTokens: 14,
      },
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

  it("maps public reasoning summaries with continuation metadata", () => {
    expect(
      fromOpenAIResponse(
        responseFixture({
          output: [
            {
              type: "reasoning",
              id: "reasoning_1",
              summary: [
                { type: "summary_text", text: "Inspect the repository." },
              ],
              encrypted_content: "encrypted_1",
              status: "completed",
            },
            {
              type: "message",
              id: "message_1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Done.", annotations: [] },
              ],
            },
          ],
        }),
      ).content,
    ).toEqual([
      {
        type: "reasoning",
        text: "Inspect the repository.",
        providerMetadata: {
          openai: {
            provider: "openai",
            id: "reasoning_1",
            encryptedContent: "encrypted_1",
            status: "completed",
          },
        },
      },
      { type: "text", text: "Done." },
    ])
  })

  it("selects native deferred loading only for official request targets", async () => {
    const deferred = {
      name: "calendar__search_events",
      description: "Search calendar events",
      inputSchema: { type: "object" as const },
      deferLoading: true,
    }
    const toolSearch = {
      name: "tool_search",
      description: "Find tools",
      inputSchema: { type: "object" as const },
      kind: "tool_search" as const,
    }
    const tools: ModelRequest["tools"] = [toolSearch, deferred]
    const useTool = {
      name: "use_tool",
      description: "Invoke a deferred tool",
      inputSchema: { type: "object" as const },
    }
    const messages: ModelRequest["messages"] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "search_1",
            name: "tool_search",
            input: { query: "calendar" },
            toolKind: "tool_search",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "search_1",
        content: JSON.stringify({ tools: [deferred] }),
        toolSearch: { tools: [deferred] },
      },
    ]
    const capture = async (
      provider: string,
      toolWireProtocol: ModelRequest["toolWireProtocol"],
      requestTools: ModelRequest["tools"] = tools,
    ) => {
      let body: Record<string, unknown> | undefined
      const client = {
        responses: {
          async create(input: Record<string, unknown>) {
            body = input
            return (async function* () {
              yield {
                type: "response.completed",
                response: responseFixture(),
              }
            })()
          },
        },
      } as unknown as OpenAI
      const stream = createOpenAIProvider({
        apiKey: "test",
        model: "gpt-test",
        client,
      })
      for await (const _event of stream(
        requestFixture({
          target: {
            provider,
            model: "gpt-test",
            instructionProfileId: "codex",
          },
          tools: requestTools,
          messages,
          toolWireProtocol,
        }),
      )) {
        void _event
      }
      return body
    }

    const official = await capture("openai", "openai_deferred")
    expect(official?.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description: "Find tools",
        parameters: { type: "object" },
      },
    ])
    expect(official?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_search_call" }),
        expect.objectContaining({ type: "tool_search_output" }),
      ]),
    )

    const compatible = await capture("xai", "meta_dispatch", [
      toolSearch,
      useTool,
    ])
    expect(compatible?.tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" }),
      expect.objectContaining({ type: "function", name: "use_tool" }),
    ])
    expect(compatible?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", name: "tool_search" }),
        expect.objectContaining({ type: "function_call_output" }),
      ]),
    )
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
    for await (const event of stream(
      requestFixture({
        cacheKey: "conversation_1",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "project rules" }],
          },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    )) {
      events.push(event)
    }

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
      instructions: "Be helpful.",
      input: [
        { role: "user", content: "project rules" },
        { role: "user", content: "hello" },
      ],
      stream: true,
      store: false,
      parallel_tool_calls: true,
      prompt_cache_key: "conversation_1",
    })
  })

  it("streams public reasoning summary snapshots", async () => {
    const client = {
      responses: {
        async create() {
          return (async function* () {
            yield {
              type: "response.reasoning_summary_text.delta",
              delta: "Inspect",
            }
            yield {
              type: "response.reasoning_summary_text.delta",
              delta: " files",
            }
            yield {
              type: "response.completed",
              response: responseFixture({ output: [] }),
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
      { type: "reasoning_snapshot", text: "Inspect" },
      { type: "reasoning_snapshot", text: "Inspect files" },
      expect.objectContaining({ type: "response" }),
    ])
  })

  it("passes a pinned reasoning effort through to the request params", async () => {
    let body: unknown
    const client = {
      responses: {
        async create(input: unknown) {
          body = input
          return (async function* () {
            yield {
              type: "response.completed",
              response: responseFixture({ output: [] }),
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

    for await (const _event of stream(
      requestFixture({
        target: {
          provider: "openai",
          model: "gpt-request",
          instructionProfileId: "codex",
          effort: "high",
        },
      }),
    )) {
      // Drain the stream.
    }

    expect(body).toMatchObject({
      model: "gpt-request",
      reasoning: { effort: "high" },
    })
  })

  it("maps a pinned fast speed to the priority service tier", async () => {
    let body: unknown
    const client = {
      responses: {
        async create(input: unknown) {
          body = input
          return (async function* () {
            yield {
              type: "response.completed",
              response: responseFixture({ output: [] }),
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

    for await (const _event of stream(
      requestFixture({
        target: {
          provider: "codex",
          model: "gpt-5.6-sol",
          instructionProfileId: "codex",
          effort: "high",
          speed: "fast",
        },
      }),
    )) {
      // Drain the stream.
    }

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      service_tier: "priority",
    })
  })

  it("omits service_tier for standard or absent speed", async () => {
    for (const speed of ["standard", undefined]) {
      let body: unknown
      const client = {
        responses: {
          async create(input: unknown) {
            body = input
            return (async function* () {
              yield {
                type: "response.completed",
                response: responseFixture({ output: [] }),
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

      for await (const _event of stream(
        requestFixture({
          target: {
            provider: "codex",
            model: "gpt-5.6-sol",
            instructionProfileId: "codex",
            ...(speed === undefined ? {} : { speed }),
          },
        }),
      )) {
        // Drain the stream.
      }

      expect(body).not.toHaveProperty("service_tier")
    }
  })

  it("requests automatic reasoning summaries without pinning effort", async () => {
    let body: unknown
    const client = {
      responses: {
        async create(input: unknown) {
          body = input
          return (async function* () {
            yield {
              type: "response.completed",
              response: responseFixture({ output: [] }),
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

    for await (const _event of stream(requestFixture())) {
      // Drain the stream.
    }

    expect(body).toMatchObject({ reasoning: { summary: "auto" } })
  })
})

describe("OpenAI provider error classification", () => {
  it("marks a 429 API error as retryable with its status", async () => {
    const error = new OpenAI.APIError(429, undefined, undefined, new Headers())

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "openai_error",
            message: error.message,
            details: { retryable: true, status: 429 },
          },
        },
      },
    ])
  })

  it("keeps a 400 API error free of retry details", async () => {
    const error = new OpenAI.APIError(400, undefined, undefined, new Headers())

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: { code: "openai_error", message: error.message },
        },
      },
    ])
  })

  it("marks connection errors without a status as retryable", async () => {
    const error = new OpenAI.APIConnectionError({ message: "socket hang up" })

    const events = await collectWithThrowingClient(error)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "openai_error",
            message: error.message,
            details: { retryable: true },
          },
        },
      },
    ])
  })

  it("marks a failed response with a transient code as retryable", () => {
    const response = fromOpenAIResponse(
      responseFixture({
        status: "failed",
        error: { code: "server_error", message: "upstream overloaded" },
      }),
    )

    expect(response).toEqual({
      stopReason: ModelStopReason.Error,
      content: [],
      providerRequestId: "response_1",
      error: {
        code: "server_error",
        message: "upstream overloaded",
        details: { retryable: true },
      },
    })
  })

  it("keeps a failed response with a non-transient code free of retry details", () => {
    const response = fromOpenAIResponse(
      responseFixture({
        status: "failed",
        error: { code: "invalid_prompt", message: "bad prompt" },
      }),
    )

    expect(response).toEqual({
      stopReason: ModelStopReason.Error,
      content: [],
      providerRequestId: "response_1",
      error: { code: "invalid_prompt", message: "bad prompt" },
    })
  })

  it("keeps refusals free of retry details", () => {
    const response = fromOpenAIResponse(
      responseFixture({
        output: [
          {
            type: "message",
            id: "message_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "cannot help" }],
          },
        ],
      }),
    )

    expect(response).toEqual({
      stopReason: ModelStopReason.Error,
      content: [],
      providerRequestId: "response_1",
      error: { code: "openai_refusal", message: "cannot help" },
    })
  })

  it("marks a stream error event with a transient code as retryable", async () => {
    const client = {
      responses: {
        async create() {
          return (async function* () {
            yield {
              type: "error",
              code: "server_error",
              message: "stream failed",
              param: null,
              sequence_number: 1,
            }
          })()
        },
      },
    } as unknown as OpenAI
    const stream = createOpenAIProvider({
      apiKey: "test",
      model: "gpt-test",
      client,
    })

    const events: ModelStreamEvent[] = []
    for await (const event of stream(requestFixture())) events.push(event)

    expect(events).toEqual([
      {
        type: "response",
        response: {
          stopReason: ModelStopReason.Error,
          content: [],
          error: {
            code: "server_error",
            message: "stream failed",
            details: { retryable: true },
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
    responses: {
      async create() {
        throw error
      },
    },
  } as unknown as OpenAI
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: "gpt-test",
    client,
  })

  const events: ModelStreamEvent[] = []
  for await (const event of stream(requestFixture())) events.push(event)
  return events
}

function requestFixture(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "openai",
      model: "gpt-request",
      instructionProfileId: "codex",
    },
    system: [{ id: "base", revision: "base-1", text: "Be helpful." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    toolWireProtocol: "openai_deferred",
    ...overrides,
  }
}

function responseFixture(
  overrides: {
    readonly status?: Response["status"]
    readonly output?: Response["output"]
    readonly incomplete_details?: Response["incomplete_details"]
    readonly error?: Response["error"]
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
    error: overrides.error ?? null,
  } as unknown as Response
}
