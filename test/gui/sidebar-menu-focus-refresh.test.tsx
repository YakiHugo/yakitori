// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionItems } from "../../src/gui/components/sidebar-sessions.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

beforeEach(() => {
  fakeRef.current = new FakeRpcClient()
  window.localStorage.clear()
  useAppStore.setState({
    ...createInitialAppState(),
    sidebar: {
      sections: [
        { id: "work", name: "Work" },
        { id: "old", name: "Deleted section" },
      ],
      entries: {},
    },
    sessionsByProject: {
      project_1: {
        sessions: [
          {
            id: "session_1",
            conversationId: "session_1",
            seq: 1,
            title: "My conversation",
            createdAt: "2026-10-08T00:00:00Z",
            updatedAt: "2026-10-08T00:00:00Z",
          },
        ],
      },
    },
  })
})
afterEach(cleanup)

it("preserves keyboard dismissal when a focused section disappears during refresh", async () => {
  const user = userEvent.setup()
  render(<SessionItems projectId="project_1" />)
  await user.click(
    screen.getByRole("button", { name: "Session actions for My conversation" }),
  )
  screen.getByRole("menuitem", { name: "Move to section" }).focus()
  await user.keyboard("{ArrowRight}{End}")
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Deleted section" }),
  )
  fakeRef.current.sidebarResponse = {
    sections: [{ id: "work", name: "Work" }],
    entries: {},
  }
  await act(async () => useAppStore.getState().loadSidebar())
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", {
        name: "Session actions for My conversation",
      }),
    ).toBeNull(),
  )
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Session actions for My conversation" }),
  )
})
