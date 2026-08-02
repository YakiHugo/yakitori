import { describe, expect, it } from "vitest"
import { createEventEnvelope, EventType, InputRole } from "../../src/index.ts"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000000"

describe("execution view", () => {
  it("replaces a transient snapshot with an assistant.message fact", () => {
    let state = createExecutionViewState()
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "assistant.snapshot",
        sessionId,
        turnId: "turn_1",
        streamId: "stream_1",
        text: "Hel",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    })
    state = reduceExecutionView(state, {
      type: "durable",
      event: createEventEnvelope({
        sessionId,
        seq: 1,
        event: {
          type: EventType.AssistantMessage,
          data: {
            messageId: "item_1",
            turnId: "turn_1",
            content: [{ type: "text", text: "Hello" }],
            providerMetadata: { streamId: "stream_1" },
          },
        },
      }),
    })

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        itemId: "item_1",
        text: "Hello",
        status: "completed",
      }),
    ])
  })

  it("projects coarse input, tool, result, and permission facts", () => {
    const facts = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "run" },
        },
      },
      {
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "pwd" },
          requiresPermission: true,
        },
      },
      {
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "run_command",
        },
      },
      {
        type: EventType.PermissionResolved,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          behavior: "allow" as const,
        },
      },
      {
        type: EventType.ToolResult,
        data: {
          toolResultId: "item_result",
          toolCallId: "tool_1",
          turnId: "turn_1",
          content: { kind: "text" as const, text: "/workspace" },
        },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createEventEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({ kind: "user_input", text: "run" }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        state: "completed",
        resultText: "/workspace",
      }),
      expect.objectContaining({
        kind: "permission",
        permissionRequestId: "permission_1",
        state: "resolved",
        behavior: "allow",
      }),
    ])
  })

  it("renders interruption separately from failure", () => {
    const facts = [
      {
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call",
          turnId: "turn_1",
          name: "run_command",
          input: { command: "sleep 30" },
          requiresPermission: true,
        },
      },
      {
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "run_command",
        },
      },
      {
        type: EventType.TurnInterrupted,
        data: { turnId: "turn_1", reason: "runtime restart" },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createEventEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )
    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        state: "interrupted",
        resultText:
          "Interrupted before a result was recorded. Side effects may be unknown.",
      }),
      expect.objectContaining({
        kind: "permission",
        permissionRequestId: "permission_1",
        state: "stale",
      }),
      {
        kind: "turn_terminal",
        turnId: "turn_1",
        state: "interrupted",
        message: "runtime restart",
      },
    ])
    expect(projectExecutionView(state).pendingPermissionIds).toEqual([])
  })

  it("keeps unknown facts in catch-up state without rendering or throwing", () => {
    const state = reduceExecutionView(createExecutionViewState(), {
      type: "durable",
      event: {
        id: "event_future",
        sessionId,
        seq: 1,
        version: 2,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future_fact",
        data: { payload: true },
      },
    })

    expect(state.durableEvents).toHaveLength(1)
    expect(projectExecutionView(state).entries).toEqual([])
  })

  it("projects a compaction marker in seq order with its summary", () => {
    const facts = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "earlier work" },
        },
      },
      {
        type: EventType.ContextCompacted,
        data: {
          compactionId: "compaction_1",
          turnId: "turn_2",
          throughSeq: 5,
          coveredTurnIds: ["turn_1"],
          summary: "Goal: ship the feature.",
        },
      },
      {
        type: EventType.AssistantMessage,
        data: {
          messageId: "item_1",
          turnId: "turn_2",
          content: [{ type: "text" as const, text: "Continuing." }],
        },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createEventEnvelope({
            sessionId,
            seq: index + 1,
            createdAt: `2026-07-24T00:00:0${index}.000Z`,
            event,
          }),
        }),
      createExecutionViewState(),
    )

    expect(projectExecutionView(state).entries).toEqual([
      expect.objectContaining({ kind: "user_input", text: "earlier work" }),
      {
        kind: "context_compacted",
        compactionId: "compaction_1",
        summary: "Goal: ship the feature.",
        createdAt: "2026-07-24T00:00:01.000Z",
      },
      expect.objectContaining({ kind: "assistant", text: "Continuing." }),
    ])
  })

  it("summarizes tool entries and tracks model, usage, and queued inputs", () => {
    const facts = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "run" },
        },
      },
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:2",
          inputId: "input_2",
          role: InputRole.User,
          content: { kind: "text" as const, text: "queued" },
        },
      },
      {
        type: EventType.TurnStarted,
        data: {
          turnId: "turn_1",
          inputId: "input_1",
          executionContext: {
            mateId: "mate_1",
            mateRevisionId: "revision_1",
            provider: "faux",
            model: "faux-1",
            workingDirectory: "/workspace",
            enabledTools: ["run_command"],
            approvalPolicy: "host",
            limits: {
              modelCallsPerTurn: 4,
              toolCallsPerTurn: 8,
              modelVisibleMessageBlocks: 16,
              modelVisibleContextBytes: 1024,
              modelVisibleToolResultBytes: 512,
              modelVisibleToolResultLines: 32,
              assistantResponseBytes: 2048,
            },
          },
        },
      },
      {
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_1",
          itemId: "item_call_1",
          turnId: "turn_1",
          name: "run_command",
          input: {
            command:
              "pnpm test -- --run some/very/long/command/that/keeps/going/and/going/and/going/past/limit",
          },
          requiresPermission: true,
        },
      },
      {
        type: EventType.ToolCall,
        data: {
          toolCallId: "tool_2",
          itemId: "item_call_2",
          turnId: "turn_1",
          name: "read_file",
          input: { path: "src/index.ts" },
          requiresPermission: false,
        },
      },
      {
        type: EventType.TurnCompleted,
        data: {
          turnId: "turn_1",
          usage: { inputTokens: 120, outputTokens: 45 },
        },
      },
    ]
    const state = facts.reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createEventEnvelope({ sessionId, seq: index + 1, event }),
        }),
      createExecutionViewState(),
    )
    const view = projectExecutionView(state)

    expect(view.queuedInputIds).toEqual(["input_2"])
    expect(view.lastModel).toEqual({ provider: "faux", model: "faux-1" })
    expect(view.lastTurnUsage).toEqual({ inputTokens: 120, outputTokens: 45 })
    expect(view.entries).toEqual([
      expect.objectContaining({ kind: "user_input", inputId: "input_1" }),
      expect.objectContaining({ kind: "user_input", inputId: "input_2" }),
      expect.objectContaining({ kind: "tool", toolCallId: "tool_1" }),
      expect.objectContaining({ kind: "tool", toolCallId: "tool_2" }),
    ])

    const toolSummaries = view.entries.flatMap((entry) =>
      entry.kind === "tool" ? [entry.summary] : [],
    )
    expect(toolSummaries).toHaveLength(2)
    expect(toolSummaries[1]).toBe("src/index.ts")
    const commandSummary = toolSummaries[0] ?? ""
    expect(commandSummary.startsWith("pnpm test -- --run")).toBe(true)
    expect(commandSummary).toHaveLength(80)
    expect(commandSummary.endsWith("…")).toBe(true)
  })

  it("drops cancelled inputs from the queue and reports the active turn start", () => {
    let state = createExecutionViewState()
    state = [
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text" as const, text: "first" },
        },
      },
      {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:2",
          inputId: "input_2",
          role: InputRole.User,
          content: { kind: "text" as const, text: "cancelled" },
        },
      },
      {
        type: EventType.InputCancelled,
        data: { inputId: "input_2" },
      },
    ].reduce(
      (current, event, index) =>
        reduceExecutionView(current, {
          type: "durable",
          event: createEventEnvelope({
            sessionId,
            seq: index + 1,
            event,
            createdAt: `2026-07-24T00:00:0${index}.000Z`,
          }),
        }),
      state,
    )
    state = reduceExecutionView(state, {
      type: "session",
      session: {
        id: sessionId,
        seq: 3,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:02.000Z",
        activeTurnId: "turn_9",
        counts: {
          inputs: 2,
          pendingInputs: 1,
          turns: 0,
          items: 0,
          permissions: 0,
          tools: 0,
        },
      },
    })

    const view = projectExecutionView(state)
    expect(view.queuedInputIds).toEqual(["input_1"])
    expect(view.activeTurnId).toBe("turn_9")
    expect(view.activeTurnStartedAt).toBeUndefined()

    state = reduceExecutionView(state, {
      type: "durable",
      event: createEventEnvelope({
        sessionId,
        seq: 4,
        createdAt: "2026-07-24T00:00:03.000Z",
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "turn_9", inputId: "input_1" },
        },
      }),
    })

    const next = projectExecutionView(state)
    expect(next.queuedInputIds).toEqual([])
    expect(next.activeTurnStartedAt).toBe("2026-07-24T00:00:03.000Z")
  })
})
