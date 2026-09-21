// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkspaceFileTree } from "../../src/gui/components/workspace-file-tree.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { WorkspaceListResponse } from "../../src/server/workspace.ts"

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
afterEach(cleanup)

function listing(
  entries: WorkspaceListResponse["entries"],
): WorkspaceListResponse {
  return { cwd: "/repo", path: ".", entries, truncated: false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const rootEntries: WorkspaceListResponse["entries"] = [
  { name: "src", path: "src", kind: "directory" },
  { name: "README.md", path: "README.md", kind: "file" },
]

it("opens the root by default and lazily expands folders without replacing sibling files", async () => {
  request.mockImplementation(async (_method, params) =>
    listing(
      params.path === "."
        ? rootEntries
        : [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
    ),
  )
  const onOpenFile = vi.fn()
  const user = userEvent.setup()
  render(
    <WorkspaceFileTree
      cwd="/repo"
      apiBase="http://localhost"
      onOpenFile={onOpenFile}
    />,
  )
  expect(await screen.findByRole("button", { name: "README.md" })).toBeDefined()
  expect(request.mock.calls).toEqual([
    ["workspace/list", { cwd: "/repo", path: "." }],
  ])
  expect(
    screen.getByRole("button", { name: "repo" }).getAttribute("aria-expanded"),
  ).toBe("true")
  await user.click(screen.getByRole("button", { name: "src" }))
  await user.click(await screen.findByRole("button", { name: "index.ts" }))
  expect(screen.getByRole("button", { name: "README.md" })).toBeDefined()
  expect(onOpenFile).toHaveBeenCalledWith("src/index.ts")
  await user.click(screen.getByRole("button", { name: "src" }))
  expect(screen.queryByRole("button", { name: "index.ts" })).toBeNull()
  expect(
    screen.getByRole("button", { name: "src" }).getAttribute("aria-expanded"),
  ).toBe("false")
})

it("discards an old root response when the workspace changes", async () => {
  const previous = deferred<WorkspaceListResponse>()
  request.mockImplementation(async (_method, params) =>
    params.cwd === "/old"
      ? previous.promise
      : listing([{ name: "current.ts", path: "current.ts", kind: "file" }]),
  )
  const view = render(
    <WorkspaceFileTree
      cwd="/old"
      apiBase="http://localhost"
      onOpenFile={() => {}}
    />,
  )
  view.rerender(
    <WorkspaceFileTree
      cwd="/new"
      apiBase="http://localhost"
      onOpenFile={() => {}}
    />,
  )
  await screen.findByRole("button", { name: "current.ts" })
  await act(async () =>
    previous.resolve(
      listing([{ name: "stale.ts", path: "stale.ts", kind: "file" }]),
    ),
  )
  expect(screen.queryByRole("button", { name: "stale.ts" })).toBeNull()
  expect(screen.getByRole("button", { name: "new" })).toBeDefined()
})

it("searches all project paths without expanding folders and ignores superseded results", async () => {
  const previous = deferred<{ paths: string[]; truncated: boolean }>()
  request.mockImplementation(async (method, params) =>
    method === "workspace/list"
      ? listing(rootEntries)
      : params.query === "old"
        ? previous.promise
        : { paths: ["src/nested/current.ts"], truncated: false },
  )
  const onOpenFile = vi.fn()
  const user = userEvent.setup()
  render(
    <WorkspaceFileTree
      cwd="/repo"
      apiBase="http://localhost"
      onOpenFile={onOpenFile}
    />,
  )
  const input = screen.getByRole("textbox", { name: "Find files" })
  await user.type(input, "old")
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("workspace/findFiles", {
      cwd: "/repo",
      query: "old",
    }),
  )
  await user.clear(input)
  await user.type(input, "current")
  const result = await screen.findByRole("button", {
    name: /src\/nested\/current.ts/,
  })
  await act(async () =>
    previous.resolve({ paths: ["old.ts"], truncated: false }),
  )
  expect(screen.queryByRole("button", { name: /old.ts/ })).toBeNull()
  await user.click(result)
  expect(onOpenFile).toHaveBeenCalledWith("src/nested/current.ts")
  expect(
    request.mock.calls.filter(([method]) => method === "workspace/list"),
  ).toHaveLength(1)
  expect(screen.getByText("Ignored files are excluded.")).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Clear file filter" }))
  expect(screen.getByRole("button", { name: "README.md" })).toBeDefined()
})

it("refreshes expanded directories after save, focus, turn changes, and explicit refresh", async () => {
  let version = 0
  request.mockImplementation(async (_method, params) =>
    listing(
      params.path === "."
        ? rootEntries
        : [
            {
              name: `file-${version}.ts`,
              path: `src/file-${version}.ts`,
              kind: "file",
            },
          ],
    ),
  )
  const user = userEvent.setup()
  render(
    <WorkspaceFileTree
      cwd="/repo"
      apiBase="http://localhost"
      onOpenFile={() => {}}
    />,
  )
  await user.click(await screen.findByRole("button", { name: "src" }))
  await screen.findByRole("button", { name: "file-0.ts" })
  for (const event of ["yakitori:workspace-file-saved", "focus"]) {
    version += 1
    fireEvent(window, new Event(event))
    await screen.findByRole("button", { name: `file-${version}.ts` })
    expect(
      screen.getByRole("button", { name: "src" }).getAttribute("aria-expanded"),
    ).toBe("true")
  }
  version += 1
  act(() =>
    useAppStore.setState((state) => ({
      execution: { ...state.execution, activeTurnId: "turn_changed" },
    })),
  )
  await screen.findByRole("button", { name: "file-3.ts" })
  version += 1
  await user.click(screen.getByRole("button", { name: "Refresh files" }))
  await screen.findByRole("button", { name: "file-4.ts" })
  expect(screen.queryByRole("button", { name: "file-0.ts" })).toBeNull()
})

it("shows search failures and retries through refresh, disclosing incomplete results", async () => {
  let failed = true
  request.mockImplementation(async (method) => {
    if (method === "workspace/list") return listing([])
    if (failed) throw new Error("Search timed out")
    return { paths: [], truncated: true }
  })
  const user = userEvent.setup()
  render(
    <WorkspaceFileTree
      cwd="/repo"
      apiBase="http://localhost"
      onOpenFile={() => {}}
    />,
  )
  await user.type(
    screen.getByRole("textbox", { name: "Find files" }),
    "missing",
  )
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Search timed out",
  )
  failed = false
  await user.click(screen.getByRole("button", { name: "Refresh files" }))
  expect(
    await screen.findByText(/More files may match. Narrow the filter./),
  ).toHaveProperty(
    "textContent",
    "No files found. More files may match. Narrow the filter. Ignored files are excluded.",
  )
  expect(screen.queryByRole("alert")).toBeNull()
})
