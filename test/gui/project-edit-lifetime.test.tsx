// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ApiProject } from "../../src/server/protocol.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

const project: ApiProject = {
  id: "project_1",
  name: "yakitori",
  roots: ["/workspaces/yakitori"],
  metadata: {},
  position: 0,
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  fakeRef.current = new FakeRpcClient()
  window.localStorage.clear()
  useAppStore.setState({
    ...createInitialAppState(),
    projects: [project],
    currentProject: project.id,
    sessionsByProject: {
      [project.id]: { sessions: [] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })
})
afterEach(cleanup)

it("keeps a reopened project draft when a dismissed editor's save completes", async () => {
  let resolveSaved!: () => void
  const saved = new Promise<void>((resolve) => {
    resolveSaved = resolve
  })
  fakeRef.current.respond = (method) => {
    if (method === "project/update") return saved
    if (method === "project/list")
      return { projects: [{ ...project, name: "First saved name" }] }
    throw new Error(`Unexpected request: ${method}`)
  }
  const user = userEvent.setup()
  render(<App />)
  await user.click(
    screen.getByRole("button", { name: "Project actions for yakitori" }),
  )
  await user.click(screen.getByRole("menuitem", { name: "Edit project" }))
  await user.clear(screen.getByRole("textbox", { name: "Project name" }))
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "First saved name",
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(fakeRef.current.requestsFor("project/update")[0]?.params).toEqual({
    projectId: project.id,
    name: "First saved name",
  })
  expect(useAppStore.getState().busy).toBe(true)
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  await user.click(
    screen.getByRole("button", { name: "Project actions for yakitori" }),
  )
  await user.click(screen.getByRole("menuitem", { name: "Edit project" }))
  await user.clear(screen.getByRole("textbox", { name: "Project name" }))
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "New unsaved draft",
  )

  await act(async () => resolveSaved())

  expect(useAppStore.getState().projects[0]?.name).toBe("First saved name")
  expect(
    screen.getByRole("dialog", { name: "Edit project First saved name" }),
  ).toBeDefined()
  expect(
    (screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement)
      .value,
  ).toBe("New unsaved draft")
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(false)
})
