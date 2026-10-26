import { describe, expect, it, vi } from "vitest"
import { toGeminiInteractionInput } from "../../src/runtime/gemini-interactions-input.ts"
import { createGeminiInteractionsProvider } from "../../src/runtime/gemini-interactions-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const created = {
  event_type: "interaction.created",
  interaction: { id: "interaction-1", status: "in_progress" },
}
const call = {
  type: "function_call",
  id: "call-1",
  name: "inspect",
  arguments: { path: "a" },
}
const callEvents = closedStep(call)
const usage = {
  total_input_tokens: 12,
  total_output_tokens: 5,
  total_thought_tokens: 3,
  total_tokens: 20,
  total_cached_tokens: 4,
}

describe("Gemini Interactions wire boundary", () => {
  it("sends stateless native controls and ordered multimodal input with header authentication", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      sse([created, complete("completed")]),
    )
    const stream = createGeminiInteractionsProvider({
      apiKey: "test-key",
      baseURL: "https://example.test/v1/",
      model: "fallback",
      fetchFn,
    })
    const events = await collect(
      stream(
        request({
          target: {
            provider: "gemini",
            model: "models/gemini-test",
            instructionProfileId: "test",
            effort: "high",
          },
          maxOutputTokens: 123,
          toolChoice: { name: "inspect" },
          outputFormat: {
            type: "json_schema",
            name: "result",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
          providerOptions: {
            provider: "gemini",
            wireApi: "gemini_interactions",
            body: {
              generation_config: {
                thinking_summaries: "none",
                temperature: 0.2,
              },
            },
          },
          messages: [
            {
              role: "developer",
              content: [{ type: "text", text: "Check carefully" }],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Look" },
                { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
                {
                  type: "document",
                  name: "report.pdf",
                  mediaType: "application/pdf",
                  sizeBytes: 6,
                  file: { rolloutId: "rollout", path: "report.pdf" },
                  data: "JVBERi0x",
                },
              ],
            },
          ],
        }),
      ),
    )
    expect(events.at(-1)?.type).toBe("response")
    const [url, options] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe("https://example.test/v1/interactions")
    expect(options?.headers).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "test-key",
    })
    expect(options?.redirect).toBe("error")
    expect(JSON.parse(String(options?.body))).toEqual({
      model: "gemini-test",
      system_instruction: "System",
      stream: true,
      store: false,
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: "[Developer instruction]" },
            { type: "text", text: "Check carefully" },
          ],
        },
        {
          type: "user_input",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
            {
              type: "document",
              mime_type: "application/pdf",
              data: "JVBERi0x",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "inspect",
          description: "Inspect",
          parameters: { type: "object" },
        },
      ],
      generation_config: {
        thinking_level: "high",
        thinking_summaries: "none",
        temperature: 0.2,
        max_output_tokens: 123,
        tool_choice: { allowed_tools: { mode: "any", tools: ["inspect"] } },
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    })
  })

  it("preserves signed custom calls and ordered tool images while fencing native replay by owner", async () => {
    const thought = {
      type: "thought",
      summary: [{ type: "text", text: "Plan" }],
      signature: "opaque-signature",
    }
    const customCall = {
      type: "function_call",
      id: "custom-1",
      name: "edit",
      arguments: { patch: "*** patch ***" },
    }
    const stream = provider([
      created,
      ...closedStep(thought),
      ...closedStep(customCall, 1),
      complete("requires_action"),
    ])
    const events = await collect(
      stream(
        request({
          tools: [
            {
              kind: "custom",
              name: "edit",
              description: "Edit",
              inputSchema: { type: "object" },
              customInputFallbackKey: "patch",
            },
          ],
        }),
      ),
    )
    const result = terminal(events)
    expect(result.content).toEqual([
      { type: "reasoning", text: "Plan", representation: "summary" },
      {
        type: "tool_call",
        id: "custom-1",
        name: "edit",
        input: "*** patch ***",
        toolKind: "custom",
        customInputFallbackKey: "patch",
      },
    ])
    const messages: ModelRequest["messages"] = [
      {
        role: "assistant",
        content: result.content,
        native: result.native ?? [],
      },
      {
        role: "tool",
        toolCallId: "custom-1",
        content: [
          { type: "text", text: "Failed" },
          { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
        ],
        isError: true,
      },
    ]
    expect(
      toGeminiInteractionInput(messages, "gemini", "scope", "gemini-test"),
    ).toEqual([
      thought,
      customCall,
      {
        type: "function_result",
        call_id: "custom-1",
        name: "edit",
        is_error: true,
        result: [
          { type: "text", text: "Failed" },
          { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
        ],
      },
    ])
    for (const [owner, scope, model] of [
      ["other", "scope", "gemini-test"],
      ["gemini", "other", "gemini-test"],
      ["gemini", "scope", "other"],
    ]) {
      const input = toGeminiInteractionInput(
        messages,
        owner ?? "",
        scope,
        model ?? "",
      )
      expect(input).toHaveLength(2)
      expect(input[0]).toEqual(customCall)
      expect(JSON.stringify(input)).not.toContain("opaque-signature")
    }
  })

  it.each([
    {
      name: "closed call without terminal event",
      tail: [],
      kind: "stream_disconnected",
    },
    {
      name: "terminal status without completion",
      tail: [
        {
          event_type: "interaction.status_update",
          interaction_id: "interaction-1",
          status: "requires_action",
        },
      ],
      kind: "stream_disconnected",
    },
    {
      name: "premature done sentinel",
      tail: ["[DONE]"],
      kind: "stream_disconnected",
    },
    {
      name: "provider failure",
      tail: [complete("failed")],
      kind: "provider_error",
    },
    {
      name: "provider cancellation",
      tail: [complete("cancelled")],
      kind: "provider_error",
    },
    {
      name: "late step after completion",
      tail: [complete("requires_action"), ...closedStep(call, 1)],
      kind: "protocol_error",
    },
    {
      name: "duplicate call IDs",
      tail: [...closedStep(call, 1), complete("requires_action")],
      kind: "protocol_error",
    },
    {
      name: "changed terminal status",
      tail: [
        {
          event_type: "interaction.status_update",
          interaction_id: "interaction-1",
          status: "requires_action",
        },
        complete("completed"),
      ],
      kind: "protocol_error",
    },
    {
      name: "data after done sentinel",
      tail: [complete("requires_action"), "[DONE]", created],
      kind: "protocol_error",
    },
  ])("does not commit a tool batch after $name", async ({ tail, kind }) => {
    const events = await collect(
      provider([created, ...callEvents, ...tail])(request()),
    )
    expect(
      events.filter(
        (event) => event.type === "output_item" || event.type === "response",
      ),
    ).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: "failure", failure: { kind } })
  })

  it.each([
    {
      name: "unclosed parallel call",
      events: [
        ...callEvents,
        { event_type: "step.start", index: 1, step: { ...call, id: "call-2" } },
      ],
      status: "requires_action",
      kind: "stream_disconnected",
    },
    {
      name: "malformed argument JSON",
      events: [
        {
          event_type: "step.start",
          index: 0,
          step: { ...call, arguments: {} },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "arguments_delta", arguments: "{" },
        },
        { event_type: "step.stop", index: 0 },
      ],
      status: "requires_action",
      kind: "protocol_error",
    },
    {
      name: "non-object arguments",
      events: closedStep({ ...call, arguments: "wrong" }),
      status: "requires_action",
      kind: "protocol_error",
    },
    {
      name: "unsupported generated media",
      events: closedStep({
        type: "model_output",
        content: [{ type: "image", data: "image" }],
      }),
      status: "completed",
      kind: "protocol_error",
    },
  ])("rejects $name without durable output", async ({
    events: parts,
    status,
    kind,
  }) => {
    const events = await collect(
      provider([created, ...parts, complete(status)])(request()),
    )
    expect(
      events.filter(
        (event) => event.type === "output_item" || event.type === "response",
      ),
    ).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: "failure", failure: { kind } })
  })

  it("requires valid SSE framing after completion before committing a closed call", async () => {
    const stream = createGeminiInteractionsProvider({
      apiKey: "",
      model: "gemini-test",
      baseURL: "https://example.test/v1",
      fetchFn: async () =>
        sse(
          [created, ...callEvents, complete("requires_action")],
          'data: {"unfinished":',
        ),
    })
    const events = await collect(stream(request()))
    expect(
      events.filter(
        (event) => event.type === "output_item" || event.type === "response",
      ),
    ).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "stream_disconnected" },
    })
  })

  it("keeps partial text but excludes every tool call from an incomplete response and native replay", async () => {
    const events = await collect(
      provider([
        created,
        ...callEvents,
        { event_type: "step.start", index: 1, step: { type: "model_output" } },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text", text: "Partial" },
        },
        {
          event_type: "step.start",
          index: 2,
          step: { type: "thought", signature: "unclosed-signature" },
        },
        complete("incomplete"),
      ])(request()),
    )
    const result = terminal(events)
    expect(result).toMatchObject({
      stopReason: "length",
      lengthReason: "output",
      incompleteToolCalls: true,
      content: [{ type: "text", text: "Partial" }],
    })
    expect(
      toGeminiInteractionInput(
        [
          {
            role: "assistant",
            content: result.content,
            native: result.native ?? [],
          },
        ],
        "gemini",
        "scope",
        "gemini-test",
      ),
    ).toEqual([
      { type: "model_output", content: [{ type: "text", text: "Partial" }] },
    ])
  })

  it("accounts for terminal usage before cancellation and never commits pending calls", async () => {
    const controller = new AbortController()
    const snapshots: unknown[] = []
    const events = await collect(
      provider([
        created,
        ...callEvents,
        complete("requires_action", { usage }),
      ])(
        request({
          signal: controller.signal,
          onUsageSnapshot(value) {
            snapshots.push(value)
            controller.abort()
          },
        }),
      ),
    )
    const expected = {
      inputTokens: 12,
      outputTokens: 8,
      activeContextTokens: 20,
      cacheReadInputTokens: 4,
    }
    expect(snapshots).toEqual([expected])
    expect(events).toEqual([{ type: "cancelled", usage: expected }])
  })

  it("retains unsigned summaries and text annotations exactly in native history", async () => {
    const annotation = {
      type: "url_citation",
      url: "https://example.test/source",
      title: "Source",
      start_index: 0,
      end_index: 5,
    }
    const events = await collect(
      provider([
        created,
        ...closedStep({
          type: "thought",
          summary: [{ type: "text", text: "Plan" }],
        }),
        { event_type: "step.start", index: 1, step: { type: "model_output" } },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text", text: "Hello" },
        },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text_annotation_delta", annotations: [annotation] },
        },
        { event_type: "step.stop", index: 1 },
        complete("completed", { usage }),
        "[DONE]",
      ])(request()),
    )
    const result = terminal(events)
    expect(events.filter((event) => event.type === "delta")).toMatchObject([
      { text: "Hello", partIndex: 0 },
    ])
    expect(result).toMatchObject({
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        activeContextTokens: 20,
        cacheReadInputTokens: 4,
      },
    })
    expect(
      toGeminiInteractionInput(
        [
          {
            role: "assistant",
            content: result.content,
            native: result.native ?? [],
          },
        ],
        "gemini",
        "scope",
        "gemini-test",
      ),
    ).toEqual([
      { type: "thought", summary: [{ type: "text", text: "Plan" }] },
      {
        type: "model_output",
        content: [{ type: "text", text: "Hello", annotations: [annotation] }],
      },
    ])
  })

  it("rejects disagreement between streamed calls and the completed interaction", async () => {
    const events = await collect(
      provider([
        created,
        ...callEvents,
        complete("requires_action", {
          steps: [{ ...call, arguments: { path: "different" } }],
        }),
      ])(request()),
    )
    expect(events).toMatchObject([
      { type: "failure", failure: { kind: "protocol_error" } },
    ])
  })

  it("reports HTTP retry metadata and provider error events without committing output", async () => {
    const stream = createGeminiInteractionsProvider({
      apiKey: "",
      model: "gemini-test",
      baseURL: "https://example.test/v1",
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: "Too busy" } }), {
          status: 429,
          headers: { "retry-after": "2", "x-request-id": "request-1" },
        }),
    })
    expect(await collect(stream(request()))).toMatchObject([
      {
        type: "failure",
        failure: {
          kind: "rate_limited",
          status: 429,
          retryAfterMs: 2000,
          providerRequestId: "request-1",
          details: { providerMessage: "Too busy" },
        },
      },
    ])
    expect(
      await collect(
        provider([
          created,
          ...callEvents,
          {
            event_type: "error",
            error: { code: "https://errors.test/quota", message: "Quota" },
          },
        ])(request()),
      ),
    ).toMatchObject([
      {
        type: "failure",
        failure: {
          kind: "provider_error",
          providerCode: "https://errors.test/quota",
          details: { providerMessage: "Quota" },
          providerResponseId: "interaction-1",
        },
      },
    ])
  })

  it.each([
    { parallelToolCalls: false },
    { compaction: "responses_compact" as const },
    ...[
      { previous_interaction_id: "server-history" },
      { background: true },
      { response_format: { type: "text", mime_type: "text/plain" } },
      { generation_config: { thinking_level: "low" } },
      { generation_config: { max_output_tokens: 1 } },
      { generation_config: { tool_choice: "none" } },
      { tools: [{ type: "function", name: "unplanned" }] },
    ].map((body) => ({
      providerOptions: {
        provider: "gemini",
        wireApi: "gemini_interactions" as const,
        body,
      },
    })),
  ])("rejects controls that bypass captured execution ownership before transport", async (controls) => {
    const fetchFn = vi.fn<typeof fetch>()
    const stream = createGeminiInteractionsProvider({
      apiKey: "",
      model: "gemini-test",
      baseURL: "https://example.test/v1",
      fetchFn,
    })
    expect(await collect(stream(request(controls)))).toMatchObject([
      {
        type: "failure",
        failure: { kind: "invalid_request", stage: "request_build" },
      },
    ])
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    target: {
      provider: "gemini",
      model: "gemini-test",
      instructionProfileId: "test",
    },
    continuationScope: "scope",
    system: [{ id: "system", revision: "1", text: "System" }],
    messages: [],
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
    toolWireProtocol: "eager",
    streamOutputItems: true,
    ...overrides,
  }
}

function provider(events: unknown[]) {
  return createGeminiInteractionsProvider({
    apiKey: "",
    model: "gemini-test",
    baseURL: "https://example.test/v1",
    fetchFn: async () => sse(events),
  })
}

function sse(events: unknown[], tail = "") {
  return new Response(
    events
      .map(
        (event) =>
          `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`,
      )
      .join("") + tail,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function closedStep(step: unknown, index = 0) {
  return [
    { event_type: "step.start", index, step },
    { event_type: "step.stop", index },
  ]
}

function complete(status: string, fields: Record<string, unknown> = {}) {
  return {
    event_type: "interaction.completed",
    interaction: { id: "interaction-1", status, ...fields },
  }
}

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function terminal(events: ModelStreamEvent[]) {
  const last = events.at(-1)
  if (last?.type !== "response")
    throw new Error(`Missing response: ${JSON.stringify(last)}`)
  return last.response
}
