import { expect, it } from "vitest"
import {
  createExecutionViewState,
  type ExecutionViewState,
  reduceExecutionView,
} from "../../../src/gui/execution-view.ts"
import { createEventEnvelope } from "../../../src/kernel/events.ts"
import type { AppSessionEventEnvelope } from "../../../src/protocol/events.ts"
import {
  createCoalescingDeltaPublisher,
  type LiveSessionEvent,
} from "../../../src/runtime/live-events.ts"
import type { ApiReadSessionResponse } from "../../../src/server/protocol.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  flush,
  initializeConnection,
  makeSessionDetail,
  makeTurnStarted,
  okResult,
  openTestConnection,
  pagedEventsHandler,
  type TestConnection,
} from "./testkit.ts"

it("restores an active response over RPC without replaying tools or duplicating the transcript", async () => {
  const sessionId = "session_1"
  const events: AppSessionEventEnvelope[] = [
    makeTurnStarted(sessionId, 1, "turn_1"),
  ]
  const detail = () =>
    makeSessionDetail(sessionId, {
      seq: events.at(-1)?.seq ?? 1,
      activeTurnId: "turn_1",
    })
  const handlers = createFakeHandlers({
    readSession: async () => okResult({ session: detail() }),
    readSessionEvents: pagedEventsHandler(events),
  })
  const { processor, eventHub } = createTestProcessor({ handlers })
  const assistant = createCoalescingDeltaPublisher(eventHub, 30)
  const reasoning = createCoalescingDeltaPublisher(
    eventHub,
    30,
    "reasoning.delta",
  )
  const publish = (
    publisher: typeof assistant,
    itemId: string,
    delta: string,
  ) => {
    publisher.publish({ sessionId, turnId: "turn_1", itemId, delta })
    publisher.flush()
  }
  const subscribe = async (
    client: TestConnection,
    state: ExecutionViewState,
  ) => {
    const response = await client.sendRequest("session/subscribe", {
      sessionId,
      after: state.lastSeq,
    })
    if (!("result" in response)) throw new Error("Subscription failed")
    const snapshot = (response.result as ApiReadSessionResponse).session
    await client.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
    await flush()
    state = reduceExecutionView(state, { type: "snapshot", session: snapshot })
    for (const frame of client.frames) {
      if (!("method" in frame)) continue
      if (frame.method === "session/event")
        state = reduceExecutionView(state, {
          type: "durable",
          event: (frame.params as { event: AppSessionEventEnvelope }).event,
        })
      if (frame.method === "session/replayComplete")
        state = reduceExecutionView(state, {
          type: "replay_completed",
          session: snapshot,
        })
      if (frame.method === "session/transient")
        state = reduceExecutionView(state, {
          type: "transient",
          event: frame.params as LiveSessionEvent,
        })
    }
    return state
  }
  const first = openTestConnection(processor)
  const second = openTestConnection(processor)
  try {
    await initializeConnection(first)
    await initializeConnection(second)
    let state = await subscribe(first, createExecutionViewState())
    eventHub.publishTransient({
      type: "item.started",
      sessionId,
      turnId: "turn_1",
      item: { type: "agent_message", itemId: "answer" },
      createdAt: "2026-10-04T00:00:00Z",
    })
    publish(assistant, "answer", "Before ")
    for (const frame of first.notifications("session/transient"))
      state = reduceExecutionView(state, {
        type: "transient",
        event: frame.params as LiveSessionEvent,
      })
    await processor.closeConnection(first.id)
    state = reduceExecutionView(state, { type: "stream_unavailable" })

    publish(assistant, "answer", "missed ")
    publish(reasoning, "answer_reasoning", "Checking offline")
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
      sessionId,
      seq: 2,
      event: { type: "item.started", data: { turnId: "turn_1", item: tool } },
    })
    events.push(started)
    eventHub.publishDurable([started])
    state = await subscribe(second, state)
    expect(state.entries.filter((entry) => entry.kind === "tool")).toHaveLength(
      1,
    )
    expect(state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          text: "Before missed ",
          status: "streaming",
          incomplete: false,
        }),
        expect.objectContaining({
          kind: "reasoning",
          text: "Checking offline",
          status: "streaming",
          incomplete: false,
        }),
        expect.objectContaining({ kind: "tool", state: "requested" }),
      ]),
    )
    const count = second.notifications("session/transient").length
    publish(assistant, "answer", "after")
    for (const frame of second.notifications("session/transient").slice(count))
      state = reduceExecutionView(state, {
        type: "transient",
        event: frame.params as LiveSessionEvent,
      })
    expect(
      state.entries.find((entry) => entry.kind === "assistant"),
    ).toMatchObject({ text: "Before missed after" })
    // A repeated tool start from a buffered live publication is display-only.
    state = reduceExecutionView(state, {
      type: "transient",
      event: {
        type: "item.started",
        sessionId,
        turnId: "turn_1",
        item: tool,
        createdAt: "2026-10-04T00:00:01Z",
      },
    })
    expect(state.entries.filter((entry) => entry.kind === "tool")).toHaveLength(
      1,
    )
    expect(events).toHaveLength(2)
  } finally {
    await processor.closeConnection(first.id)
    await processor.closeConnection(second.id)
  }
})
