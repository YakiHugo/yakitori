import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createCoalescingDeltaPublisher,
  type LiveSessionEvent,
} from "../../src/runtime/live-events.ts"

afterEach(() => vi.useRealTimers())

describe("transient live events", () => {
  it.each([
    "timer",
    "explicit flush",
  ])("coalesces pending text without duplicate publication after %s", (mode) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"))
    const events: LiveSessionEvent[] = []
    const publisher = createCoalescingDeltaPublisher(
      { publishTransient: (event) => events.push(event) },
      1,
    )

    for (const delta of ["H", "el", "lo"]) {
      publisher.publish({
        sessionId: "session_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta,
      })
    }
    vi.advanceTimersByTime(999)
    expect(events).toEqual([
      expect.objectContaining({ type: "assistant.delta", delta: "H" }),
    ])
    if (mode === "timer") vi.advanceTimersByTime(1)
    else publisher.flush()

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.delta",
        offset: 0,
        itemId: "item_1",
        delta: "H",
      }),
      expect.objectContaining({
        type: "assistant.delta",
        offset: 1,
        itemId: "item_1",
        delta: "ello",
      }),
    ])
    vi.advanceTimersByTime(2_000)
    expect(events).toHaveLength(2)
  })
})
