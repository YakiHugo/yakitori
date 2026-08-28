import { describe, expect, it } from "vitest"
import { createEventEnvelope, EventType } from "../../src/kernel/events.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"

describe("session event hub", () => {
  it("isolates synchronous listener failures", () => {
    const errors: unknown[] = []
    const hub = createSessionEventHub({
      onListenerError(error) {
        errors.push(error)
      },
    })
    const event = createEventEnvelope({
      sessionId: createSessionId(),
      seq: 1,
      event: {
        type: EventType.SessionCreated,
        data: {},
      },
    })
    let delivered = 0

    hub.subscribe(event.sessionId, () => {
      throw new Error("listener failed")
    })
    hub.subscribe(event.sessionId, () => {
      delivered += 1
    })
    hub.publishDurable([event])

    expect(delivered).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it("isolates asynchronous listener failures", async () => {
    const errors: unknown[] = []
    const hub = createSessionEventHub({
      onListenerError(error) {
        errors.push(error)
      },
    })
    const event = createEventEnvelope({
      sessionId: createSessionId(),
      seq: 1,
      event: {
        type: EventType.SessionCreated,
        data: {},
      },
    })

    hub.subscribe(event.sessionId, async () => {
      throw new Error("listener rejected")
    })
    hub.publishDurable([event])
    await Promise.resolve()

    expect(errors).toHaveLength(1)
  })

  it("serializes transient and durable delivery for asynchronous subscribers", async () => {
    const hub = createSessionEventHub()
    const sessionId = createSessionId()
    const event = createEventEnvelope({
      sessionId,
      seq: 1,
      event: { type: EventType.SessionCreated, data: {} },
    })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const received: string[] = []

    hub.subscribe(sessionId, async (delivery) => {
      received.push(delivery.kind)
      if (delivery.kind === "transient") await blocked
    })
    hub.publishTransient({
      type: "assistant.delta",
      sessionId,
      turnId: "turn_1",
      itemId: "item_1",
      delta: "partial",
      createdAt: "2026-08-28T00:00:00.000Z",
    })
    hub.publishDurable([event])

    expect(received).toEqual(["transient"])
    release?.()
    await blocked
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual(["transient", "durable"])
  })
})
