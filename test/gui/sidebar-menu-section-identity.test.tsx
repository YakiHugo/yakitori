// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
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

it("preserves section identity when duplicate display labels reorder during live refresh", async () => {
  const changeSidebar = vi.fn().mockResolvedValue(true)
  useAppStore.setState({
    changeSidebar,
    sidebar: {
      sections: [
        { id: "a", name: "Work" },
        { id: "b", name: "Work" },
        { id: "c", name: "Other" },
      ],
      entries: {},
    },
  })
  const user = userEvent.setup()
  render(<SessionItems projectId="project_1" />)
  await user.click(
    screen.getByRole("button", { name: "Session actions for My conversation" }),
  )
  screen.getByRole("menuitem", { name: "Move to section" }).focus()
  await user.keyboard("{ArrowRight}")
  expect(screen.getAllByRole("menuitemradio", { name: "Work" })).toHaveLength(2)
  fakeRef.current.sidebarResponse = {
    sections: [
      { id: "c", name: "Other" },
      { id: "a", name: "Work" },
      { id: "b", name: "Work" },
    ],
    entries: {},
  }
  await act(async () => useAppStore.getState().loadSidebar())
  expect(screen.getAllByRole("menuitemradio", { name: "Work" })).toHaveLength(2)
  expect(
    screen.getAllByRole("menuitemradio").map((button) => button.textContent),
  ).toEqual(["Projects / All sessions", "Pinned", "Other", "Work", "Work"])
  const secondWork = screen.getAllByRole("menuitemradio", { name: "Work" })[1]
  if (!secondWork) throw new Error("Missing second Work section")
  await user.click(secondWork)
  expect(changeSidebar).toHaveBeenCalledExactlyOnceWith({
    type: "session",
    sessionId: "session_1",
    sectionId: "b",
  })
})
