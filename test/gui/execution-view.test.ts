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
})
