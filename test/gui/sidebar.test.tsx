// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import type {
  ApiProject,
  ApiSessionSummary,
} from "../../src/server/protocol.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

function project(
  id: string,
  name: string,
  input: { readonly roots?: readonly string[]; readonly pinned?: boolean } = {},
): ApiProject {
  return {
    id,
    name,
    roots: input.roots ?? [`/workspaces/${name}`],
    metadata: {},
    position: 0,
    pinned: input.pinned ?? false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(id: string, title: string): ApiSessionSummary {
  return {
    id,
    conversationId: id,
    seq: 1,
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    title,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("sidebar", () => {
  it("shows sessions under expanded projects and hides collapsed ones", () => {
    useAppStore.setState({
      projects: [project("project_1", "yakitori"), project("project_2", "bbq")],
      currentProject: "project_1",
      collapsedProjects: { project_2: true },
      sessionsByProject: {
        project_1: { sessions: [session("session_1", "fix the thing")] },
        project_2: { sessions: [session("session_2", "hidden work")] },
      },
    })
    render(<App />)

    expect(screen.getByRole("button", { name: "yakitori" })).toBeDefined()
    expect(screen.getByText("fix the thing")).toBeDefined()
    expect(screen.getByRole("button", { name: "bbq" })).toBeDefined()
    expect(screen.queryByText("hidden work")).toBeNull()
  })

  it("toggles a project from its row", async () => {
    const toggleProject = vi.fn()
    useAppStore.setState({
      projects: [project("project_1", "yakitori"), project("project_2", "bbq")],
      currentProject: "project_1",
      toggleProject,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "bbq" }))

    expect(toggleProject).toHaveBeenCalledWith("project_2")
  })

  it("opens a draft without creating an empty persistent session", async () => {
    const createSession = vi.fn()
    useAppStore.setState({ createSession })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByLabelText("New session"))

    expect(createSession).not.toHaveBeenCalled()
    expect(
      screen.getByRole("combobox", { name: "New session project" }),
    ).toBeDefined()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
  })

  it("confirms before deleting a session", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      sessionsByProject: {
        project_1: { sessions: [session("session_1", "fix the thing")] },
      },
      deleteSession,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Session actions for fix the thing" }),
    )
    await user.click(
      screen.getByRole("menuitem", { name: "Delete conversation" }),
    )
    expect(deleteSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(deleteSession).toHaveBeenCalledWith("session_1")
  })

  it("offers Show more only when the project session list has another page", async () => {
    const loadSessions = vi.fn()
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      sessionsByProject: {
        project_1: {
          sessions: [session("session_1", "fix the thing")],
          nextCursor: "cursor-1",
        },
      },
      loadSessions,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Show more" }))

    expect(loadSessions).toHaveBeenCalledWith("project_1", { append: true })
  })

  it("pins a project from its row menu", async () => {
    const toggleProjectPinned = vi.fn()
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      toggleProjectPinned,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Project actions for yakitori" }),
    )
    await user.click(screen.getByRole("menuitem", { name: /Pin/ }))

    expect(toggleProjectPinned).toHaveBeenCalledWith("project_1")
  })

  it("saves a renamed project from the edit dialog", async () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      updateProject,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Project actions for yakitori" }),
    )
    await user.click(screen.getByRole("menuitem", { name: "Edit project" }))
    const nameInput = screen.getByRole("textbox", { name: "Project name" })
    await user.clear(nameInput)
    await user.type(nameInput, "renamed")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(updateProject).toHaveBeenCalledWith("project_1", {
      name: "renamed",
    })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("saves edited source folders from the edit dialog", async () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    useAppStore.setState({
      projects: [
        project("project_1", "yakitori", {
          roots: ["/workspaces/yakitori", "/workspaces/extra"],
        }),
      ],
      currentProject: "project_1",
      updateProject,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Project actions for yakitori" }),
    )
    await user.click(screen.getByRole("menuitem", { name: "Edit project" }))
    await user.click(
      screen.getByRole("button", {
        name: "Remove folder /workspaces/extra",
      }),
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(updateProject).toHaveBeenCalledWith("project_1", {
      roots: ["/workspaces/yakitori"],
    })
  })

  it("removes a project after confirmation", async () => {
    const removeProject = vi.fn().mockResolvedValue(true)
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      removeProject,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Project actions for yakitori" }),
    )
    await user.click(screen.getByRole("menuitem", { name: "Edit project" }))
    await user.click(screen.getByRole("button", { name: "Remove project" }))
    expect(removeProject).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(removeProject).toHaveBeenCalledWith("project_1")
  })
})

it("reveals older project conversations without refetching already loaded rows", async () => {
  const loadSessions = vi.fn()
  useAppStore.setState({
    projects: [project("project_1", "yakitori")],
    currentProject: "project_1",
    sessionsByProject: {
      project_1: {
        sessions: Array.from({ length: 8 }, (_, index) =>
          session(`session_${index}`, `Conversation ${index + 1}`),
        ),
      },
      "sidebar:section:pinned": { sessions: [] },
    },
    loadSessions,
  })
  const user = userEvent.setup()
  render(<App />)
  expect(screen.getByRole("button", { name: "Conversation 5" })).toBeDefined()
  expect(screen.queryByRole("button", { name: "Conversation 6" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "Show more" }))
  expect(screen.getByRole("button", { name: "Conversation 8" })).toBeDefined()
  expect(loadSessions).not.toHaveBeenCalled()
})

