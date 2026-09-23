// @vitest-environment happy-dom
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkspaceChanges } from "../../src/gui/components/workspace-changes.tsx"
import {
  WorkspaceFilePreview,
  WorkspaceFiles,
} from "../../src/gui/components/workspace-files.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type {
  GitDiffResponse,
  GitStatusResponse,
  WorkspaceListResponse,
} from "../../src/server/workspace.ts"
import { listWorkspaceDirectory } from "../../src/server/workspace.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

beforeEach(() => {
  request.mockReset()
  useAppStore.setState(createInitialAppState())
})
afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it("lists the real workspace root with a relative dot path on entry and re-expansion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "yakitori-workspace-panel-"))
  try {
    await mkdir(join(cwd, "src"))
    request.mockImplementation(async (method, params) => {
      if (
        method !== "workspace/list" ||
        typeof params.cwd !== "string" ||
        typeof params.path !== "string"
      )
        throw new Error("Expected a workspace directory request.")
      return listWorkspaceDirectory({ cwd: params.cwd, path: params.path })
    })
    const user = userEvent.setup()
    render(<WorkspaceFiles cwd={cwd} apiBase="http://localhost" />)
    await user.click(await screen.findByRole("button", { name: "src" }))
    await screen.findByText("This directory is empty.")
    const root = screen.getByRole("button", {
      name: cwd.split("/").at(-1) ?? cwd,
    })
    await user.click(root)
    await user.click(root)
    expect(await screen.findByRole("button", { name: "src" })).toBeDefined()
    expect(request.mock.calls).toEqual([
      ["workspace/list", { cwd, path: "." }],
      ["workspace/list", { cwd, path: "src" }],
      ["workspace/list", { cwd, path: "." }],
    ])
  } finally {
    cleanup()
    await rm(cwd, { recursive: true, force: true })
  }
})

it("ignores a previous directory response after collapsing it", async () => {
  const directory = deferred<WorkspaceListResponse>()
  request.mockImplementation(async (_method, params) => {
    if (params.path === "src") return directory.promise
    return {
      cwd: "/repo",
      path: ".",
      entries: [{ name: "src", path: "src", kind: "directory" }],
      truncated: false,
    }
  })
  const user = userEvent.setup()
  render(<WorkspaceFiles cwd="/repo" apiBase="http://localhost" />)
  await user.click(await screen.findByRole("button", { name: "src" }))
  await user.click(screen.getByRole("button", { name: "src" }))
  await screen.findByRole("button", { name: "src" })
  await act(async () =>
    directory.resolve({
      cwd: "/repo",
      path: "src",
      entries: [{ name: "stale.ts", path: "src/stale.ts", kind: "file" }],
      truncated: false,
    }),
  )
  expect(screen.queryByRole("button", { name: "stale.ts" })).toBeNull()
  expect(screen.getByRole("button", { name: "src" })).toBeDefined()
})

it("appends file pages with their source line numbers", async () => {
  request.mockImplementation(async (_method, params) => {
    return params.offset === 3
      ? {
          path: "notes.txt",
          content: "third",
          offset: 3,
          truncated: false,
          binary: false,
        }
      : {
          path: "notes.txt",
          content: "first\nsecond",
          offset: 1,
          nextOffset: 3,
          truncated: true,
          binary: false,
        }
  })
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="notes.txt"
      apiBase="http://localhost"
    />,
  )
  await user.click(
    await screen.findByRole("button", { name: "Load more lines" }),
  )
  const rows = screen.getAllByRole("row")
  expect(
    rows.map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ),
  ).toEqual([
    ["1", "first"],
    ["2", "second"],
    ["3", "third"],
  ])
  expect(screen.queryByRole("button", { name: "Load more lines" })).toBeNull()
})

