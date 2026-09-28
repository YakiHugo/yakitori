import { describe, expect, it } from "vitest"
import {
  createCoalescingDeltaPublisher,
  type LiveSessionEvent,
} from "../../src/runtime/live-events.ts"

describe("transient live events", () => {
  it("publishes provider deltas and flushes coalesced pending text", () => {
    const events: LiveSessionEvent[] = []
    const publisher = createCoalescingDeltaPublisher(
      { publishTransient: (event) => events.push(event) },
      1,
    )

    publisher.publish({
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "Hel",
    })
    publisher.publish({
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "lo",
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
