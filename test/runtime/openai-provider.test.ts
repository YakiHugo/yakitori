import OpenAI from "openai"
import type { Response } from "openai/resources/responses/responses"
import { describe, expect, it } from "vitest"
import {
  createOpenAIProvider,
  fromOpenAIResponse,
  ModelStopReason,
  toOpenAIInput,
  toOpenAITools,
  type ModelRequest,
  type ModelStreamEvent,
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
            id: "reasoning_1",
            encryptedContent: "encrypted_1",
            status: "completed",
          },
        },
      },
      { type: "text", text: "Done." },
    ])
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
      parallel_tool_calls: false,
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
          promptId: "gpt",
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
          promptId: "gpt",
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
            promptId: "gpt",
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
      promptId: "gpt",
    },
    system: [{ id: "base", revision: "base-1", text: "Be helpful." }],
    contextual: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
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
