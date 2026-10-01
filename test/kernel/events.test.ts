import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  EventType,
  InputRole,
  isKernelEvent,
  isModelMessage,
} from "../../src/kernel/events.ts"

describe("kernel facts", () => {
  it("contains exactly the coarse witness vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "session.created",
      "input.admitted",
      "turn.started",
      "turn.completed",
      "item.started",
      "item.completed",
    ])
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
            content: { kind: "text", text: "hello" },
            extra: true,
          },
        } as never,
      }),
    ).toThrow("Invalid event data")
  })

  it("enforces the durable custom-tool fallback invariant", () => {
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
    ).toBe(false)
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
        content: "search result",
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
    ).toBe(false)
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
        content: "search result",
        toolSearch: { tools: [customDefinition], extra: true },
      }),
    ).toBe(false)
  })

  it("accepts rollout image references and rejects inline image data", () => {
    const event = (attachment: unknown) =>
      isKernelEvent({
        type: EventType.InputAdmitted,
        data: {
          requestId: "request-1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "image", attachments: [attachment] },
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
          content: { kind: "text", text: "hello" },
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
