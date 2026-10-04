import { describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import { createEventEnvelope } from "../../src/kernel/events.ts"
import type {
  LiveAssistantDelta,
  LiveReasoningDelta,
} from "../../src/runtime/live-events.ts"
import { makeSessionDetail } from "../server/rpc/testkit.ts"

const session = makeSessionDetail("session_1", {
  seq: 1,
  activeTurnId: "turn_1",
})
const at = "2026-10-04T00:00:00.000Z"
function chunk(
  type: "assistant.delta" | "reasoning.delta",
  delta: string,
  offset = 0,
): LiveAssistantDelta | LiveReasoningDelta {
  return {
    type,
    delta,
    offset,
    streamId: type,
    sessionId: session.id,
    turnId: "turn_1",
    itemId: type,
    createdAt: at,
  }
}
function running() {
  return createExecutionViewState(session)
}

describe("partial display stream recovery", () => {
  it.each([
    "assistant.delta",
    "reasoning.delta",
  ] as const)("restores missed %s output and continues without duplicating overlapping chunks", (type) => {
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: chunk(type, "Before "),
    })
    state = reduceExecutionView(state, { type: "stream_unavailable" })
    expect(state.entries[0]).toMatchObject({
      text: "Before ",
      status: "suspended",
      incomplete: true,
    })
    state = reduceExecutionView(state, { type: "replay_completed", session })
    state = reduceExecutionView(state, {
      type: "transient",
      event: { ...chunk(type, "Before missed "), snapshot: true },
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: chunk(type, "after", 14),
    })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      text: "Before missed after",
      status: "streaming",
      incomplete: false,
    })
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk(type, "after", 14),
      }),
    ).toBe(state)
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk(type, "Before "),
      }),
    ).toBe(state)
  })

  it("keeps reasoning and assistant offsets independent and marks missing content instead of joining a gap", () => {
    let state = running()
    for (const event of [
      chunk("assistant.delta", "Before "),
      chunk("reasoning.delta", "Thinking"),
      chunk("assistant.delta", "after", 20),
      chunk("reasoning.delta", " more", 8),
    ])
      state = reduceExecutionView(state, { type: "transient", event })
    expect(state.entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "after",
        textOffset: 20,
        incomplete: true,
      }),
      expect.objectContaining({
        kind: "reasoning",
        text: "Thinking more",
        incomplete: false,
      }),
    ])
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk("assistant.delta", "late", 7),
      }),
    ).toBe(state)
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        ...chunk("assistant.delta", "01234567890123456789after"),
        snapshot: true,
      },
    })
    expect(state.entries[0]).toMatchObject({
      text: "01234567890123456789after",
      incomplete: false,
    })
  })

  it("resumes from a contained cache suffix without discarding the richer local prefix", () => {
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: chunk("assistant.delta", "hello world"),
    })
    state = reduceExecutionView(state, { type: "stream_unavailable" })
    state = reduceExecutionView(state, { type: "replay_completed", session })
    expect(state.entries[0]).toMatchObject({
      status: "partial",
      incomplete: true,
    })
    state = reduceExecutionView(state, {
      type: "transient",
      event: { ...chunk("assistant.delta", "world", 6), snapshot: true },
    })
    expect(state.entries[0]).toMatchObject({
      text: "hello world",
      status: "streaming",
      incomplete: false,
    })
  })

  it("replaces a discarded attempt that reused an item ID while offline", () => {
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: chunk("assistant.delta", "Old long attempt"),
    })
    state = reduceExecutionView(state, { type: "stream_unavailable" })
    state = reduceExecutionView(state, { type: "replay_completed", session })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        ...chunk("assistant.delta", "New"),
        streamId: "retry",
        snapshot: true,
      },
    })
    expect(state.entries[0]).toMatchObject({
      text: "New",
      status: "streaming",
      incomplete: false,
    })
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk("assistant.delta", " stale", 16),
      }),
    ).toBe(state)
  })

  it("lets durable completion replace partial text and reject later deltas", () => {
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: chunk("assistant.delta", "suffix", 200),
    })
    const completion = createEventEnvelope({
      sessionId: session.id,
      seq: 2,
      createdAt: at,
      event: {
        type: "item.completed",
        data: {
          turnId: "turn_1",
          item: {
            type: "agent_message",
            itemId: "assistant.delta",
            content: [{ type: "text", text: "Full saved answer" }],
          },
        },
      },
    })
    state = reduceExecutionView(state, { type: "durable", event: completion })
    expect(state.entries[0]).toMatchObject({
      text: "Full saved answer",
      status: "completed",
    })
    expect(state.entries[0]).not.toHaveProperty("incomplete")
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk("assistant.delta", "old", 206),
      }),
    ).toBe(state)
    const history = reduceExecutionView(running(), {
      type: "durable",
      event: completion,
    })
    expect(history.entries).toEqual(state.entries)
  })

  it("restores active tool status and keeps one identity across durable and transient replay", () => {
    const tool = {
      type: "command_execution" as const,
      itemId: "tool_1",
      toolCallId: "call_1",
      name: "exec_command",
      input: { cmd: "echo test" },
      command: "echo test",
      requiresPermission: false,
    }
    const started = createEventEnvelope({
      sessionId: session.id,
      seq: 2,
      event: { type: "item.started", data: { turnId: "turn_1", item: tool } },
    })
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: {
        type: "item.started",
        sessionId: session.id,
        turnId: "turn_1",
        item: tool,
        createdAt: at,
      },
    })
    state = reduceExecutionView(state, { type: "stream_unavailable" })
    expect(state.entries[0]).toMatchObject({ state: "unknown" })
    state = reduceExecutionView(state, { type: "durable", event: started })
    state = reduceExecutionView(state, {
      type: "replay_completed",
      session: { ...session, seq: 2 },
    })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ state: "requested" })
    expect(projectExecutionView(state).activeActivity).toEqual({
      kind: "running_tool",
      name: "exec_command",
    })
  })

  it("removes a suspended discarded item and never revives output for an idle snapshot", () => {
    let state = reduceExecutionView(running(), {
      type: "transient",
      event: chunk("assistant.delta", "Before"),
    })
    state = reduceExecutionView(state, { type: "stream_unavailable" })
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "item.discarded",
        sessionId: session.id,
        turnId: "turn_1",
        itemId: "assistant.delta",
        createdAt: at,
      },
    })
    expect(state.entries).toEqual([])
    state = reduceExecutionView(state, {
      type: "replay_completed",
      session: makeSessionDetail(session.id, { seq: 1 }),
    })
    expect(
      reduceExecutionView(state, {
        type: "transient",
        event: chunk("assistant.delta", "late"),
      }),
    ).toBe(state)
    expect(projectExecutionView(state).activeActivity).toBeUndefined()
  })
})
