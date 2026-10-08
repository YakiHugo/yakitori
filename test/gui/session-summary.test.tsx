// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionSummary } from "../../src/gui/components/session-summary.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import type { GitStatusResponse } from "../../src/server/workspace.ts"
import { inputParts } from "./input-fixtures.ts"

const { request, listAgents, openUrlTarget } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  openUrlTarget: vi.fn(),
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/open-resource.ts", () => ({ openUrlTarget }))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request: (method: string, params: Record<string, unknown>) =>
      method === "agent/list" ? listAgents(params) : request(method, params),
    subscribeToSessionActivity: () => () => {},
    subscribeToSidebarChanges: () => () => {},
  }),
}))

function session(id = "session-1", cwd = "/repo"): ApiSessionDetail {
  return {
    id,
    conversationId: "conversation-1",
    workingDirectory: cwd,
    title: "Build the context panel",
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    seq: 1,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      turns: 0,
      inputs: 0,
      tools: 0,
      pendingInputs: 0,
      items: 0,
      permissions: 0,
    },
  }
}

beforeEach(() => {
  request.mockReset()
  listAgents.mockReset().mockResolvedValue({ agents: [] })
  openUrlTarget.mockReset().mockResolvedValue(undefined)
  request.mockImplementation(async (method) =>
    method === "git/pullRequests"
      ? { available: true, pullRequests: [] }
      : { repository: true, branch: "main", entries: [] },
  )
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "session-1" },
    selectedSession: session(),
    apiBase: "http://localhost",
  })
  useWorkspaceStore.setState({ open: false, tabs: [], activeId: undefined })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

