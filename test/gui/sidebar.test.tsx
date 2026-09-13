// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
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

function project(id: string, name: string): ApiProject {
  return {
    id,
    name,
    roots: [`/workspaces/${name}`],
    metadata: {},
    position: 0,
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
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("sidebar", () => {
  it("expands sessions under the current project only", () => {
    useAppStore.setState({
      projects: [project("project_1", "yakitori"), project("project_2", "bbq")],
      currentProject: "project_1",
      sessions: [session("session_1", "fix the thing")],
    })
    render(<App />)

    expect(screen.getByRole("button", { name: "yakitori" })).toBeDefined()
    expect(screen.getByRole("button", { name: "bbq" })).toBeDefined()
    expect(screen.getByText("fix the thing")).toBeDefined()
  })

  it("selects a project from its row", async () => {
    const selectProject = vi.fn()
    useAppStore.setState({
      projects: [project("project_1", "yakitori"), project("project_2", "bbq")],
      currentProject: "project_1",
      sessions: [],
      selectProject,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "bbq" }))

    expect(selectProject).toHaveBeenCalledWith("project_2")
  })

  it("creates a session from the New session row", async () => {
    const createSession = vi.fn()
    useAppStore.setState({ createSession })
    const user = userEvent.setup()
    render(<App />)

    // The sidebar row owns the aria-label; EmptyState's button is text-only.
    await user.click(screen.getByLabelText("New session"))

    expect(createSession).toHaveBeenCalledOnce()
  })

  it("confirms before deleting a session", async () => {
    const deleteSession = vi.fn()
    useAppStore.setState({
      sessions: [session("session_1", "fix the thing")],
      deleteSession,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Delete conversation" }))
    expect(deleteSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(deleteSession).toHaveBeenCalledWith("session_1")
  })

  it("offers Show more only when the session list has another page", async () => {
    const loadSessions = vi.fn()
    useAppStore.setState({
      sessions: [session("session_1", "fix the thing")],
      nextCursor: "cursor-1",
      loadSessions,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Show more" }))

    expect(loadSessions).toHaveBeenCalledWith({ append: true })
  })
})
