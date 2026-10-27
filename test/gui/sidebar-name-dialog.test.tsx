// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SidebarDialog } from "../../src/gui/components/sidebar-surfaces.tsx"
import { SessionItems } from "../../src/gui/components/sidebar-sessions.tsx"
import {
  createInitialAppState,
  sessionListKey,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => useAppStore.setState(createInitialAppState()))
afterEach(cleanup)

it("keeps a reopened rename dialog when a cancelled dialog's save finishes", async () => {
  let finish: ((done: boolean) => void) | undefined
  const changeSidebar = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  useAppStore.setState({
    changeSidebar,
    sessionsByProject: {
      [sessionListKey(undefined)]: {
        sessions: [
          {
            id: "session_a",
            conversationId: "session_a",
            seq: 1,
            title: "Original",
            createdAt: "2026-09-20T00:00:00Z",
            updatedAt: "2026-09-20T00:00:00Z",
          },
        ],
      },
    },
  })
  render(<SessionItems />)
  const openRename = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Session actions for Original" }),
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
  }
  openRename()
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "First title" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(changeSidebar).toHaveBeenCalledExactlyOnceWith({
    type: "session",
    sessionId: "session_a",
    title: "First title",
  })
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  openRename()
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "New draft" },
  })
  await act(async () => finish?.(true))
  expect(
    screen.getByRole("dialog", { name: "Rename conversation" }),
  ).toBeDefined()
  expect(
    (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
  ).toBe("New draft")
})

it("dismisses a dialog only for a fresh unmodified non-composing Escape", () => {
  const close = vi.fn()
  render(
    <SidebarDialog title="Rename" onClose={close} dismissImmediately>
      <input aria-label="Title" />
    </SidebarDialog>,
  )
  const input = screen.getByRole("textbox", { name: "Title" })
  for (const detail of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
  ]) {
    fireEvent.keyDown(input, { key: "Escape", ...detail })
    expect(close).not.toHaveBeenCalled()
  }
  fireEvent.keyDown(input, { key: "Escape" })
  expect(close).toHaveBeenCalledOnce()
})
