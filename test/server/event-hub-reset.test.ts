import { describe, expect, it } from "vitest"
import { createEventEnvelope, EventType } from "../../src/kernel/events.ts"
import {
  createSessionEventHub,
  type SessionDelivery,
} from "../../src/server/event-hub.ts"
import {
  deferred,
  makeAssistantDelta,
  waitForCondition,
} from "./rpc/testkit.ts"

describe("session event hub reset", () => {
  it("drops queued old deliveries before reset and clears only that session's display cache", async () => {
    const hub = createSessionEventHub()
    const gate = deferred<void>()
    const received: SessionDelivery[] = []
    const oldEvent = createEventEnvelope({
      sessionId: "session_1",
      seq: 90,
      event: { type: EventType.SessionCreated, data: {} },
    })
    hub.subscribe("session_1", (delivery) => {
      received.push(delivery)
      if (received.length === 1) return gate.promise
    })
    hub.publishDurable([oldEvent])
    hub.publishDurable([{ ...oldEvent, seq: 91 }])
    hub.publishTransient(makeAssistantDelta("session_1", "turn_old", "old"))
    hub.publishTransient(makeAssistantDelta("session_2", "turn_other", "other"))

    hub.resetSession("session_1")
    const newSubscriber: SessionDelivery[] = []
    hub.subscribe("session_1", (delivery) => {
      newSubscriber.push(delivery)
    })
    expect(newSubscriber).toEqual([])
    const otherSubscriber: SessionDelivery[] = []
    hub.subscribe("session_2", (delivery) => {
      otherSubscriber.push(delivery)
    })
    expect(otherSubscriber).toMatchObject([
      { kind: "transient", event: { delta: "other", snapshot: true } },
    ])
    const newEvent = { ...oldEvent, seq: 1 }
    hub.publishDurable([newEvent])
    gate.resolve()
    await waitForCondition(() => received.length === 3)
    expect(received).toEqual([
      { kind: "durable", events: [oldEvent] },
      { kind: "reset", sessionId: "session_1" },
      { kind: "durable", events: [newEvent] },
    ])
    expect(newSubscriber).toEqual([{ kind: "durable", events: [newEvent] }])
  })
})