it("moves a conversation through a keyboard-accessible section submenu", async () => {
  const changeSidebar = vi.fn().mockResolvedValue(true)
  useAppStore.setState({
    projects: [project("project_1", "yakitori")],
    currentProject: "project_1",
    sidebar: { sections: [{ id: "section_work", name: "Work" }], entries: {} },
    sessionsByProject: {
      project_1: { sessions: [session("session_1", "My conversation")] },
      "sidebar:section:pinned": { sessions: [] },
      "sidebar:section:section_work": { sessions: [] },
    },
    changeSidebar,
  })
  const user = userEvent.setup()
  render(<App />)
  await user.click(
    screen.getByRole("button", { name: "Session actions for My conversation" }),
  )
  screen.getByRole("menuitem", { name: "Move to section" }).focus()
  await user.keyboard("{ArrowRight}")
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Projects / All sessions" }),
  )
  await user.keyboard("{ArrowLeft}")
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Move to section" }),
  )
  await user.keyboard("{ArrowRight}{End}{Enter}")
  expect(changeSidebar).toHaveBeenCalledExactlyOnceWith({
    type: "session",
    sessionId: "session_1",
    sectionId: "section_work",
  })
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("keeps the folder path visible when adding a project fails and allows retry", async () => {
  const addProject = vi.fn().mockImplementation(async () => {
    useAppStore.setState({ message: "This folder does not exist." })
    return false
  })
  useAppStore.setState({ addProject })
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole("button", { name: "Add project" }))
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "My project",
  )
  const path = screen.getByRole("textbox", { name: "Project path" })
  const dialog = within(screen.getByRole("dialog", { name: "Create project" }))
  await user.type(path, "/missing-project")
  await user.click(dialog.getByRole("button", { name: "Create project" }))
  expect((path as HTMLInputElement).value).toBe("/missing-project")
  expect(screen.getByRole("dialog", { name: "Create project" })).toBeDefined()
  expect(dialog.getByRole("alert").textContent).toBe(
    "This folder does not exist.",
  )
  addProject.mockResolvedValueOnce(true)
  await user.clear(path)
  await user.type(path, "/valid-project")
  await user.click(dialog.getByRole("button", { name: "Create project" }))
  expect(addProject).toHaveBeenLastCalledWith("/valid-project", "My project")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Message the Mate" }),
  )
})

it("cancelling the native folder picker leaves the current conversation untouched", async () => {
  const addProject = vi.fn()
  const pickProjectFolder = vi.fn().mockResolvedValue(null)
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { pickProjectFolder },
  })
  useAppStore.setState({
    addProject,
    selection: { sessionId: "session_current" },
    promptDraft: "keep my draft",
  })
  try {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Add project" }))
    expect(pickProjectFolder).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole("button", {
        name: "Add a folder Yakitori can read and edit",
      }),
    )
    expect(pickProjectFolder).toHaveBeenCalledOnce()
    expect(addProject).not.toHaveBeenCalled()
    expect(useAppStore.getState().selection.sessionId).toBe("session_current")
    expect(useAppStore.getState().promptDraft).toBe("keep my draft")
    expect(screen.getByRole("dialog", { name: "Create project" })).toBeDefined()
  } finally {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
  }
})

it("selecting a source folder waits for explicit creation and preserves the chosen name", async () => {
  const addProject = vi.fn().mockResolvedValue(true)
  const pickProjectFolder = vi.fn().mockResolvedValue("/workspaces/example")
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { pickProjectFolder },
  })
  useAppStore.setState({ addProject })
  try {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Add project" }))
    const dialog = within(
      screen.getByRole("dialog", { name: "Create project" }),
    )
    await user.type(
      dialog.getByRole("textbox", { name: "Project name" }),
      "My app",
    )
    await user.click(
      dialog.getByRole("button", {
        name: "Add a folder Yakitori can read and edit",
      }),
    )
    expect(addProject).not.toHaveBeenCalled()
    expect(
      (
        dialog.getByRole("textbox", {
          name: "Project name",
        }) as HTMLInputElement
      ).value,
    ).toBe("My app")
    expect(
      dialog.getByRole("button", { name: "Change source folder" }).textContent,
    ).toContain("/workspaces/example")
    await user.click(
      dialog.getByRole("button", { name: "Remove source folder" }),
    )
    expect(
      (
        dialog.getByRole("button", {
          name: "Create project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    await user.click(
      dialog.getByRole("button", {
        name: "Add a folder Yakitori can read and edit",
      }),
    )
    await user.click(dialog.getByRole("button", { name: "Create project" }))
    expect(addProject).toHaveBeenCalledExactlyOnceWith(
      "/workspaces/example",
      "My app",
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  } finally {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
  }
})
