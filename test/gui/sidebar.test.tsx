// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import type {
  ApiProject,
  ApiSessionSummary,
  ApiSubscriptionSummary,
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

  it("surfaces a project-list load failure with a retry action", async () => {
    const loadProjects = vi.fn(async () => {})
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      projectsError: "Could not load projects.",
      loadProjects,
    })
    render(<App />)

    expect(screen.getByText("Could not load projects.")).toBeDefined()
    // The last good list stays visible behind the error note.
    expect(screen.getByRole("button", { name: "yakitori" })).toBeDefined()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(loadProjects).toHaveBeenCalledOnce()
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

  it("opens the account panel with live subscription states", async () => {
    const loadSubscriptions = vi.fn().mockResolvedValue(undefined)
    const subscriptions = [
      {
        provider: "codex",
        displayName: "Codex",
        availability: "available",
        credentialKind: "oauth",
        plan: "pro",
        usage: {
          status: "available",
          buckets: [
            {
              name: "Codex · 5-hour limit",
              usedPercent: 42,
              resetsAt: Date.now() + 3_600_000,
            },
          ],
        },
      },
      {
        provider: "grok",
        displayName: "Grok",
        availability: "available",
        credentialKind: "oauth",
        usage: { status: "unavailable" },
      },
      {
        provider: "kimi",
        displayName: "Kimi",
        availability: "requires_login",
        usage: { status: "unavailable" },
      },
    ] as const satisfies readonly ApiSubscriptionSummary[]
    useAppStore.setState({
      subscriptionsByProvider: {
        codex: {
          subscription: subscriptions[0],
          loading: false,
          updatedAt: Date.now(),
        },
        grok: {
          subscription: subscriptions[1],
          loading: true,
          updatedAt: Date.now(),
        },
        kimi: {
          subscription: subscriptions[2],
          loading: false,
          updatedAt: Date.now(),
        },
      },
      loadSubscriptions,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByLabelText("Open subscription usage"))

    expect(
      screen.getByRole("dialog", { name: "Account & usage" }),
    ).toBeDefined()
    expect(screen.getByText("Pro plan")).toBeDefined()
    expect(screen.getByText("42% used")).toBeDefined()
    expect(
      screen.getByRole("progressbar", {
        name: "Codex · 5-hour limit: 42% used",
      }),
    ).toBeDefined()
    expect(
      screen.getByText(
        "This provider does not currently expose subscription limits here.",
      ),
    ).toBeDefined()
    expect(screen.getByText("Not connected")).toBeDefined()
    const codexCard = screen
      .getByRole("heading", { name: "Codex" })
      .closest("section")
    const grokCard = screen
      .getByRole("heading", { name: "Grok" })
      .closest("section")
    expect(codexCard?.getAttribute("aria-busy")).toBe("false")
    expect(grokCard?.getAttribute("aria-busy")).toBe("true")
    expect(within(grokCard as HTMLElement).getByText("Updating")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull()
    expect(loadSubscriptions).toHaveBeenCalledOnce()
  })

  it("does not present an API key connection as a subscription account", async () => {
    const loadSubscriptions = vi.fn().mockResolvedValue(undefined)
    const kimi: ApiSubscriptionSummary = {
      provider: "kimi",
      displayName: "Kimi",
      availability: "available",
      credentialKind: "api_key",
      usage: { status: "unavailable", reason: "not_supported" },
    }
    useAppStore.setState({
      subscriptionsByProvider: {
        codex: { loading: false },
        grok: { loading: false },
        kimi: { subscription: kimi, loading: false },
      },
      loadSubscriptions,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByLabelText("Open subscription usage"))

    const kimiCard = screen
      .getByRole("heading", { name: "Kimi" })
      .closest("section") as HTMLElement
    expect(within(kimiCard).getByText("API key connection")).toBeDefined()
    expect(within(kimiCard).getByText("API key connected")).toBeDefined()
    expect(
      within(kimiCard).getByText(
        "Subscription usage is not available for API key connections.",
      ),
    ).toBeDefined()
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
        project_1: { sessions: [session("session_1", "fix the thing")] },
      },
      loadSessions,
    })
    const user = userEvent.setup()
    render(<App />)

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()

    act(() => {
      useAppStore.setState({
        sessionsByProject: {
          project_1: {
            sessions: [session("session_1", "fix the thing")],
            nextCursor: "cursor-1",
          },
        },
      })
    })
    await user.click(screen.getByRole("button", { name: "Show more" }))

    expect(loadSessions).toHaveBeenCalledWith("project_1", { append: true })
  })

  it("selecting a conversation selects it in the store", async () => {
    const summary = session("session_1", "fix the thing")
    const selectSession = vi.fn()
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      sessionsByProject: { project_1: { sessions: [summary] } },
      selectSession,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "fix the thing" }))

    expect(selectSession).toHaveBeenCalledWith("session_1", summary)
  })

  it("expanding a project lazily loads its session list", async () => {
    const loadSessions = vi.fn()
    // Earlier tests replace toggleProject with a bare spy and the store keeps
    // mocked actions across resets, so restore the real toggle behavior here.
    const toggleProject = vi.fn(async (projectId: string) => {
      const collapsedProjects = {
        ...useAppStore.getState().collapsedProjects,
      }
      if (collapsedProjects[projectId] === true)
        delete collapsedProjects[projectId]
      else collapsedProjects[projectId] = true
      useAppStore.setState({ collapsedProjects })
    })
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      collapsedProjects: { project_1: true },
      sessionsByProject: { "sidebar:section:pinned": { sessions: [] } },
      loadSessions,
      toggleProject,
    })
    const user = userEvent.setup()
    render(<App />)

    expect(loadSessions).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "yakitori" }))
    expect(loadSessions).toHaveBeenCalledWith("project_1")

    loadSessions.mockClear()
    act(() => {
      useAppStore.setState({
        sessionsByProject: {
          project_1: { sessions: [session("session_1", "fix the thing")] },
          "sidebar:section:pinned": { sessions: [] },
        },
      })
    })
    await user.click(screen.getByRole("button", { name: "yakitori" }))
    await user.click(screen.getByRole("button", { name: "yakitori" }))

    expect(loadSessions).not.toHaveBeenCalled()
  })

  it("archives a conversation from its row menu", async () => {
    const changeSidebar = vi.fn().mockResolvedValue(true)
    useAppStore.setState({
      projects: [project("project_1", "yakitori")],
      currentProject: "project_1",
      sessionsByProject: {
        project_1: { sessions: [session("session_1", "fix the thing")] },
      },
      changeSidebar,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Session actions for fix the thing" }),
    )
    await user.click(
      screen.getByRole("menuitem", { name: "Archive conversation" }),
    )

    expect(changeSidebar).toHaveBeenCalledWith({
      type: "session",
      sessionId: "session_1",
      archived: true,
    })
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
