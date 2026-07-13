import { describe, expect, it } from "vitest"
import {
  createDurableEventHub,
  createEventEnvelope,
  createSessionId,
  EventType,
} from "../../src/index.ts"

describe("durable event hub", () => {
  it("isolates synchronous listener failures", () => {
    const errors: unknown[] = []
    const hub = createDurableEventHub({
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
    hub.publish([event])

    expect(delivered).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it("isolates asynchronous listener failures", async () => {
    const errors: unknown[] = []
    const hub = createDurableEventHub({
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
    hub.publish([event])
    await Promise.resolve()

    expect(errors).toHaveLength(1)
  })
})
