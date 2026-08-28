import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  EventType,
  HistoryRecordType,
  InputRole,
  isHistoryRecord,
  isKernelEvent,
} from "../../src/kernel/events.ts"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"

describe("kernel facts", () => {
  it("contains exactly the coarse witness vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "session.created",
      "input.admitted",
      "input.cancelled",
      "turn.started",
      "turn.completed",
      "item.started",
      "item.completed",
      "context.compacted",
    ])
    expect(Object.values(HistoryRecordType)).toEqual([
      "session.metadata",
      "turn.context",
      "history.initialized",
      "world_state",
      "provider.usage_baseline",
      "turn.aborted",
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
      version: 5,
      type: EventType.SessionCreated,
      data: { title: "Witness" },
    })
  })

  it("recognizes a persisted session configuration snapshot", () => {
    expect(
      isHistoryRecord({
        type: HistoryRecordType.SessionMetadata,
        data: {
          configuration: {
            schemaVersion: 3,
            workspaceRoot: "/workspace",
            promptCacheKey: "session-cache",
            defaultTarget: { provider: "codex", model: "gpt-5.6-sol" },
            baseInstructions: {
              text: "instructions",
              revision: "revision_1",
              provenance: {
                type: "model",
                provider: "codex",
                model: "gpt-5.6-sol",
                instructionProfileId: "codex",
              },
            },
            enabledTools: ["read_file"],
            approvalPolicy: "never",
            executionPolicyDefaults: createSessionExecutionPolicy(),
          },
        },
      }),
    ).toBe(true)
  })

  it("rejects incomplete execution-policy snapshots instead of restoring defaults", () => {
    const {
      toolCallsPerTurn: _toolCallsPerTurn,
      ...incompleteExecutionPolicy
    } = createSessionExecutionPolicy()

    expect(
      isHistoryRecord({
        type: HistoryRecordType.SessionMetadata,
        data: {
          configuration: {
            schemaVersion: 3,
            workspaceRoot: "/workspace",
            promptCacheKey: "session-cache",
            defaultTarget: { provider: "codex", model: "gpt-5.6-sol" },
            baseInstructions: {
              text: "instructions",
              revision: "revision_1",
              provenance: { type: "custom" },
            },
            enabledTools: [],
            approvalPolicy: "never",
            executionPolicyDefaults: incompleteExecutionPolicy,
          },
        },
      }),
    ).toBe(false)
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

  it("accepts Session image references and rejects inline image data", () => {
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
          sessionId: "session_00000000-0000-4000-8000-000000000000",
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
          sessionId: "session_00000000-0000-4000-8000-000000000000",
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
        name: "invalid.png",
        mediaType: "image/png",
        sizeBytes: 5,
        data: "aGVsbG8=",
        file: { sessionId: "session_bad", path: "image.png" },
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

  it("recognizes a strict turn.context history record", () => {
    const record = {
      type: HistoryRecordType.TurnContext,
      data: {
        turnId: "turn_1",
        context: {
          mateId: "mate_1",
          mateRevisionId: "revision_1",
          provider: "openai",
          model: "gpt-5.1-codex",
          instructionProfileId: "codex",
          baseInstructionsRevision: "base@1",
          modelInstructionsRevision: "gpt@1",
          workingDirectory: "/p/a",
          enabledTools: [],
          approvalPolicy: "on-request",
          executionPolicy: {
            modelCallsPerTurn: 1,
            toolCallsPerTurn: 1,
            modelVisibleMessageBlocks: 1,
            modelVisibleContextBytes: 100,
            compactionTriggerContextBytes: 80,
            compactionRetainContextBytes: 16,
            modelVisibleToolResultBytes: 1,
            modelVisibleToolResultLines: 1,
            assistantResponseBytes: 1,
          },
        },
      },
    }
    expect(isHistoryRecord(record)).toBe(true)
    expect(isKernelEvent(record)).toBe(false)
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

  it("recognizes a valid context.compacted fact", () => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_1",
          throughSeq: 7,
          coveredTurnIds: ["turn_0"],
          summary: "Goal: ship it.",
          usage: { inputTokens: 10, outputTokens: 5 },
          replacement: {
            windowId: "context_window_2",
            firstWindowId: "context_window_1",
            previousWindowId: "context_window_1",
            windowNumber: 2,
            history: [
              {
                role: "developer",
                content: [{ type: "text", text: "current state" }],
                context: {
                  type: "world_state",
                  sectionId: "environment",
                  revision: "revision_1",
                },
              },
              {
                role: "user",
                content: [{ type: "text", text: "Goal: ship it." }],
              },
            ],
            worldStateBaseline: { environment: { cwd: "/workspace" } },
          },
        },
      }),
    ).toBe(true)
  })

  it("recognizes a durable inherited context window", () => {
    expect(
      isHistoryRecord({
        type: HistoryRecordType.InitialContext,
        data: {
          windowId: "context_window_1",
          sourceSessionId: "session_parent",
          history: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "call_1",
                  name: "read_file",
                  input: { path: "README.md" },
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "call_1",
              content: "hello",
            },
          ],
          worldStateBaseline: { environment: { cwd: "/workspace" } },
        },
      }),
    ).toBe(true)
  })

  it("rejects inline images in a durable inherited context window", () => {
    expect(
      isHistoryRecord({
        type: HistoryRecordType.InitialContext,
        data: {
          windowId: "context_window_1",
          sourceSessionId: "session_parent",
          history: [
            {
              role: "user",
              content: [{ type: "text", text: "inspect" }],
              images: [
                {
                  type: "image",
                  mediaType: "image/png",
                  data: "aGVsbG8=",
                },
              ],
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it("recognizes a strict world_state history record", () => {
    const event = {
      type: HistoryRecordType.WorldState,
      data: {
        turnId: "turn_1",
        afterItemId: "item_1",
        full: false,
        state: { "project.instructions": null },
        fragments: [
          {
            id: "project.instructions",
            revision: "revision_removed",
            role: "user",
            text: "instructions removed",
          },
        ],
      },
    }

    expect(isHistoryRecord(event)).toBe(true)
    expect(
      isHistoryRecord({
        ...event,
        data: { ...event.data, fragments: [] },
      }),
    ).toBe(true)
    expect(
      isHistoryRecord({
        ...event,
        data: {
          ...event.data,
          fragments: [{ ...event.data.fragments[0], role: "system" }],
        },
      }),
    ).toBe(false)
  })

  it.each([
    {
      name: "an extra key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
        replacement: testCompactionReplacement(),
        model: "faux-1",
      },
    },
    {
      name: "a missing key",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
        replacement: testCompactionReplacement(),
      },
    },
    {
      name: "throughSeq of zero",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 0,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
        replacement: testCompactionReplacement(),
      },
    },
    {
      name: "a non-string covered turn id",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0", 42],
        summary: "Goal: ship it.",
        replacement: testCompactionReplacement(),
      },
    },
    {
      name: "a missing replacement",
      data: {
        compactionId: "compaction_1",
        turnId: "turn_1",
        throughSeq: 7,
        coveredTurnIds: ["turn_0"],
        summary: "Goal: ship it.",
      },
    },
  ])("rejects context.compacted with $name", ({ data }) => {
    expect(
      isKernelEvent({
        type: EventType.ContextCompacted,
        data,
      }),
    ).toBe(false)
  })
})

function testCompactionReplacement() {
  return {
    windowId: "context_window_2",
    firstWindowId: "context_window_1",
    previousWindowId: "context_window_1",
    windowNumber: 2,
    history: [],
    worldStateBaseline: {},
  }
}
