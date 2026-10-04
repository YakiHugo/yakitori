import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  type TurnOutcome,
} from "../../src/kernel/events.ts"
import type { LiveAssistantDelta } from "../../src/runtime/live-events.ts"
import {
  createSessionEventHub,
  type SessionDelivery,
  type SessionEventHub,
} from "../../src/server/event-hub.ts"

const chunk = (delta: string, offset = 0): LiveAssistantDelta => ({
  type: "assistant.delta",
  sessionId: "session_1",
  turnId: "turn_1",
  itemId: "item_1",
  streamId: "stream_1",
  delta,
  offset,
  createdAt: "2026-10-04T00:00:00.000Z",
})
function snapshot(hub: SessionEventHub, sessionId = "session_1") {
  const received: SessionDelivery[] = []
  hub
    .subscribe(sessionId, (delivery) => {
      received.push(delivery)
    })
    .close()
  return received.flatMap((delivery) =>
    delivery.kind === "transient" && delivery.event.type === "assistant.delta"
      ? [delivery.event]
      : [],
  )
}

describe("bounded display recovery cache", () => {
  it("atomically queues retained text before live publications and survives subscriber churn", async () => {
    const hub = createSessionEventHub()
    hub.publishTransient(chunk("Before "))
    hub.publishTransient(chunk("missed", 7))
    for (let index = 0; index < 4; index++)
      expect(snapshot(hub)).toEqual([
        { ...chunk("Before missed"), snapshot: true },
      ])
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const received: SessionDelivery[] = []
    const subscription = hub.subscribe("session_1", async (delivery) => {
      received.push(delivery)
      if (received.length === 1) await gate
    })
    hub.publishTransient(chunk(" after", 13))
    expect(received).toHaveLength(1)
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([
      {
        kind: "transient",
        event: { ...chunk("Before missed"), snapshot: true },
      },
      { kind: "transient", event: chunk(" after", 13) },
    ])
    subscription.close()
    expect(snapshot(hub)[0]?.delta).toBe("Before missed after")
  })

  it.each<TurnOutcome>([
    { status: "completed" },
    { status: "cancelled" },
    { status: "interrupted" },
    { status: "failed", error: { message: "failed" } },
  ])("evicts runtime $status turns even without durable completion", (outcome) => {
    const hub = createSessionEventHub()
    hub.publishTransient(chunk("draft"))
    hub.publishTransient({
      type: "turn.finished",
      sessionId: "session_1",
      turnId: "turn_1",
      createdAt: chunk("").createdAt,
      outcome,
    })
    expect(snapshot(hub)).toEqual([])
  })

  it.each([
    "item.completed",
    "turn.completed",
    "turn.started",
    "item.discarded",
  ] as const)("evicts on %s without disturbing another session", (type) => {
    const hub = createSessionEventHub()
    hub.publishTransient(chunk("draft"))
    hub.publishTransient({ ...chunk("other"), sessionId: "session_2" })
    if (type === "item.discarded") hub.publishTransient({ ...chunk(""), type })
    else
      hub.publishDurable([
        createEventEnvelope({
          sessionId: "session_1",
          seq: 2,
          event:
            type === "item.completed"
              ? {
                  type,
                  data: {
                    turnId: "turn_1",
                    item: {
                      type: "agent_message",
                      itemId: "item_1",
                      content: [{ type: "text", text: "saved" }],
                    },
                  },
                }
              : type === "turn.completed"
                ? {
                    type,
                    data: {
                      turnId: "turn_1",
                      outcome: { status: "completed" },
                    },
                  }
                : { type, data: { turnId: "turn_2", inputId: "input_2" } },
        }),
      ])
    expect(snapshot(hub)).toEqual([])
    expect(snapshot(hub, "session_2")[0]?.delta).toBe("other")
  })

  it("replaces reused stream IDs and never combines noncontiguous cached chunks", () => {
    const hub = createSessionEventHub()
    hub.publishTransient(chunk("old"))
    hub.publishTransient({ ...chunk("new"), streamId: "retry" })
    expect(snapshot(hub)[0]).toMatchObject({
      delta: "new",
      streamId: "retry",
      offset: 0,
    })
    hub.publishTransient({ ...chunk("suffix", 10), streamId: "retry" })
    expect(snapshot(hub)[0]).toMatchObject({ delta: "suffix", offset: 10 })
  })

  it("bounds aggregate text and item records across sessions with an explicit suffix offset", () => {
    const hub = createSessionEventHub()
    hub.publishTransient(chunk(`😀${"a".repeat(1024 * 1024)}`))
    expect(snapshot(hub)[0]).toMatchObject({
      offset: 2,
      delta: "a".repeat(1024 * 1024),
    })
    // Force the budget cut through a surrogate pair: retain neither half.
    hub.publishTransient({ ...chunk("b"), sessionId: "session_2" })
    expect(snapshot(hub)[0]?.delta.length).toBe(1024 * 1024 - 1)
    hub.publishTransient({
      ...chunk(`😀${"c".repeat(1024 * 1024 - 1)}`),
      sessionId: "session_3",
    })
    const retained = snapshot(hub, "session_3")[0]
    expect(retained?.offset).toBe(2)
    expect(retained?.delta).toBe("c".repeat(1024 * 1024 - 1))
    for (let index = 0; index < 300; index++)
      hub.publishTransient({
        ...chunk("x"),
        sessionId: `session_${index}`,
        itemId: `item_${index}`,
      })
    expect(
      Array.from(
        { length: 300 },
        (_, index) => snapshot(hub, `session_${index}`).length,
      ).reduce((sum, count) => sum + count, 0),
    ).toBe(256)
  })
})