it("previews a workspace image through the bounded media reader and opens the zoom view", async () => {
  request.mockResolvedValue({
    path: "assets/diagram.png",
    mimeType: "image/png",
    base64: "iVBORw0KGgo=",
  })
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="assets/diagram.png"
      apiBase="http://localhost"
    />,
  )
  const image = await screen.findByRole("img", { name: "diagram.png" })
  expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=")
  expect(request).toHaveBeenCalledWith("workspace/readMedia", {
    cwd: "/repo",
    path: "assets/diagram.png",
  })
  await user.click(
    screen.getByRole("button", { name: "Zoom assets/diagram.png" }),
  )
  expect(
    screen.getByRole("dialog", { name: "Preview diagram.png" }),
  ).toBeDefined()
})

it("shows rendered HTML in an isolated frame and retains its source view", async () => {
  request.mockResolvedValue({
    path: "index.html",
    content: "<h1>Local page</h1>",
    offset: 1,
    truncated: false,
    binary: false,
  })
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="index.html"
      apiBase="http://localhost"
    />,
  )
  const frame = await screen.findByTitle("HTML file preview")
  expect(frame.getAttribute("sandbox")).toBe("")
  expect(frame.getAttribute("srcdoc")).toContain("<h1>Local page</h1>")
  await user.click(screen.getByRole("button", { name: "Source" }))
  expect(
    screen.getByRole("table", { name: "Source code for index.html" }),
  ).toBeDefined()
})

it("opens a Word document preview through the office reader", async () => {
  request.mockResolvedValue({
    path: "report.docx",
    kind: "docx",
    blocks: [
      { kind: "paragraph", text: "Quarterly report" },
      {
        kind: "table",
        rows: [
          ["Team", "Total"],
          ["Alpha", "42"],
        ],
      },
    ],
    truncated: false,
  })
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="report.docx"
      apiBase="http://localhost"
    />,
  )
  expect(await screen.findByText("Quarterly report")).toBeDefined()
  expect(screen.getByRole("table", { name: "Document table 2" })).toBeDefined()
  expect(request).toHaveBeenCalledWith("workspace/readOffice", {
    cwd: "/repo",
    path: "report.docx",
  })
  expect(screen.queryByRole("button", { name: "Edit file" })).toBeNull()
})

it("switches workbook sheets and presentation slides within file previews", async () => {
  request.mockImplementation(async (_method, params) =>
    params.path === "numbers.xlsx"
      ? {
          path: "numbers.xlsx",
          kind: "xlsx",
          sheets: [
            { name: "Summary", rows: [["Total"], ["42"]] },
            {
              name: "Details",
              rows: [
                ["Name", "Value"],
                ["Alpha", "9"],
              ],
            },
          ],
          truncated: false,
        }
      : {
          path: "slides.pptx",
          kind: "pptx",
          slides: [
            { number: 1, paragraphs: ["Overview"], notes: [] },
            {
              number: 2,
              paragraphs: ["Results"],
              notes: ["Explain the chart"],
            },
          ],
          truncated: false,
        },
  )
  const user = userEvent.setup()
  const view = render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="numbers.xlsx"
      apiBase="http://localhost"
    />,
  )
  await user.click(await screen.findByRole("button", { name: "Details" }))
  expect(screen.getByRole("table", { name: "Details worksheet" })).toBeDefined()
  expect(screen.getByText("Alpha")).toBeDefined()
  expect(screen.getByText(/Raw cell values are shown/)).toBeDefined()

  view.rerender(
    <WorkspaceFilePreview
      cwd="/repo"
      path="slides.pptx"
      apiBase="http://localhost"
    />,
  )
  await user.click(await screen.findByRole("button", { name: "Next slide" }))
  expect(screen.getByRole("region", { name: "Slide 2" })).toBeDefined()
  expect(screen.getByText("Explain the chart")).toBeDefined()
})

