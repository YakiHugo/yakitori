import { describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createEventEnvelope,
  type TurnOutcome,
} from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

const session: ApiSessionDetail = {
  id: "session_recovery",
  conversationId: "session_recovery",
  seq: 1,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 1,
    pendingInputs: 0,
    turns: 1,
    items: 0,
    permissions: 0,
    tools: 0,
  },
}

function runningState() {
  return reduceExecutionView(createExecutionViewState(), {
    type: "durable",
    event: createEventEnvelope({
      sessionId: session.id,
      seq: 1,
      createdAt: session.createdAt,
      event: {
        type: "turn.started",
        data: { turnId: "turn_1", inputId: "input_1" },
      },
    }),
  })
}

describe("execution recovery", () => {
  it("settles cached output, tools, permissions and compaction after an idle reconnect", () => {
    let state = runningState()
    for (const item of [
      { type: "context_compaction" as const, itemId: "compaction_1" },
      {
        type: "command_execution" as const,
        itemId: "tool_1",
        toolCallId: "call_1",
        name: "exec_command",
        input: { cmd: "echo test" },
        requiresPermission: true,
        command: "echo test",
      },
      { type: "reasoning" as const, itemId: "reasoning_1" },
    ]) {
      state = reduceExecutionView(state, {
        type: "transient",
        event: {
          type: "item.started",
          sessionId: session.id,
          turnId: "turn_1",
          createdAt: session.createdAt,
          item,
        },
      })
    }
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "reasoning.delta",
        sessionId: session.id,
        turnId: "turn_1",
        itemId: "reasoning_1",
        delta: "Checking files",
        createdAt: session.createdAt,
      },
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "permission.requested",
        sessionId: session.id,
        turnId: "turn_1",
        toolCallId: "call_1",
        permissionRequestId: "permission_1",
        action: "exec_command",
        createdAt: session.createdAt,
      },
    })
    state = reduceExecutionView(state, { type: "snapshot", session })
    // Reconnection has no newer durable events when the process died.
    state = reduceExecutionView(state, { type: "replay_completed", session })
    state = reduceExecutionView(state, { type: "replay_completed", session })
    const view = projectExecutionView(state)
    expect(view.activeTurnId).toBeUndefined()
    expect(view.activeActivity).toBeUndefined()
    expect(view.entries).toEqual([
      expect.objectContaining({ kind: "tool", state: "interrupted" }),
      expect.objectContaining({
        kind: "reasoning",
        text: "Checking files",
        status: "completed",
      }),
      expect.objectContaining({ kind: "permission", state: "resolved" }),
      expect.objectContaining({ kind: "turn_terminal", state: "interrupted" }),
    ])
    expect(state.openCompactionItems).toEqual({})
  })

  it.each([
    {
      hasOutput: true,
      kinds: ["user_input", "reasoning", "turn_terminal", "user_input"],
    },
    { hasOutput: false, kinds: ["user_input", "turn_terminal", "user_input"] },
  ])("anchors an interruption to its input or output (output: $hasOutput)", ({
    hasOutput,
    kinds,
  }) => {
    let state = reduceExecutionView(createExecutionViewState(), {
      type: "durable",
      event: createEventEnvelope({
        sessionId: session.id,
        seq: 1,
        event: {
          type: "input.admitted",
          data: {
            requestId: "request_1",
            inputId: "input_1",
            role: "user",
            content: { kind: "text", text: "Check" },
          },
        },
      }),
    })
    state = reduceExecutionView(state, {
      type: "durable",
      event: createEventEnvelope({
        sessionId: session.id,
        seq: 2,
        event: {
          type: "turn.started",
          data: { turnId: "turn_1", inputId: "input_1" },
        },
      }),
    })
    if (hasOutput) {
      state = reduceExecutionView(state, {
        type: "durable",
        event: createEventEnvelope({
          sessionId: session.id,
          seq: 3,
          event: {
            type: "item.completed",
            data: {
              turnId: "turn_1",
              item: {
                type: "reasoning",
                itemId: "reasoning_1",
                text: "Checking",
              },
            },
          },
        }),
      })
    }
    state = reduceExecutionView(state, {
      type: "durable",
      event: createEventEnvelope({
        sessionId: session.id,
        seq: 4,
        event: {
          type: "input.admitted",
          data: {
            requestId: "request_2",
            inputId: "input_2",
            role: "user",
            content: { kind: "text", text: "Continue" },
          },
        },
      }),
    })
    state = reduceExecutionView(state, {
      type: "replay_completed",
      session: { ...session, seq: 4 },
    })
    expect(
      projectExecutionView(state).entries.map((entry) => entry.kind),
    ).toEqual(kinds)
  })

  it.each<TurnOutcome>([
    { status: "completed" },
    { status: "interrupted", reason: "User interrupted" },
    { status: "failed", error: { message: "Model failed" } },
  ])("settles a runtime $status outcome independently of durable telemetry", (outcome) => {
    let state = runningState()
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "item.started",
        sessionId: session.id,
        turnId: "turn_1",
        item: { type: "agent_message", itemId: "message_1" },
        createdAt: session.createdAt,
      },
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "assistant.delta",
        sessionId: session.id,
        turnId: "turn_1",
        itemId: "message_1",
        delta: "Visible output",
        createdAt: session.createdAt,
      },
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "turn.finished",
        sessionId: session.id,
        turnId: "turn_1",
        outcome,
        createdAt: "2026-09-17T00:00:01.000Z",
      },
    })
    expect(projectExecutionView(state).activeActivity).toBeUndefined()
    expect(state.lastSeq).toBe(1)
    expect(projectExecutionView(state).telemetry.turns).toBe(0)
    expect(projectExecutionView(state).entries[0]).toMatchObject({
      kind: "assistant",
      text: "Visible output",
      status: "completed",
    })

    state = reduceExecutionView(state, {
      type: "durable",
      event: createEventEnvelope({
        sessionId: session.id,
        seq: 2,
        event: { type: "turn.completed", data: { turnId: "turn_1", outcome } },
      }),
    })
    const view = projectExecutionView(state)
    expect(view.telemetry.turns).toBe(1)
    expect(
      view.entries.filter((entry) => entry.kind === "turn_terminal"),
    ).toHaveLength(outcome.status === "completed" ? 0 : 1)
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "turn.finished",
        sessionId: session.id,
        turnId: "turn_1",
        outcome,
        createdAt: "2026-09-17T00:00:02.000Z",
      },
    })
    expect(projectExecutionView(state)).toEqual(view)
    expect(state.lastSeq).toBe(2)
  })
})
