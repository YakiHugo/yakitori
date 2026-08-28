import { describe, expect, it } from "vitest"
import {
  createCoalescingDeltaPublisher,
  type LiveSessionEvent,
  suffixDelta,
} from "../../src/runtime/live-events.ts"

describe("transient live events", () => {
  it("derives only the suffix of a cumulative snapshot", () => {
    expect(suffixDelta("", "Hel")).toBe("Hel")
    expect(suffixDelta("Hel", "Hello")).toBe("lo")
    expect(suffixDelta("Hello", "Hello")).toBeUndefined()
    expect(suffixDelta("Hello", "Hi")).toBeUndefined()
  })

  it("publishes suffix deltas and flushes coalesced pending text", () => {
    const events: LiveSessionEvent[] = []
    const publisher = createCoalescingDeltaPublisher(
      { publishTransient: (event) => events.push(event) },
      1,
    )

    publisher.publish({
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      text: "Hel",
    })
    publisher.publish({
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      text: "Hello",
    })
    publisher.flush()

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.delta",
        itemId: "item_1",
        delta: "Hel",
      }),
      expect.objectContaining({
        type: "assistant.delta",
        itemId: "item_1",
        delta: "lo",
      }),
    ])
  })
})