it("discards file requests when changing workspaces", async () => {
  const previous = deferred<WorkspaceListResponse>()
  request.mockImplementation(async (_method, params) =>
    params.cwd === "/old"
      ? previous.promise
      : {
          cwd: "/new",
          path: ".",
          entries: [{ name: "current.ts", path: "current.ts", kind: "file" }],
          truncated: false,
        },
  )
  const view = render(<WorkspaceFiles cwd="/old" apiBase="http://localhost" />)
  view.rerender(<WorkspaceFiles cwd="/new" apiBase="http://localhost" />)
  await screen.findByRole("button", { name: "current.ts" })
  await act(async () =>
    previous.resolve({
      cwd: "/old",
      path: ".",
      entries: [{ name: "old.ts", path: "old.ts", kind: "file" }],
      truncated: false,
    }),
  )
  expect(screen.queryByRole("button", { name: "old.ts" })).toBeNull()
  expect(screen.getByRole("button", { name: "current.ts" })).toBeDefined()
})

it("stages untracked files and renders renamed staged entries", async () => {
  let staged = false
  request.mockImplementation(async (method) => {
    if (method === "git/stage") {
      staged = true
      return {}
    }
    return {
      repository: true,
      branch: "main",
      entries: [
        {
          path: "new.ts",
          indexStatus: staged ? "A" : "?",
          worktreeStatus: staged ? " " : "?",
        },
        {
          path: "renamed.ts",
          originalPath: "before.ts",
          indexStatus: "R",
          worktreeStatus: " ",
        },
      ],
    }
  })
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await user.click(await screen.findByRole("button", { name: "Stage new.ts" }))
  await screen.findByText("No unstaged changes")
  await user.click(screen.getByRole("button", { name: "Staged 2" }))
  expect(screen.getByRole("button", { name: "new.ts, Added" })).toBeDefined()
  expect(
    screen.getByRole("button", { name: "renamed.ts, Renamed" }).textContent,
  ).toContain("before.ts →")
  expect(request).toHaveBeenCalledWith("git/stage", {
    cwd: "/repo",
    path: "new.ts",
  })
})

it("reloads changes when the active agent turn completes", async () => {
  useAppStore.setState((state) => ({
    execution: { ...state.execution, activeTurnId: "turn-editing" },
  }))
  request
    .mockResolvedValueOnce({ repository: true, entries: [] })
    .mockResolvedValue({
      repository: true,
      entries: [{ path: "edited.ts", indexStatus: " ", worktreeStatus: "M" }],
    })
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await screen.findByText("Working tree clean")

  act(() => {
    useAppStore.setState((state) => ({
      execution: { ...state.execution, activeTurnId: undefined },
    }))
  })

  expect(
    await screen.findByRole("button", { name: "edited.ts, Modified" }),
  ).toBeDefined()
  expect(screen.queryByText("Working tree clean")).toBeNull()
  expect(screen.getByRole("button", { name: "Unstaged 1" })).toBeDefined()
})

it("discards a diff from the previous scope and refreshes on focus", async () => {
  const unstagedDiff = deferred<GitDiffResponse>()
  request.mockImplementation(async (method, params) => {
    if (method === "git/status")
      return {
        repository: true,
        entries: [{ path: "both.ts", indexStatus: "M", worktreeStatus: "M" }],
      }
    if (!params.staged) return unstagedDiff.promise
    return { path: "both.ts", text: "+staged content", truncated: false }
  })
  const user = userEvent.setup()
  render(<WorkspaceChanges cwd="/repo" apiBase="http://localhost" />)
  await user.click(
    await screen.findByRole("button", { name: "both.ts, Modified" }),
  )
  await user.click(screen.getByRole("button", { name: "Staged 1" }))
  await user.click(screen.getByRole("button", { name: "both.ts, Modified" }))
  await screen.findByText("+staged content")
  await act(async () =>
    unstagedDiff.resolve({
      path: "both.ts",
      text: "+stale unstaged",
      truncated: false,
    }),
  )
  expect(screen.queryByText("+stale unstaged")).toBeNull()
  request.mockImplementation(async (method) =>
    method === "git/status"
      ? { repository: true, entries: [] }
      : { path: "both.ts", text: "", truncated: false },
  )
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(await screen.findByText("Working tree clean")).toBeDefined()
})

