// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const move = vi.fn().mockResolvedValue(true)
const select = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  window.localStorage.clear()
  move.mockClear()
  select.mockClear()
  useAppStore.setState({
    ...createInitialAppState(),
    changeSidebar: move,
    selectSession: select,
    sidebar: { sections: [{ id: "section_work", name: "Work" }], entries: {} },
    sessionsByProject: {
      "sidebar:section:pinned": { sessions: [] },
      "sidebar:section:section_work": {
        sessions: ["a", "b"].map((id) => ({
          id: `session_${id}`,
          navigationId: `session_${id}`,
          conversationId: `conversation_${id}`,
          seq: 1,
          title: `Task ${id}`,
          sectionId: "section_work",
          createdAt: "2026-09-13T00:00:00Z",
          updatedAt: "2026-09-13T00:00:00Z",
        })),
      },
    },
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("commits one move on release and suppresses the click after a drag", async () => {
  render(<App />)
  const source = screen.getByRole("button", { name: "Task b" })
  const target = screen.getByRole("button", { name: "Task a" })
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target)
  vi.spyOn(
    target.parentElement?.parentElement as HTMLElement,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 40, 250, 32))
  fireEvent.pointerDown(source, {
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
    clientX: 40,
    clientY: 80,
  })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 40 })
  await waitFor(() =>
    expect(document.querySelector(".sidebar-drag-ghost")).not.toBeNull(),
  )
  expect(move).not.toHaveBeenCalled()
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 40 })
  fireEvent.click(source)
  expect(move).toHaveBeenCalledExactlyOnceWith({
    type: "move-session",
    sessionId: "session_b",
    sectionId: "section_work",
    beforeSessionId: "session_a",
  })
  expect(select).not.toHaveBeenCalled()
  expect(document.querySelector(".sidebar-drag-ghost")).toBeNull()
})

it("cancels with Escape and preserves ordinary row clicks below the drag threshold", async () => {
  render(<App />)
  const source = screen.getByRole("button", { name: "Task b" })
  vi.spyOn(document, "elementFromPoint").mockReturnValue(source)
  fireEvent.pointerDown(source, {
    button: 0,
    pointerId: 1,
    clientX: 40,
    clientY: 80,
  })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 41, clientY: 80 })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 41, clientY: 80 })
  fireEvent.click(source)
  expect(select).toHaveBeenCalledTimes(1)
  fireEvent.pointerDown(source, {
    button: 0,
    pointerId: 1,
    clientX: 40,
    clientY: 80,
  })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 40 })
  await waitFor(() =>
    expect(document.querySelector(".sidebar-drag-ghost")).not.toBeNull(),
  )
  fireEvent.keyDown(window, { key: "Escape" })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 60, clientY: 40 })
  expect(move).not.toHaveBeenCalled()
  expect(document.querySelector(".sidebar-drag-ghost")).toBeNull()
  expect(
    document.documentElement.classList.contains("sidebar-is-dragging"),
  ).toBe(false)
})
