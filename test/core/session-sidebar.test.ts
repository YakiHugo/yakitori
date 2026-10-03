import { describe, expect, it } from "vitest"
import {
  changeSessionSidebar,
  emptySessionSidebar,
  parseSidebarChange,
} from "../../src/core/session-sidebar.ts"

const sessions = [
  { id: "session_a", navigationId: "session_root", updatedAt: "2026-09-01" },
]

describe("session sidebar", () => {
  it("rejects changes with no presentation fields", () => {
    expect(() =>
      parseSidebarChange({ type: "session", sessionId: "session_a" }),
    ).toThrow("No session changes supplied.")
  })

  it("updates presentation on the navigation root without changing section membership", () => {
    const initial = changeSessionSidebar(
      emptySessionSidebar(),
      {
        type: "session",
        sessionId: "session_a",
        title: "First",
        sectionId: "pinned",
      },
      sessions,
    )
    const renamed = changeSessionSidebar(
      initial,
      parseSidebarChange({
        type: "session",
        sessionId: "session_a",
        title: "Renamed",
        archived: true,
      }),
      sessions,
    )
    expect(renamed.entries).toMatchObject({
      session_root: {
        title: "Renamed",
        archived: true,
        sectionId: "pinned",
      },
    })
    expect(initial.entries.session_root?.title).toBe("First")
  })
})