it("discards Git status from a previous workspace", async () => {
  const previous = deferred<GitStatusResponse>()
  request.mockImplementation(async (_method, params) =>
    params.cwd === "/old"
      ? previous.promise
      : { repository: true, branch: "new-branch", entries: [] },
  )
  const view = render(
    <WorkspaceChanges cwd="/old" apiBase="http://localhost" />,
  )
  view.rerender(<WorkspaceChanges cwd="/new" apiBase="http://localhost" />)
  await screen.findByText("new-branch")
  await act(async () =>
    previous.resolve({
      repository: true,
      branch: "old-branch",
      entries: [{ path: "old.ts", indexStatus: "M", worktreeStatus: " " }],
    }),
  )
  expect(screen.queryByText("old-branch")).toBeNull()
  expect(screen.getByText("Working tree clean")).toBeDefined()
})

it("copies the full file path on desktop without opening the editor", async () => {
  const writeClipboardText = vi.fn(async () => {})
  const openFile = vi.fn(async () => {})
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { writeClipboardText, openFile },
  })
  request.mockResolvedValue({
    path: "./src/app.ts",
    content: "export {}",
    offset: 1,
    truncated: false,
    binary: false,
  })
  try {
    const user = userEvent.setup()
    render(
      <WorkspaceFilePreview
        path="./src/app.ts"
        cwd="/repo"
        apiBase="http://localhost"
      />,
    )
    await user.click(screen.getByRole("button", { name: "Copy path" }))
    expect(writeClipboardText).toHaveBeenCalledWith("/repo/src/app.ts")
    expect(openFile).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Copied path" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeDefined()
  } finally {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
  }
})

it("switches Markdown between a rendered document and its unchanged source", async () => {
  request.mockResolvedValue({
    path: "docs/guide.md",
    content:
      "# Setup\n\n**Install** the package.\n\n<script>alert('no')</script>",
    offset: 1,
    truncated: false,
    binary: false,
  })
  const user = userEvent.setup()
  const { container } = render(
    <WorkspaceFilePreview
      path="docs/guide.md"
      cwd="/repo"
      apiBase="http://localhost"
    />,
  )
  expect(await screen.findByRole("heading", { name: "Setup" })).toBeDefined()
  expect(container.querySelector("script")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Source" }))
  expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull()
  expect(screen.getAllByRole("row")[0]?.textContent).toBe("1# Setup")
  expect(
    screen
      .getByRole("button", { name: "Wrap lines" })
      .getAttribute("aria-pressed"),
  ).toBe("false")
  await user.click(screen.getByRole("button", { name: "Wrap lines" }))
  expect(
    screen
      .getByRole("button", { name: "Wrap lines" })
      .getAttribute("aria-pressed"),
  ).toBe("true")
  await user.click(screen.getByRole("button", { name: "Preview" }))
  expect(screen.getByRole("heading", { name: "Setup" })).toBeDefined()
})

it("keeps partial file status visible while appending Markdown pages", async () => {
  request.mockImplementation(async (_method, params) =>
    params.offset === 3
      ? {
          path: "guide.md",
          content: "## Usage",
          offset: 3,
          truncated: false,
          binary: false,
        }
      : {
          path: "guide.md",
          content: "# Setup\n",
          offset: 1,
          nextOffset: 3,
          truncated: true,
          binary: false,
        },
  )
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      path="guide.md"
      cwd="/repo"
      apiBase="http://localhost"
    />,
  )
  await screen.findByRole("heading", { name: "Setup" })
  expect(screen.getByText("2 lines loaded · Partial file")).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Load more lines" }))
  expect(await screen.findByRole("heading", { name: "Usage" })).toBeDefined()
  expect(screen.getByText("3 lines")).toBeDefined()
  expect(screen.queryByText(/Partial file/)).toBeNull()
  await user.click(screen.getByRole("button", { name: "Source" }))
  expect(screen.getAllByRole("row").map((row) => row.textContent)).toEqual([
    "1# Setup",
    "2",
    "3## Usage",
  ])
})
