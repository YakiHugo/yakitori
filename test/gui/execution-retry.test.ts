import { describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  type ExecutionViewAction,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createEventEnvelope,
  type KernelEvent,
  type TurnOutcome,
} from "../../src/kernel/events.ts"
import type { LiveRuntimeWarning } from "../../src/runtime/live-events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

const session: ApiSessionDetail = {
  id: "session_retry",
  conversationId: "session_retry",
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
const live = {
  sessionId: session.id,
  turnId: "turn_1",
  createdAt: session.createdAt,
}
const warning: LiveRuntimeWarning = {
  ...live,
  type: "runtime.warning",
  code: "model.retry",
  message:
    "Model request failed (rate_limited); retrying attempt 2 of 4 in 1200 ms.",
  details: {
    attempt: 1,
    nextAttempt: 2,
    maxAttempts: 4,
    delayMs: 1200,
    kind: "rate_limited",
    stage: "response_headers",
    provider: "openai",
    wireApi: "responses",
    status: 429,
  },
}

function durable(event: KernelEvent, seq = 2): ExecutionViewAction {
  return {
    type: "durable",
    event: createEventEnvelope({
      sessionId: session.id,
      createdAt: session.createdAt,
      seq,
      event,
    }),
  }
}

function runningState() {
  return reduceExecutionView(
    createExecutionViewState(),
    durable(
      {
        type: "turn.started",
        data: { turnId: live.turnId, inputId: "input_1" },
      },
      1,
    ),
  )
}

function retryingState() {
  return reduceExecutionView(runningState(), {
    type: "transient",
    event: warning,
  })
}

describe("model retry execution state", () => {
  it("projects structured retry diagnostics without adding transcript entries", () => {
    const before = runningState()
    const state = reduceExecutionView(before, {
      type: "transient",
      event: warning,
    })
    expect(state.activeRetry).toEqual({
      turnId: "turn_1",
      kind: "rate_limited",
      nextAttempt: 2,
      maxAttempts: 4,
      delayMs: 1200,
      message:
        "Model request failed (rate_limited); retrying attempt 2 of 4 in 1200 ms.",
    })
    expect(projectExecutionView(state).activeRetry).toEqual(state.activeRetry)
    expect(state.entries).toBe(before.entries)
    expect(state.lastSeq).toBe(1)

    const next = reduceExecutionView(state, {
      type: "transient",
      event: {
        ...warning,
        message: "Retrying after a disconnected stream.",
        details: {
          ...warning.details,
          kind: "stream_disconnected",
          nextAttempt: 3,
          delayMs: 0,
        },
      },
    })
    expect(projectExecutionView(next).activeRetry).toEqual({
      turnId: "turn_1",
      kind: "stream_disconnected",
      nextAttempt: 3,
      maxAttempts: 4,
      delayMs: 0,
      message: "Retrying after a disconnected stream.",
    })
    expect(next.entries).toBe(before.entries)
  })

  it("ignores warnings for an old turn and warnings arriving while idle", () => {
    const state = retryingState()
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: { ...warning, turnId: "turn_old" },
      }),
    ).toBe(state)
    const idle = createExecutionViewState()
    expect(
      reduceExecutionView(idle, { type: "transient", event: warning }),
    ).toBe(idle)
  })

  it.each([
    undefined,
    {},
    { ...warning.details, kind: "unknown_failure" },
    { ...warning.details, nextAttempt: "2" },
    { ...warning.details, nextAttempt: 1 },
    { ...warning.details, nextAttempt: 2.5 },
    { ...warning.details, maxAttempts: 1 },
    { ...warning.details, delayMs: -1 },
    { ...warning.details, delayMs: Number.NaN },
  ])("ignores malformed retry diagnostics without erasing a valid retry: %j", (details) => {
    const state = retryingState()
    const { details: _, ...withoutDetails } = warning
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: {
          ...withoutDetails,
          ...(details === undefined ? {} : { details }),
        },
      }),
    ).toBe(state)
  })

  it.each([
    "agent_message",
    "reasoning",
  ] as const)("clears retry on resumed %s output and retains the output", (type) => {
    let state = reduceExecutionView(runningState(), {
      type: "transient",
      event: {
        ...live,
        type: "item.started",
        item: { type, itemId: "output_1" },
      },
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: warning,
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        ...live,
        type: type === "agent_message" ? "assistant.delta" : "reasoning.delta",
        itemId: "output_1",
        delta: "Resumed output",
      },
    })
    expect(projectExecutionView(state).activeRetry).toBeUndefined()
    expect(projectExecutionView(state).activeActivity).toEqual({
      kind: type === "agent_message" ? "responding" : "reasoning",
    })
    expect(state.entries).toEqual([
      expect.objectContaining({ text: "Resumed output", status: "streaming" }),
    ])
  })

  const activityActions: ExecutionViewAction[] = [
    {
      type: "transient",
      event: {
        ...live,
        type: "item.started",
        item: { type: "reasoning", itemId: "reasoning_1" },
      },
    },
    {
      type: "transient",
      event: {
        ...live,
        type: "permission.requested",
        permissionRequestId: "permission_1",
        toolCallId: "call_1",
        action: "exec_command",
      },
    },
    {
      type: "transient",
      event: {
        ...live,
        type: "permission.resolved",
        permissionRequestId: "permission_1",
        outcome: "allow",
      },
    },
    durable({
      type: "item.started",
      data: {
        turnId: live.turnId,
        item: {
          type: "command_execution",
          itemId: "tool_1",
          toolCallId: "call_1",
          name: "exec_command",
          command: "pwd",
          input: { cmd: "pwd" },
          requiresPermission: false,
        },
      },
    }),
    durable({
      type: "item.completed",
      data: {
        turnId: live.turnId,
        item: {
          type: "agent_message",
          itemId: "message_1",
          content: [{ type: "text", text: "Recovered response" }],
        },
      },
    }),
    durable({
      type: "item.started",
      data: {
        turnId: live.turnId,
        item: { type: "context_compaction", itemId: "compaction_1" },
      },
    }),
    durable({
      type: "context.compacted",
      data: {
        turnId: live.turnId,
        compactionId: "compaction_1",
        throughSeq: 1,
        coveredTurnIds: ["turn_old"],
        summary: "Earlier work",
        replacement: {
          windowId: "window_2",
          firstWindowId: "window_1",
          previousWindowId: "window_1",
          windowNumber: 2,
          history: [],
          worldStateBaseline: {},
        },
      },
    }),
  ]

  it.each(
    activityActions,
  )("clears retry on matching-turn normal activity: %j", (action) => {
    const state = reduceExecutionView(retryingState(), action)
    expect(state.activeRetry).toBeUndefined()
    expect(projectExecutionView(state).activeRetry).toBeUndefined()
    expect(state.activeTurnId).toBe("turn_1")
  })

  it("preserves retry across unrelated events and other-turn activity", () => {
    const before = retryingState()
    const actions: ExecutionViewAction[] = [
      { type: "transient", event: { ...warning, code: "tool.warning" } },
      {
        type: "transient",
        event: {
          ...live,
          type: "session.usage",
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
      {
        type: "transient",
        event: {
          ...live,
          type: "assistant.delta",
          itemId: "unknown_item",
          delta: "Unmatched output",
        },
      },
      {
        type: "transient",
        event: {
          ...live,
          turnId: "turn_old",
          type: "item.started",
          item: { type: "reasoning", itemId: "old_reasoning" },
        },
      },
      durable({
        type: "item.completed",
        data: {
          turnId: "turn_old",
          item: { type: "reasoning", itemId: "old_reasoning", text: "Old" },
        },
      }),
      {
        type: "transient",
        event: {
          ...live,
          turnId: "turn_old",
          type: "turn.finished",
          outcome: { status: "completed" },
        },
      },
      durable({
        type: "turn.completed",
        data: { turnId: "turn_old", outcome: { status: "completed" } },
      }),
      durable({
        type: "input.admitted",
        data: {
          requestId: "request_2",
          inputId: "input_2",
          role: "user",
          content: { kind: "text", text: "Queued input" },
        },
      }),
    ]
    let state = before
    for (const action of actions) {
      state = reduceExecutionView(state, action)
      expect(projectExecutionView(state).activeRetry).toEqual(
        before.activeRetry,
      )
      expect(state.activeTurnId).toBe("turn_1")
    }
  })

  it.each<TurnOutcome>([
    { status: "completed" },
    { status: "failed", error: { message: "Provider unavailable" } },
    { status: "cancelled" },
    { status: "interrupted" },
  ])("clears retry on live and durable $status completion", (outcome) => {
    for (const action of [
      {
        type: "transient",
        event: { ...live, type: "turn.finished", outcome },
      } satisfies ExecutionViewAction,
      durable({
        type: "turn.completed",
        data: { turnId: live.turnId, outcome },
      }),
    ]) {
      const state = reduceExecutionView(retryingState(), action)
      expect(state.activeRetry).toBeUndefined()
      expect(projectExecutionView(state).activeRetry).toBeUndefined()
      expect(state.activeTurnId).toBeUndefined()
      expect(
        reduceExecutionView(state, { type: "transient", event: warning }),
      ).toBe(state)
    }
  })

  it("clears retry when a new turn starts and rejects the prior turn's warning", () => {
    const state = reduceExecutionView(
      retryingState(),
      durable({
        type: "turn.started",
        data: { turnId: "turn_2", inputId: "input_2" },
      }),
    )
    expect(projectExecutionView(state).activeRetry).toBeUndefined()
    expect(state.activeTurnId).toBe("turn_2")
    expect(
      reduceExecutionView(state, { type: "transient", event: warning }),
    ).toBe(state)
  })

  it.each([
    "snapshot",
    "replay_completed",
  ] as const)("reconciles retry with the active turn at %s", (type) => {
    const before = retryingState()
    const unchanged = reduceExecutionView(before, {
      type,
      session: { ...session, activeTurnId: "turn_1" },
    })
    expect(projectExecutionView(unchanged).activeRetry).toEqual(
      before.activeRetry,
    )
    for (const recovered of [session, { ...session, activeTurnId: "turn_2" }]) {
      const state = reduceExecutionView(before, { type, session: recovered })
      expect(state.activeRetry).toBeUndefined()
      expect(projectExecutionView(state).activeRetry).toBeUndefined()
    }
  })

  it("preserves newer live retry when an older idle replay completes", () => {
    const state = retryingState()
    const next = reduceExecutionView(state, {
      type: "replay_completed",
      session: { ...session, seq: 0 },
    })
    expect(next.activeTurnId).toBe("turn_1")
    expect(projectExecutionView(next).activeRetry).toEqual(state.activeRetry)
  })

  it("clears retry on stream loss without persisting it into the transcript", () => {
    const state = reduceExecutionView(retryingState(), {
      type: "stream_unavailable",
    })
    expect(state.activeRetry).toBeUndefined()
    expect(projectExecutionView(state).activeRetry).toBeUndefined()
    expect(state.activeTurnId).toBeUndefined()
    expect(state.entries).toEqual([])
    expect(state.lastSeq).toBe(1)
  })
})
