import { describe, expect, expectTypeOf, it } from "vitest"
import {
  createEventEnvelope,
  EventType,
  InputRole,
  isKernelEvent,
  isModelMessage,
  isTurnCompletion,
  isTurnMetrics,
} from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"

describe("kernel facts", () => {
  it("preserves optional JSON provider metadata on canonical text blocks", () => {
    for (const role of ["assistant", "user", "developer"]) {
      expect(
        isModelMessage({
          role,
          content: [
            {
              type: "text",
              text: "",
              providerMetadata: {
                gemini: { part: { text: "", thoughtSignature: "opaque" } },
              },
            },
          ],
        }),
      ).toBe(true)
      expect(
        isModelMessage({
          role,
          content: [{ type: "text", text: "", providerMetadata: "invalid" }],
        }),
      ).toBe(false)
    }
  })

  it("round-trips bounded latency measurements without treating missing samples as zero", () => {
    const metrics = {
      modelCalls: 1,
      toolCalls: 0,
      modelDurationMs: 25,
      toolDurationMs: 0,
      latency: {
        setupMs: 10,
        firstRequestMs: 20,
        firstUsefulOutputMs: 30,
        backgroundCompactionMs: 15,
        backgroundCompactionOverlapMs: 10,
        backgroundCompactionsApplied: 1,
        backgroundCompactionsDiscarded: 0,
      },
    }
    expect(isTurnMetrics(JSON.parse(JSON.stringify(metrics)))).toBe(true)
    expect(
      isTurnMetrics({
        ...metrics,
        latency: { ...metrics.latency, firstToolMs: -1 },
      }),
    ).toBe(false)
    expect(
      isTurnMetrics({ ...metrics, latency: { ...metrics.latency, extra: 1 } }),
    ).toBe(false)
    expect(
      isTurnMetrics({
        ...metrics,
        latency: { ...metrics.latency, backgroundCompactionsDiscarded: 0.5 },
      }),
    ).toBe(false)
  })

  it("validates goal identity on persisted model context", () => {
    for (const goalId of ["goal_continue", "", "../goal", 1]) {
      expect(
        isModelMessage({
          role: "developer",
          content: [{ type: "text", text: "Continue the goal" }],
          context: { type: "goal", goalId },
        }),
      ).toBe(goalId === "goal_continue")
    }
    expect(
      isModelMessage({
        role: "developer",
        content: [],
        context: {
          type: "goal",
          goalId: "goal_continue",
          objective: "unexpected",
        },
      }),
    ).toBe(false)
  })

  it("contains exactly the coarse witness vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "session.created",
      "input.admitted",
      "turn.started",
      "turn.completed",
      "item.started",
      "item.completed",
      "context.tokens",
    ])
  })

  it("validates context token snapshots as kernel facts", () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000000"
    const envelope = createEventEnvelope({
      sessionId,
      seq: 1,
      event: {
        type: EventType.ContextTokens,
        data: {
          turnId: "turn_1",
          activeContextTokens: 40_000,
          capacityTokens: 200_000,
          provider: "kimi",
          model: "k3",
        },
      },
    })
    expect(envelope.type).toBe(EventType.ContextTokens)
    expect(isKernelEvent(envelope)).toBe(true)

    expect(() =>
      createEventEnvelope({
        sessionId,
        seq: 2,
        event: {
          type: EventType.ContextTokens,
          data: { turnId: "turn_1", activeContextTokens: -1 },
        },
      }),
    ).toThrow("Invalid event data")
    expect(() =>
      createEventEnvelope({
        sessionId,
        seq: 3,
        event: {
          type: EventType.ContextTokens,
          data: {
            turnId: "turn_1",
            activeContextTokens: 40_000,
            capacityTokens: 1.5,
          },
        },
      }),
    ).toThrow("Invalid event data")
  })

  it("creates a versioned envelope for a valid fact", () => {
    const envelope = createEventEnvelope({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      event: { type: EventType.SessionCreated, data: { title: "Witness" } },
    })

    expect(envelope).toMatchObject({
      sessionId: "session_00000000-0000-4000-8000-000000000000",
      seq: 1,
      version: 7,
      type: EventType.SessionCreated,
      data: { title: "Witness" },
    })
  })

  it("assigns fresh envelope identity when wrapping an already enveloped fact", () => {
    const previous = createEventEnvelope({
      sessionId: "session_previous",
      seq: 4,
      id: "event_previous",
      createdAt: "2026-01-01T00:00:00.000Z",
      event: { type: EventType.SessionCreated, data: { title: "Witness" } },
    })
    const envelope = createEventEnvelope({
      sessionId: "session_current",
      seq: 1,
      id: "event_current",
      createdAt: "2026-02-01T00:00:00.000Z",
      event: { ...previous, version: 1 },
    })
    expect(envelope).toEqual({
      sessionId: "session_current",
      seq: 1,
      id: "event_current",
      createdAt: "2026-02-01T00:00:00.000Z",
      version: 7,
      type: EventType.SessionCreated,
      data: { title: "Witness" },
    })
    expectTypeOf(envelope.version).toEqualTypeOf<number>()
    expect(isKernelEvent(previous)).toBe(true)
  })

  it("strictly rejects malformed known facts at write time", () => {
    expect(() =>
      createEventEnvelope({
        sessionId: "session_00000000-0000-4000-8000-000000000000",
        seq: 1,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request-1",
            inputId: "input_1",
            role: InputRole.User,
            content: inputFixture([{ type: "text" as const, text: "hello" }]),
            extra: true,
          },
        } as never,
      }),
    ).toThrow("Invalid event data")
  })

  it("validates completed response reasons and unique answer item IDs", () => {
    for (const reason of ["truncated", "refused"] as const) {
      expect(
        isTurnCompletion({ reason, answerItemIds: ["piece_one", "piece_two"] }),
      ).toBe(true)
      expect(
        isKernelEvent(
          createEventEnvelope({
            sessionId: "session_00000000-0000-4000-8000-000000000000",
            seq: 1,
            event: {
              type: EventType.TurnCompleted,
              data: {
                turnId: "turn_chain",
                outcome: {
                  status: "completed",
                  reason,
                  answerItemIds: ["piece_one", "piece_two"],
                },
              },
            },
          }),
        ),
      ).toBe(true)
    }
    expect(isTurnCompletion({ answerItemIds: [] })).toBe(true)
    for (const invalid of [
      { reason: "length" },
      { answerItemIds: ["duplicate", "duplicate"] },
      { answerItemIds: [""] },
      { answerItemIds: [1] },
      { extra: true },
    ])
      expect(isTurnCompletion(invalid)).toBe(false)
  })

  it("validates native custom tools and optional JSON fallbacks", () => {
    const assistantMessage = (block: unknown) =>
      isModelMessage({ role: "assistant", content: [block] })

    expect(
      assistantMessage({
        type: "tool_call",
        id: "custom_1",
        name: "evaluate",
        input: "1 + 1",
        toolKind: "custom",
        customInputFallbackKey: "code",
      }),
    ).toBe(true)
    expect(
      assistantMessage({
        type: "tool_call",
        id: "custom_1",
        name: "evaluate",
        input: "1 + 1",
        toolKind: "custom",
      }),
    ).toBe(true)
    expect(
      assistantMessage({
        type: "tool_call",
        id: "function_1",
        name: "evaluate",
        input: {},
        customInputFallbackKey: "code",
      }),
    ).toBe(false)
  })

  it("validates structural deferred-tool discovery results", () => {
    const message = (definition: unknown) =>
      isModelMessage({
        role: "tool",
        toolCallId: "search_1",
        content: [{ type: "text", text: "search result" }],
        toolSearch: { tools: [definition] },
      })
    const customDefinition = {
      name: "demo__evaluate",
      description: "Evaluate an expression",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      kind: "custom",
      inputFormat: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
      customInputFallbackKey: "code",
      deferLoading: true,
    }

    expect(message(customDefinition)).toBe(true)
    expect(
      message({
        ...customDefinition,
        customInputFallbackKey: undefined,
      }),
    ).toBe(true)
    expect(
      message({
        ...customDefinition,
        kind: "function",
        inputFormat: customDefinition.inputFormat,
      }),
    ).toBe(false)
    expect(
      isModelMessage({
        role: "tool",
        toolCallId: "search_1",
        content: [{ type: "text", text: "search result" }],
        toolSearch: { tools: [customDefinition], extra: true },
      }),
    ).toBe(false)
  })

  it("accepts rollout image references and rejects inline image data", () => {
    const event = (attachment: Record<string, unknown>) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: inputFixture([
            { type: "text" as const, text: "image" },
            { type: "image" as const, ...attachment },
          ]),
        },
      })

    expect(
      event({
        name: "screen.png",
        mediaType: "image/png",
        detail: "original",
        sizeBytes: 5,
        file: {
          rolloutId: "session_00000000-0000-4000-8000-000000000000",
          path: "attachments/requests/request-1/1.png",
        },
      }),
    ).toBe(true)
    expect(
      event({
        name: "screen.png",
        mediaType: "image/png",
        detail: "auto",
        sizeBytes: 5,
        file: {
          rolloutId: "session_00000000-0000-4000-8000-000000000000",
          path: "attachments/requests/request-1/1.png",
        },
      }),
    ).toBe(false)
    expect(
      event({
        name: "inline.png",
        mediaType: "image/png",
        sizeBytes: 5,
        data: "aGVsbG8=",
      }),
    ).toBe(false)
    expect(
      event({
        name: "unsafe.png",
        mediaType: "image/png",
        sizeBytes: 5,
        file: {
          rolloutId: "../escape",
          path: "attachments/requests/request-1/1.png",
        },
      }),
    ).toBe(false)
    expect(
      event({
        name: "invalid.png",
        mediaType: "image/png",
        sizeBytes: 5,
        data: "aGVsbG8=",
        file: { rolloutId: "session_bad", path: "image.png" },
      }),
    ).toBe(false)
  })

  it("accepts modelSelection with effort/speed and rejects malformed ones", () => {
    const admitted = (modelSelection: unknown) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: inputFixture([{ type: "text" as const, text: "hello" }]),
          modelSelection,
        },
      })

    expect(admitted({ provider: "openai", model: "gpt-5.1-codex" })).toBe(true)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: "high" }),
    ).toBe(true)
    expect(
      admitted({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        speed: "fast",
      }),
    ).toBe(true)
    expect(admitted({ provider: "openai", model: "" })).toBe(false)
    expect(admitted({ provider: "", model: "gpt-5.1-codex" })).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: "" }),
    ).toBe(false)
    expect(
      admitted({ provider: "codex", model: "gpt-5.6-sol", speed: "" }),
    ).toBe(false)
    expect(
      admitted({ provider: "codex", model: "gpt-5.6-sol", speed: 2 }),
    ).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", effort: 3 }),
    ).toBe(false)
    expect(
      admitted({ provider: "openai", model: "gpt-5.1-codex", extra: true }),
    ).toBe(false)
  })

  it("recognizes valid tool facts", () => {
    expect(
      isKernelEvent({
        type: EventType.ItemStarted,
        data: {
          turnId: "turn_1",
          item: {
            type: "file_read",
            toolCallId: "tool_1",
            itemId: "item_1",
            name: "read_file",
            input: { path: "README.md" },
            requiresPermission: false,
            path: "README.md",
          },
        },
      }),
    ).toBe(true)

    expect(
      isKernelEvent({
        type: EventType.ItemStarted,
        data: {
          turnId: "turn_1",
          item: {
            type: "mcp_tool_call",
            toolCallId: "tool_2",
            itemId: "item_2",
            name: "mcp__filesystem__read_file",
            input: { path: "/tmp/result.txt" },
            requiresPermission: false,
            server: "filesystem",
            tool: "read_file",
            arguments: { path: "/tmp/result.txt" },
            readOnlyHint: true,
          },
        },
      }),
    ).toBe(true)

    expect(
      isKernelEvent({
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "file_change",
            toolCallId: "tool_3",
            itemId: "item_3",
            name: "edit_file",
            input: { path: "src/index.ts" },
            requiresPermission: false,
            request: { operation: "edit", paths: ["src/index.ts"] },
            changes: [
              {
                path: "src/index.ts",
                kind: "update",
                diff: {
                  format: "unified",
                  text: "--- a/src/index.ts\n+++ b/src/index.ts",
                  truncated: false,
                },
              },
            ],
            resultItemId: "item_result_3",
            content: { kind: "text", text: "Updated src/index.ts." },
          },
        },
      }),
    ).toBe(true)
  })

  it("rejects model output as a durable item start while accepting its completion", () => {
    for (const item of [
      {
        type: "agent_message",
        itemId: "answer",
        content: [{ type: "text", text: "answer" }],
      },
      { type: "reasoning", itemId: "reasoning", text: "reasoning" },
    ]) {
      expect(
        isKernelEvent({
          type: EventType.ItemStarted,
          data: { turnId: "turn_output", item },
        }),
      ).toBe(false)
      expect(
        isKernelEvent({
          type: EventType.ItemCompleted,
          data: { turnId: "turn_output", item },
        }),
      ).toBe(true)
    }
  })

  it("rejects ambiguous file changes and malformed MCP results", () => {
    const completedFileChange = (change: unknown) =>
      isKernelEvent({
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "file_change",
            toolCallId: "tool_1",
            itemId: "item_1",
            name: "edit_file",
            input: { path: "a.ts" },
            requiresPermission: false,
            request: { operation: "edit", paths: ["a.ts"] },
            changes: [change],
            resultItemId: "item_result_1",
            content: { kind: "text", text: "changed" },
          },
        },
      })

    expect(completedFileChange({ path: "a.ts", kind: "move" })).toBe(false)
    expect(
      completedFileChange({
        path: "a.ts",
        kind: "add",
        movePath: "b.ts",
      }),
    ).toBe(false)
    expect(
      completedFileChange({
        path: "a.ts",
        kind: "update",
        movePath: "b.ts",
      }),
    ).toBe(true)

    expect(
      isKernelEvent({
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "mcp_tool_call",
            toolCallId: "tool_2",
            itemId: "item_2",
            name: "mcp__filesystem__read_file",
            input: { path: "a.ts" },
            requiresPermission: false,
            server: "filesystem",
            tool: "read_file",
            arguments: { path: "different.ts" },
            result: { arbitrary: true },
            resultItemId: "item_result_2",
            content: { kind: "text", text: "done" },
          },
        },
      }),
    ).toBe(false)

    expect(
      isKernelEvent({
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "mcp_tool_call",
            toolCallId: "tool_2",
            itemId: "item_2",
            name: "mcp__filesystem__read_file",
            input: { path: "a.ts" },
            requiresPermission: false,
            server: "filesystem",
            tool: "read_file",
            arguments: { path: "a.ts" },
            result: {
              content: [{ type: "text", text: "contents" }],
              structuredContent: { path: "a.ts" },
              isError: false,
            },
            resultItemId: "item_result_2",
            content: { kind: "text", text: "done" },
          },
        },
      }),
    ).toBe(true)
  })
})
