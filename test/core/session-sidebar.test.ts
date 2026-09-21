import { describe, expect, it } from "vitest"
import {
  changeSessionSidebar,
  emptySessionSidebar,
  parseSidebarChange,
} from "../../src/core/session-sidebar.ts"

const sessions = [
  { id: "session_a", navigationId: "session_a", updatedAt: "2026-09-01" },
]

describe("session sidebar goal", () => {
  it("parses a goal change and rejects an empty goal", () => {
    expect(
      parseSidebarChange({
        type: "session",
        sessionId: "session_a",
        goal: "ship it",
      }),
    ).toEqual({ type: "session", sessionId: "session_a", goal: "ship it" })
    expect(
      parseSidebarChange({
        type: "session",
        sessionId: "session_a",
        goal: null,
      }),
    ).toEqual({ type: "session", sessionId: "session_a", goal: null })
    expect(() =>
      parseSidebarChange({
        type: "session",
        sessionId: "session_a",
        goal: " ",
      }),
    ).toThrow()
    expect(() =>
      parseSidebarChange({ type: "session", sessionId: "session_a" }),
    ).toThrow()
  })

  it("sets, replaces, and clears the goal on the navigation entry", () => {
    const set = changeSessionSidebar(
      emptySessionSidebar(),
      { type: "session", sessionId: "session_a", goal: "first" },
      sessions,
    )
    expect(set.entries.session_a?.goal).toBe("first")

    const replaced = changeSessionSidebar(
      set,
      { type: "session", sessionId: "session_a", goal: "second" },
      sessions,
    )
    expect(replaced.entries.session_a?.goal).toBe("second")

    const cleared = changeSessionSidebar(
      replaced,
      { type: "session", sessionId: "session_a", goal: null },
      sessions,
    )
    expect(cleared.entries.session_a?.goal).toBeUndefined()
    expect("goal" in (cleared.entries.session_a ?? {})).toBe(false)
    // Other presentation fields survive a goal-only change.
    const titled = changeSessionSidebar(
      set,
      { type: "session", sessionId: "session_a", title: "named" },
      sessions,
    )
    expect(titled.entries.session_a).toMatchObject({
      goal: "first",
      title: "named",
    })
  })
})
