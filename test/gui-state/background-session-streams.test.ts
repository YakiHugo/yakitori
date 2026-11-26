import { expect, it, vi } from "vitest"
import { BackgroundSessionStreams } from "../../src/gui/store/background-session-streams.ts"

it("starts the idle lifetime only when the background detail reaches a terminal state", () => {
  vi.useFakeTimers()
  const views = new Set(["running", "idle"])
  const streams = new BackgroundSessionStreams((key) => {
    views.delete(key)
  })
  const running = { sessionId: "running", close: vi.fn() }
  const idle = { sessionId: "idle", close: vi.fn() }
  try {
    streams.park(
      "running",
      { source: running, ready: () => true, activate() {} },
      true,
    )
    streams.park(
      "idle",
      { source: idle, ready: () => true, activate() {} },
      false,
    )
    vi.advanceTimersByTime(3 * 60 * 60 * 1000)
    expect(views).toEqual(new Set(["running"]))
    expect(idle.close).toHaveBeenCalledOnce()
    expect(running.close).not.toHaveBeenCalled()

    streams.updateActivity("running", false)
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 - 1)
    expect(views.has("running")).toBe(true)
    vi.advanceTimersByTime(1)
    expect(views.has("running")).toBe(false)
    expect(running.close).toHaveBeenCalledOnce()
  } finally {
    streams.clear()
    vi.useRealTimers()
  }
})
