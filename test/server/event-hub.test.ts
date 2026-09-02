import { describe, expect, it, vi } from "vitest"
import { createEventEnvelope, EventType } from "../../src/kernel/events.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"

describe("session event hub", () => {
  it("isolates synchronous listener failures", () => {
    const errors: unknown[] = []
    const hub = createSessionEventHub({
      reportOperationalFailure(failure) {
        errors.push(failure)
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
    expect(errors).toEqual([
      expect.objectContaining({
        component: "session-event-hub",
        operation: "deliver",
        sessionId: event.sessionId,
        eventRange: { from: 1, through: 1 },
        cause: expect.any(Error),
      }),
    ])
  })

  it("isolates asynchronous listener failures", async () => {
    const errors: unknown[] = []
    const hub = createSessionEventHub({
      reportOperationalFailure(failure) {
        errors.push(failure)
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

    expect(errors).toEqual([
      expect.objectContaining({
        component: "session-event-hub",
        operation: "deliver",
        sessionId: event.sessionId,
        eventRange: { from: 1, through: 1 },
        cause: expect.any(Error),
      }),
    ])
  })

  it("keeps delivery isolated when the operational reporter also fails", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const hub = createSessionEventHub({
      reportOperationalFailure() {
        throw new Error("reporter failed")
      },
    })
    const event = createEventEnvelope({
      sessionId: createSessionId(),
      seq: 1,
      event: { type: EventType.SessionCreated, data: {} },
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
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it("observes a rejected asynchronous operational reporter", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const hub = createSessionEventHub({
      async reportOperationalFailure() {
        throw new Error("reporter rejected")
      },
    })
    const event = createEventEnvelope({
      sessionId: createSessionId(),
      seq: 1,
      event: { type: EventType.SessionCreated, data: {} },
    })
    hub.subscribe(event.sessionId, () => {
      throw new Error("listener failed")
    })

    hub.publishDurable([event])
    await Promise.resolve()
    await Promise.resolve()

    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
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
