// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkspaceChanges } from "../../src/gui/components/workspace-changes.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../src/protocol/workspace.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

const status: GitStatusResponse = {
  repository: true,
  branch: "feat/review",
  entries: [
    {
      path: "src/both.ts",
      indexStatus: "M",
      worktreeStatus: "M",
      stagedStats: { additions: 4, deletions: 2, binary: false },
      unstagedStats: { additions: 7, deletions: 3, binary: false },
    },
    { path: "src/ready.ts", indexStatus: "A", worktreeStatus: " " },
    ...["three", "four", "five", "six"].map((name) => ({
      path: `src/${name}.ts`,
      indexStatus: "?",
      worktreeStatus: "?",
    })),
  ],
}

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
  useWorkspaceStore.setState({
    tabs: [{ id: "changes", kind: "changes" }],
    sessionId: undefined,
    presentationBySession: {
      "": { open: false, expanded: false, activeId: "changes" },
    },
  })
  request.mockReset().mockImplementation(async (method, params) => {
    if (method === "git/status") return status
    if (method === "git/diff")
      return {
        path: params.path,
        text: `${params.staged ? "staged" : "unstaged"} patch ${params.path}`,
        truncated: false,
      }
    throw new Error(`Unexpected method ${method}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("shows staged and unstaged files together and selects one diff at a time", async () => {
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  const selected = await screen.findByRole("region", {
    name: "Unstaged changes in src/both.ts",
  })
  expect(
    (
      screen.getByRole("combobox", {
        name: "Change scope",
      }) as HTMLSelectElement
    ).value,
  ).toBe("all")
  expect(screen.getByText("6 changed files")).toBeDefined()
  expect(
    screen
      .getByRole("button", { name: "src/both.ts, unstaged" })
      .getAttribute("aria-current"),
  ).toBe("true")
  expect(
    screen.getByRole("button", { name: "src/ready.ts, staged" }),
  ).toBeDefined()
  expect(
    await within(selected).findByText("unstaged patch src/both.ts"),
  ).toBeDefined()
  expect(screen.getByText("+11")).toBeDefined()
  expect(screen.getByText("−5")).toBeDefined()
  await user.click(screen.getByRole("button", { name: "src/both.ts, staged" }))
  expect(
    await within(
      screen.getByRole("region", { name: "Staged changes in src/both.ts" }),
    ).findByText("staged patch src/both.ts"),
  ).toBeDefined()
  expect(screen.queryByText("unstaged patch src/both.ts")).toBeNull()
  expect(screen.getAllByRole("region", { name: "File diff" })).toHaveLength(1)
})

it.each([
  {
    entry: {
      path: "image.png",
      indexStatus: " ",
      worktreeStatus: "M",
      unstagedStats: { additions: 0, deletions: 0, binary: true },
    },
    patch: "Binary files a/image.png and b/image.png differ",
    message: "Binary file changed. A text diff is unavailable.",
  },
  {
    entry: {
      path: "new.ts",
      originalPath: "old.ts",
      indexStatus: "R",
      worktreeStatus: " ",
      stagedStats: { additions: 0, deletions: 0, binary: false },
    },
    patch:
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts",
    message: "Renamed without line changes.",
  },
])("explains non-text changes: $message", async ({ entry, patch, message }) => {
  request.mockImplementation(async (method) =>
    method === "git/status"
      ? { repository: true, entries: [entry] }
      : { path: entry.path, text: patch, truncated: false },
  )
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  expect(await screen.findByText(message)).toBeDefined()
  expect(screen.queryByRole("region", { name: "File diff" })).toBeNull()
  if (entry.originalPath)
    expect(
      screen.getByText(`Staged · ${entry.originalPath} → ${entry.path}`),
    ).toBeDefined()
})

it("clears review filters and selects the requested file diff", async () => {
  const user = userEvent.setup()
  const view = render(
    <WorkspaceChanges cwd="/repo" apiBase="http://localhost" />,
  )
  const filter = await screen.findByRole("textbox", {
    name: "Filter changed files",
  })
  await screen.findByText("unstaged patch src/both.ts")
  const scope = screen.getByRole("combobox", { name: "Change scope" })
  await user.selectOptions(scope, "staged")
  await user.type(filter, "missing")
  expect(
    within(
      screen.getByRole("region", { name: "Selected file changes" }),
    ).getByText("No matching files"),
  ).toBeDefined()
  view.rerender(
    <WorkspaceChanges
      cwd="/repo"
      apiBase="http://localhost"
      target={{ path: "src/five.ts", staged: false, requestId: "review-1" }}
    />,
  )
  const target = await screen.findByRole("button", {
    name: "src/five.ts, unstaged",
  })
  expect((filter as HTMLInputElement).value).toBe("")
  expect((scope as HTMLSelectElement).value).toBe("all")
  expect(target.getAttribute("aria-current")).toBe("true")
  expect(await screen.findByText("unstaged patch src/five.ts")).toBeDefined()
  expect(screen.queryByText("unstaged patch src/both.ts")).toBeNull()
  expect(
    screen.getByRole("region", { name: "Unstaged changes in src/five.ts" }),
  ).toBeDefined()
})

it("resets scope, query, and selection on every review-all request", async () => {
  function StoredChanges() {
    const tab = useWorkspaceStore((state) =>
      state.tabs.find((item) => item.kind === "changes"),
    )
    return (
      <WorkspaceChanges
        cwd="/repo"
        apiBase="http://localhost"
        target={tab?.target}
      />
    )
  }
  useWorkspaceStore.getState().openChanges("src/five.ts", false)
  const user = userEvent.setup()
  render(<StoredChanges />)
  await screen.findByText("unstaged patch src/five.ts")
  const scope = screen.getByRole("combobox", { name: "Change scope" })
  const query = screen.getByRole("textbox", { name: "Filter changed files" })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await user.selectOptions(scope, "staged")
    await user.type(query, "missing")
    expect(
      within(
        screen.getByRole("region", { name: "Selected file changes" }),
      ).getByText("No matching files"),
    ).toBeDefined()
    act(() => useWorkspaceStore.getState().openChanges())
    await screen.findByText("unstaged patch src/both.ts")
    expect((scope as HTMLSelectElement).value).toBe("all")
    expect((query as HTMLInputElement).value).toBe("")
    expect(
      screen
        .getByRole("button", { name: "src/both.ts, unstaged" })
        .getAttribute("aria-current"),
    ).toBe("true")
    expect(
      screen.getByRole("button", { name: "src/ready.ts, staged" }),
    ).toBeDefined()
  }
})

it("removes the previous patch when refreshed status cannot load its diff", async () => {
  let statusReads = 0
  let diffReads = 0
  request.mockImplementation(async (method) => {
    if (method === "git/status") {
      statusReads += 1
      return {
        repository: true,
        branch: "main",
        entries: [
          {
            path: "changed.ts",
            indexStatus: " ",
            worktreeStatus: "M",
            unstagedStats: {
              additions: statusReads === 1 ? 1 : 12,
              deletions: 0,
              binary: false,
            },
          },
        ],
      }
    }
    if (method === "git/diff") {
      diffReads += 1
      if (diffReads > 1) throw new Error("Could not read refreshed diff")
      return { path: "changed.ts", text: "Previous patch", truncated: false }
    }
    throw new Error(`Unexpected method ${method}`)
  })
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await screen.findByText("Previous patch")
  await user.click(screen.getByRole("button", { name: "Refresh changes" }))
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not read refreshed diff",
  )
  const selected = screen.getByRole("region", {
    name: "Unstaged changes in changed.ts",
  })
  expect(within(selected).getByText("+12")).toBeDefined()
  expect(screen.queryByText("Previous patch")).toBeNull()
  expect(
    within(selected).queryByRole("region", { name: "File diff" }),
  ).toBeNull()
})

it("refreshes the displayed status after staging completes", async () => {
  let staged = false
  request.mockImplementation(async (method, params) => {
    if (method === "git/stage") {
      staged = true
      return {}
    }
    if (method === "git/status")
      return {
        repository: true,
        branch: "main",
        entries: [
          {
            path: "src/changed.ts",
            indexStatus: staged ? "M" : " ",
            worktreeStatus: staged ? " " : "M",
          },
        ],
      }
    if (method === "git/diff")
      return { path: params.path, text: "Changed content", truncated: false }
    throw new Error(`Unexpected method ${method}`)
  })
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await user.click(
    await screen.findByRole("button", { name: "Stage src/changed.ts" }),
  )
  expect(
    await screen.findByRole("button", { name: "Unstage src/changed.ts" }),
  ).toBeDefined()
  expect(
    screen.queryByRole("button", { name: "src/changed.ts, unstaged" }),
  ).toBeNull()
  expect(
    screen
      .getByRole("button", { name: "src/changed.ts, staged" })
      .getAttribute("aria-current"),
  ).toBe("true")
  expect(
    screen.getByRole("region", { name: "Staged changes in src/changed.ts" }),
  ).toBeDefined()
})

it("ignores a previous side's diff after selecting the staged file", async () => {
  let previousDiff!: (diff: GitDiffResponse) => void
  request.mockImplementation(async (method, params) => {
    if (method === "git/status") return status
    if (method === "git/diff") {
      if (!params.staged)
        return new Promise<GitDiffResponse>((resolve) => {
          previousDiff = resolve
        })
      return {
        path: params.path,
        text: "Current staged patch",
        truncated: false,
      }
    }
    throw new Error(`Unexpected method ${method}`)
  })
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await screen.findByText("Loading diff…")
  await user.click(screen.getByRole("button", { name: "src/both.ts, staged" }))
  await screen.findByText("Current staged patch")
  await act(async () => {
    previousDiff({
      path: "src/both.ts",
      text: "Old unstaged patch",
      truncated: false,
    })
  })
  expect(screen.getByText("Current staged patch")).toBeDefined()
  expect(screen.queryByText("Old unstaged patch")).toBeNull()
})

it("ignores status and diff responses from previous workspace scopes", async () => {
  let previousStatus!: (status: GitStatusResponse) => void
  let previousDiff!: (diff: GitDiffResponse) => void
  request.mockImplementation(async (method, params) => {
    if (method === "git/status") {
      if (params.cwd === "/first")
        return new Promise<GitStatusResponse>((resolve) => {
          previousStatus = resolve
        })
      return {
        repository: true,
        branch: params.cwd === "/second" ? "second" : "current",
        entries: [{ path: "same.ts", indexStatus: " ", worktreeStatus: "M" }],
      }
    }
    if (method === "git/diff") {
      if (params.cwd === "/second")
        return new Promise<GitDiffResponse>((resolve) => {
          previousDiff = resolve
        })
      return { path: "same.ts", text: "Current patch", truncated: false }
    }
    throw new Error(`Unexpected method ${method}`)
  })
  const view = render(
    <WorkspaceChanges cwd="/first" apiBase="http://localhost" />,
  )
  view.rerender(<WorkspaceChanges cwd="/second" apiBase="http://localhost" />)
  await screen.findByText("Loading diff…")
  view.rerender(<WorkspaceChanges cwd="/third" apiBase="http://localhost" />)
  await screen.findByText("Current patch")
  await act(async () => {
    previousStatus({ repository: true, branch: "stale", entries: [] })
    previousDiff({ path: "same.ts", text: "Stale patch", truncated: false })
  })
  expect(screen.getByText("current")).toBeDefined()
  expect(screen.getByText("Current patch")).toBeDefined()
  expect(screen.queryByText("stale")).toBeNull()
  expect(screen.queryByText("Stale patch")).toBeNull()
})