it("loads real status on demand and opens the changes workspace", async () => {
  request.mockImplementation(async (method) =>
    method === "git/pullRequests"
      ? { available: true, pullRequests: [] }
      : {
          repository: true,
          branch: "feat/context",
          entries: [
            { path: "both.ts", indexStatus: "M", worktreeStatus: "M" },
            { path: "new.ts", indexStatus: "?", worktreeStatus: "?" },
            { path: "removed.ts", indexStatus: "D", worktreeStatus: " " },
          ],
        },
  )
  const user = userEvent.setup()
  render(<SessionSummary />)
  expect(request).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Session context" }))
  const dialog = await screen.findByRole("dialog", { name: "Session context" })
  expect(within(dialog).getByText("Local")).toBeDefined()
  expect(within(dialog).getByText("/repo")).toBeDefined()
  expect(await within(dialog).findByText("feat/context")).toBeDefined()
  expect(
    within(dialog).getByText("2 staged · 1 unstaged · 1 untracked"),
  ).toBeDefined()
  await user.click(
    within(dialog).getByRole("button", { name: /3 changed files/ }),
  )
  expect(request).toHaveBeenCalledWith("git/status", { cwd: "/repo" })
  expect(useWorkspaceStore.getState().open).toBe(true)
  expect(useWorkspaceStore.getState().tabs[0]?.kind).toBe("changes")
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("keeps the session branch stable and shows current and historical PRs", async () => {
  useAppStore.setState({
    selectedSession: {
      ...session(),
      gitInfo: {
        sha: "0123456789abcdef",
        branch: "feat/session-context",
        originUrl: "https://github.com/example/project.git",
      },
    },
  })
  request.mockImplementation(async (method, params) => {
    if (method === "git/pullRequests") {
      expect(params).toEqual({
        cwd: "/repo",
        branch: "feat/session-context",
      })
      return {
        available: true,
        pullRequests: [
          {
            number: 12,
            title: "Current work",
            state: "OPEN",
            isDraft: true,
            url: "https://github.com/example/project/pull/12",
            headRefName: "feat/session-context",
            updatedAt: "2026-09-22T00:00:00Z",
          },
          {
            number: 7,
            title: "Earlier approach",
            state: "MERGED",
            isDraft: false,
            url: "https://github.com/example/project/pull/7",
            headRefName: "feat/session-context",
            updatedAt: "2026-09-20T00:00:00Z",
          },
        ],
      }
    }
    return { repository: true, branch: "unrelated-checkout", entries: [] }
  })

  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))

  expect(await screen.findByText("feat/session-context")).toBeDefined()
  expect(
    screen.getByText("Workspace is currently on unrelated-checkout"),
  ).toBeDefined()
  expect(screen.getByText("#12 Current work")).toBeDefined()
  expect(screen.getByText("Draft")).toBeDefined()
  expect(screen.getByText("#7 Earlier approach")).toBeDefined()
  expect(screen.getByText("Merged")).toBeDefined()
  await user.click(screen.getByRole("link", { name: /#12 Current work/ }))
  expect(openUrlTarget).toHaveBeenCalledWith({
    kind: "url",
    url: "https://github.com/example/project/pull/12",
  })
})

it("shows submitted sources once and expands their original content", async () => {
  const excerpt = {
    id: "excerpt-1",
    kind: "selection" as const,
    text: "export const answer = 42",
    source: {
      kind: "file" as const,
      label: "answer.ts",
      path: "src/answer.ts",
    },
  }
  const attachment = {
    name: "reference.png",
    mediaType: "image/png" as const,
    sizeBytes: 42,
    file: {
      rolloutId: "rollout-1",
      path: "attachments/staging/images/reference.png",
    },
  }
  useAppStore.setState((state) => ({
    promptExcerpts: [
      {
        ...excerpt,
        id: "draft",
        source: { ...excerpt.source, label: "Unsent source" },
      },
    ],
    execution: {
      ...state.execution,
      entries: ["input-1", "input-2"].map((inputId) => ({
        kind: "user_input" as const,
        inputId,
        text: "Use these sources",
        at: "2026-09-20T00:00:00Z",

        contextAttachments: [excerpt],
        content: inputParts("Use these sources", [attachment]),
      })),
    },
  }))
  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  expect(screen.getByRole("heading", { name: "Sources 2" })).toBeDefined()
  expect(screen.queryByText("Unsent source")).toBeNull()
  const source = screen.getByText("answer.ts")
  await user.click(source)
  expect(source.closest("details")?.open).toBe(true)
  expect(screen.getByText("export const answer = 42")).toBeDefined()
  expect(screen.getByText("src/answer.ts")).toBeDefined()
  await user.click(screen.getByText("reference.png"))
  expect(
    screen.getByRole("img", { name: "reference.png" }).getAttribute("src"),
  ).toBe(
    "http://localhost/rollouts/rollout-1/assets/attachments/staging/images/reference.png",
  )
})

it("shows the previous provider's cache policy and keeps minimum retention distinct from estimated expiry", async () => {
  const user = userEvent.setup()
  const completedAt = new Date(Date.now() - 60_000).toISOString()
  useAppStore.setState({
    selectedSession: {
      ...session(),
      cacheExpiry: {
        provider: "anthropic",
        lastTurnCompletedAt: completedAt,
        lastRequestStartedAt: new Date(Date.now() - 90_000).toISOString(),
        ttlDescription: "5-minute ephemeral cache",
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        status: "estimated",
      },
    },
  })
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  expect(screen.getByText("Possibly cached")).toBeDefined()
  expect(screen.getByText(/Last turn: anthropic/)).toBeDefined()
  expect(screen.getByText(/Last model request started:/)).toBeDefined()
  expect(screen.getByText(/Estimated expiry/)).toBeDefined()
  act(() =>
    useAppStore.setState({
      selectedSession: {
        ...session(),
        cacheExpiry: {
          provider: "openai",
          lastTurnCompletedAt: completedAt,
          ttlDescription: "Minimum 30-minute retention",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          status: "minimum",
        },
      },
    }),
  )
  expect(screen.getByText("Retention uncertain")).toBeDefined()
  expect(screen.getByText(/Estimated earliest expiry/)).toBeDefined()
  expect(screen.queryByText("Likely expired")).toBeNull()
})

it("refreshes the cache summary after a live turn completes", async () => {
  let completed = false
  request.mockImplementation(async (method) => {
    if (method === "session/read")
      return {
        session: {
          ...session(),
          ...(completed
            ? {
                cacheExpiry: {
                  provider: "anthropic",
                  lastTurnCompletedAt: "2026-09-20T00:00:00Z",
                  lastRequestStartedAt: "2026-09-19T23:59:00Z",
                  ttlDescription: "5 minutes after last use",
                  expiresAt: "2026-09-20T00:04:00Z",
                  status: "estimated",
                },
              }
            : {}),
        },
      }
    if (method === "git/pullRequests")
      return { available: true, pullRequests: [] }
    return { repository: true, branch: "main", entries: [] }
  })
  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  expect(
    screen.getByText("No completed provider turn in this session yet."),
  ).toBeDefined()
  completed = true
  act(() =>
    useAppStore.setState((state) => ({
      execution: {
        ...state.execution,
        telemetry: { ...state.execution.telemetry, turns: 1 },
      },
    })),
  )
  expect(await screen.findByText("Likely expired")).toBeDefined()
  expect(screen.getByText(/Last turn: anthropic/)).toBeDefined()
})

it("dismisses on Escape and outside clicks, restoring keyboard focus on Escape", async () => {
  const user = userEvent.setup()
  render(
    <>
      <SessionSummary />
      <button type="button">Outside</button>
    </>,
  )
  const trigger = screen.getByRole("button", { name: "Session context" })
  await user.click(trigger)
  expect(document.activeElement).toBe(screen.getByRole("dialog"))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await user.click(trigger)
  await user.click(screen.getByRole("button", { name: "Outside" }))
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("discards previous session requests and closes the popover on selection", async () => {
  let resolvePrevious!: (status: GitStatusResponse) => void
  request.mockImplementation(async (_method, params) =>
    params.cwd === "/repo"
      ? new Promise<GitStatusResponse>((resolve) => {
          resolvePrevious = resolve
        })
      : { repository: true, branch: "current", entries: [] },
  )
  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  await screen.findByText("Loading changes…")
  act(() =>
    useAppStore.setState({
      selection: { sessionId: "session-2" },
      selectedSession: session("session-2", "/next"),
    }),
  )
  expect(screen.queryByRole("dialog")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Session context" }))
  await screen.findByText("current")
  await act(async () =>
    resolvePrevious({ repository: true, branch: "stale", entries: [] }),
  )
  expect(screen.queryByText("stale")).toBeNull()
  expect(screen.getByText("/next")).toBeDefined()
})

it("hides the old session's context until the newly selected session loads", () => {
  const { rerender } = render(<SessionSummary />)
  expect(screen.getByRole("button", { name: "Session context" })).toBeDefined()
  act(() => useAppStore.setState({ selection: { sessionId: "session-2" } }))
  expect(screen.queryByRole("button", { name: "Session context" })).toBeNull()
  act(() =>
    useAppStore.setState({
      selectedSession: session("session-2", "/next"),
    }),
  )
  rerender(<SessionSummary />)
  expect(screen.getByRole("button", { name: "Session context" })).toBeDefined()
})

it("refreshes at turn completion and retries failures without claiming a clean tree", async () => {
  useAppStore.setState((state) => ({
    execution: { ...state.execution, activeTurnId: "turn-1" },
  }))
  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  await screen.findByText("Working tree clean")
  request.mockRejectedValueOnce(new Error("Workspace unavailable"))
  act(() =>
    useAppStore.setState((state) => ({
      execution: { ...state.execution, activeTurnId: undefined },
    })),
  )
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Workspace unavailable",
  )
  expect(screen.queryByText("Working tree clean")).toBeNull()
  request.mockResolvedValue({ repository: false, entries: [] })
  await user.click(screen.getByRole("button", { name: "Retry" }))
  await screen.findByText("Not a Git repository")
  expect(screen.getByText("No Git changes available.")).toBeDefined()
  expect(
    screen.queryByRole("button", { name: /changed files|Working tree clean/ }),
  ).toBeNull()
})

it("opens the session's subagents without changing the main conversation", async () => {
  listAgents.mockResolvedValue({
    agents: [
      {
        agentId: "child-1",
        path: "/root/review",
        taskName: "review",
        status: { completed: "Reviewed" },
      },
      {
        agentId: "child-2",
        path: "/root/build",
        taskName: "build",
        status: "running",
      },
    ],
  })
  const user = userEvent.setup()
  render(<SessionSummary />)
  await user.click(screen.getByRole("button", { name: "Session context" }))
  expect(await screen.findByText("1 working · 1 completed")).toBeDefined()
  await user.click(screen.getByRole("button", { name: /2 subagents/ }))
  expect(useWorkspaceStore.getState()).toMatchObject({
    open: true,
    expanded: false,
    tabs: [{ kind: "agents", sourceSessionId: "session-1" }],
  })
  expect(useAppStore.getState().selectedSession?.id).toBe("session-1")
})

it("clears an invalidated pull-request load when refreshed Git status has no branch", async () => {
  let finishPrevious!: (value: unknown) => void
  let statusReads = 0
  request.mockImplementation(async (method) => {
    if (method === "session/read") return { session: session() }
    if (method === "git/pullRequests")
      return new Promise((resolve) => {
        finishPrevious = resolve
      })
    if (method === "git/status") {
      statusReads += 1
      return statusReads === 1
        ? { repository: true, branch: "old", entries: [] }
        : { repository: false, entries: [] }
    }
    throw new Error(`Unexpected method ${method}`)
  })
  render(<SessionSummary />)
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Session context" }))
  await screen.findByText("Loading pull requests…")
  fireEvent.focus(window)
  await screen.findByText("Not a Git repository")
  expect(screen.queryByText("Loading pull requests…")).toBeNull()
  await act(async () =>
    finishPrevious({
      available: true,
      pullRequests: [
        {
          number: 999,
          title: "Old request",
          state: "OPEN",
          isDraft: false,
          url: "https://example.com/pull/999",
          headRefName: "old",
          updatedAt: "2026-10-08T00:00:00Z",
        },
      ],
    }),
  )
  expect(screen.queryByText(/Old request/)).toBeNull()
  expect(screen.queryByText("Loading pull requests…")).toBeNull()
})
