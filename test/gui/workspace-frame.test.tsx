// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkspaceFrame } from "../../src/gui/components/workspace-frame.tsx"
import { contextSourceAttributes } from "../../src/gui/conversation-context.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import type { ApiProject, ApiSessionDetail } from "../../src/server/protocol.ts"

const rpc = vi.hoisted(() => ({
  request: vi.fn(),
  subscribeToSideChatChanges: () => () => {},
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => rpc,
}))

vi.mock("../../src/gui/components/sidebar-frame.tsx", () => ({
  SidebarFrame: () => <aside aria-label="Sidebar" className="sidebar-frame" />,
}))
vi.mock("../../src/gui/components/workspace-files.tsx", () => ({
  WorkspaceFiles: ({ cwd }: { cwd: string }) => <p>Files at {cwd}</p>,
  WorkspaceFilePreview: ({
    path,
    onDirtyChange,
  }: {
    path: string
    onDirtyChange?(dirty: boolean): void
  }) => (
    <div>
      <p>File {path}</p>
      <button type="button" onClick={() => onDirtyChange?.(true)}>
        Change file
      </button>
    </div>
  ),
}))
vi.mock("../../src/gui/components/workspace-changes.tsx", () => ({
  WorkspaceChanges: ({ cwd }: { cwd: string }) => <p>Changes at {cwd}</p>,
}))
vi.mock("../../src/gui/components/computer-panel.tsx", () => ({
  ComputerPanel: () => <p>Computer view</p>,
}))
vi.mock("../../src/gui/components/browser-panel.tsx", () => ({
  BrowserPanel: () => (
    <input aria-label="Browser address" defaultValue="about:blank" />
  ),
}))

function project(id: string, root: string): ApiProject {
  return {
    id,
    name: id,
    roots: [root],
    metadata: {},
    position: 0,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(id: string, workingDirectory: string): ApiSessionDetail {
  return {
    id,
    conversationId: id,
    seq: 1,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    workingDirectory,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      inputs: 0,
      pendingInputs: 0,
      turns: 0,
      items: 0,
      permissions: 0,
      tools: 0,
    },
  }
}

let measuredWidth = 1440
const resizeCallbacks = new Set<() => void>()
beforeEach(() => {
  measuredWidth = 1440
  resizeCallbacks.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe() {
        resizeCallbacks.add(this.callback)
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback)
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        this.classList.contains("workspace-shell")
          ? measuredWidth
          : this.classList.contains("sidebar-frame")
            ? 275
            : 0,
        900,
      )
    },
  )
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  })
  localStorage.clear()
  rpc.request.mockReset().mockImplementation(async (method: string) =>
    method === "sideChat/create"
      ? {
          id: `side_${crypto.randomUUID()}`,
          revision: 0,
          cwd: "/project/one",
          modelSelection: { provider: "faux", model: "scripted" },
          messages: [],
        }
      : { skills: [] },
  )
  useWorkspaceStore.setState({
    tabs: [{ id: "changes", kind: "changes" }],
    activeId: "changes",
    open: true,
    expanded: false,
  })
  useAppStore.setState({
    ...createInitialAppState(),
    projects: [project("project-one", "/project/one")],
    currentProject: "project-one",
  })
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function addView(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Add workspace tab" }))
  await user.click(
    screen.getByRole("menuitem", { name: new RegExp(`^${name}`) }),
  )
}

it("keeps a dirty file tab until its edits are explicitly discarded", async () => {
  const user = userEvent.setup()
  useWorkspaceStore.getState().openFile("notes.txt", "/project/one")
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  await user.click(screen.getByRole("button", { name: "Change file" }))
  await user.click(screen.getByRole("button", { name: "Close notes.txt" }))
  expect(screen.getByRole("dialog").textContent).toContain(
    "Discard changes to notes.txt?",
  )
  await user.click(screen.getByRole("button", { name: "Keep editing" }))
  expect(screen.getByRole("tab", { name: /notes.txt/ })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Close notes.txt" }))
  await user.click(screen.getByRole("button", { name: "Discard changes" }))
  expect(screen.queryByRole("tab", { name: /notes.txt/ })).toBeNull()
})

it("restores the collapsed workspace, width, and selected tab after remounting", async () => {
  const user = userEvent.setup()
  const view = render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  await addView(user, "Files")
  screen.getByRole("separator", { name: "Workspace width" }).focus()
  await user.keyboard("{ArrowLeft}{ArrowLeft}")
  expect(
    screen
      .getByRole("separator", { name: "Workspace width" })
      .getAttribute("aria-valuenow"),
  ).toBe("472")
  await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}")
  view.unmount()

  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull()
  expect(screen.getByRole("main").textContent).toBe("Conversation")
  await user.click(screen.getByRole("button", { name: "Show workspace" }))
  expect(
    screen.getByRole("tab", { name: "Files", selected: true }),
  ).toBeDefined()
  expect(screen.getByText("Files at /project/one")).toBeDefined()
  expect(
    screen
      .getByRole("separator", { name: "Workspace width" })
      .getAttribute("aria-valuenow"),
  ).toBe("472")
})

it("resizes from the keyboard and keeps the width within its accessible bounds", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  const handle = screen.getByRole("separator", { name: "Workspace width" })
  handle.focus()
  await user.keyboard("{ArrowLeft>30/}")
  expect(handle.getAttribute("aria-valuenow")).toBe("685")
  await user.keyboard("{ArrowRight}")
  expect(handle.getAttribute("aria-valuenow")).toBe("669")
  await user.keyboard("{ArrowRight>30/}")
  expect(handle.getAttribute("aria-valuenow")).toBe("320")
  await user.keyboard("{ArrowLeft}")
  expect(handle.getAttribute("aria-valuenow")).toBe("336")
  expect(document.activeElement).toBe(handle)
})

it("keeps the saved split proportion when the window resizes and reserves space for the conversation", () => {
  localStorage.setItem("yakitori.workspaceSplit", "0.5")
  measuredWidth = 1275
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  const handle = screen.getByRole("separator", { name: "Workspace width" })
  expect(handle.getAttribute("aria-valuenow")).toBe("500")
  act(() => {
    measuredWidth = 1475
    for (const update of resizeCallbacks) update()
  })
  expect(handle.getAttribute("aria-valuenow")).toBe("600")
  act(() => {
    measuredWidth = 960
    for (const update of resizeCallbacks) update()
  })
  expect(handle.getAttribute("aria-valuenow")).toBe("320")
  act(() => {
    measuredWidth = 1275
    for (const update of resizeCallbacks) update()
  })
  expect(handle.getAttribute("aria-valuenow")).toBe("500")
})

it("moves tab selection and focus with arrow, Home, and End keys", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  await addView(user, "Files")
  await addView(user, "Computer")
  screen.getByRole("tab", { name: "Changes" }).focus()

  for (const [key, name, content] of [
    ["{ArrowRight}", "Files", "Files at /project/one"],
    ["{ArrowRight}", "Computer", "Computer view"],
    ["{ArrowRight}", "Changes", "Changes at /project/one"],
    ["{ArrowLeft}", "Computer", "Computer view"],
    ["{Home}", "Changes", "Changes at /project/one"],
    ["{End}", "Computer", "Computer view"],
  ] as const) {
    await user.keyboard(key)
    const selected = screen.getByRole("tab", { name, selected: true })
    expect(document.activeElement).toBe(selected)
    expect(selected.tabIndex).toBe(0)
    expect(screen.getByRole("tabpanel", { name }).textContent).toContain(
      content,
    )
    expect(
      screen
        .getAllByRole("tab", { selected: false })
        .every((tab) => tab.tabIndex === -1),
    ).toBe(true)
  }
})

it("keeps file and change content rooted in the selected session when project selection changes", async () => {
  useAppStore.setState({
    projects: [
      project("project-one", "/project/one"),
      project("project-two", "/project/two"),
    ],
    selection: { sessionId: "session-one" },
    selectedSession: session("session-one", "/session/one"),
  })
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  expect(screen.getByText("Changes at /session/one")).toBeDefined()

  act(() => useAppStore.setState({ currentProject: "project-two" }))
  expect(screen.getByText("Changes at /session/one")).toBeDefined()
  expect(screen.queryByText("Changes at /project/two")).toBeNull()
  await addView(user, "Files")
  expect(screen.getByText("Files at /session/one")).toBeDefined()

  act(() =>
    useAppStore.setState({
      selection: { sessionId: "session-two" },
      selectedSession: session("session-two", "/session/two"),
    }),
  )
  expect(screen.getByText("Files at /session/two")).toBeDefined()
  expect(screen.queryByText("Files at /session/one")).toBeNull()

  act(() => useAppStore.setState({ selection: {}, selectedSession: undefined }))
  expect(screen.getByText("Files at /project/two")).toBeDefined()
})

it("opens views from the add menu and closes only the chosen tab", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  await addView(user, "Files")
  expect(
    screen.getByRole("tab", { name: "Files", selected: true }),
  ).toBeDefined()
  await addView(user, "Side chat")
  expect(
    screen.getByRole("tab", { name: "Side chat", selected: true }),
  ).toBeDefined()
  await user.type(
    screen.getByRole("textbox", { name: "Message side chat" }),
    "Keep this draft",
  )
  await addView(user, "Browser")
  expect(
    screen.getByRole("tab", { name: "Browser", selected: true }),
  ).toBeDefined()

  await user.click(screen.getByRole("button", { name: "Close Files" }))
  expect(screen.queryByRole("tab", { name: "Files" })).toBeNull()
  expect(
    screen.getByRole("tab", { name: "Browser", selected: true }),
  ).toBeDefined()
  expect(screen.getByRole("tab", { name: "Changes" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Close Browser" }))
  expect(
    screen.getByRole("tab", { name: "Side chat", selected: true }),
  ).toBeDefined()
  expect(
    (
      screen.getByRole("textbox", {
        name: "Message side chat",
      }) as HTMLTextAreaElement
    ).textContent,
  ).toBe("Keep this draft")
})

it("keeps loaded tab content and side chat drafts while switching views and collapsing", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  await addView(user, "Browser")
  const address = screen.getByRole("textbox", { name: "Browser address" })
  await user.clear(address)
  await user.type(address, "https://example.com/research")
  await addView(user, "Side chat")
  await user.type(
    screen.getByRole("textbox", { name: "Message side chat" }),
    "A question in progress",
  )
  await user.click(screen.getByRole("button", { name: "Hide workspace" }))
  expect(
    screen.queryByRole("textbox", { name: "Message side chat" }),
  ).toBeNull()
  await user.click(screen.getByRole("button", { name: "Show workspace" }))
  expect(
    (
      screen.getByRole("textbox", {
        name: "Message side chat",
      }) as HTMLTextAreaElement
    ).textContent,
  ).toBe("A question in progress")
  await user.click(screen.getByRole("tab", { name: "Browser" }))
  expect(
    (
      screen.getByRole("textbox", {
        name: "Browser address",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://example.com/research")
  await user.click(screen.getByRole("tab", { name: "Side chat" }))
  expect(
    (
      screen.getByRole("textbox", {
        name: "Message side chat",
      }) as HTMLTextAreaElement
    ).textContent,
  ).toBe("A question in progress")
})

it("queues selected text in a side chat draft without sending it", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>
        <p
          {...contextSourceAttributes({
            kind: "message",
            label: "Assistant message",
            sessionId: "session-source",
            messageId: "answer-source",
          })}
        >
          Consider this explanation.
        </p>
      </main>
    </WorkspaceFrame>,
  )
  const text = screen.getByText("Consider this explanation.")
  const range = document.createRange()
  range.selectNodeContents(text)
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({ left: 100, bottom: 120 }),
  })
  window.getSelection()?.addRange(range)
  fireEvent.pointerUp(text)
  await user.click(screen.getByRole("button", { name: "Ask in side chat" }))
  expect(
    screen.getByRole("tab", { name: "Side chat", selected: true }),
  ).toBeDefined()
  expect(screen.getByText("1 selected text snippet")).toBeDefined()
  await user.click(
    screen.getByRole("button", {
      name: "1 selected text snippet",
    }),
  )
  expect(
    screen.getByRole("dialog", { name: "selected text snippets" }).textContent,
  ).toContain("Consider this explanation.")
  expect(useAppStore.getState().promptExcerpts).toEqual([])
  expect(
    rpc.request.mock.calls.filter(([method]) => method === "sideChat/send"),
  ).toEqual([])
})

it("reuses an idle side discussion after browsing and confirms closing a draft", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFrame>
      <main>Conversation</main>
    </WorkspaceFrame>,
  )
  const excerpt = {
    id: "selection-1",
    kind: "selection" as const,
    text: "First quote",
    source: {
      kind: "file" as const,
      label: "file.ts",
      path: "/project/one/file.ts",
    },
  }
  act(() => {
    useWorkspaceStore.getState().askInSideChat(excerpt)
  })
  await addView(user, "Browser")
  act(() => {
    useWorkspaceStore
      .getState()
      .askInSideChat({ ...excerpt, id: "selection-2", text: "Second quote" })
  })
  expect(screen.getAllByRole("tab", { name: "Side chat" })).toHaveLength(1)
  expect(
    screen.getByRole("button", { name: "2 selected text snippets" }),
  ).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Close Side chat" }))
  expect(screen.getByRole("dialog", { name: "Close Side chat?" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("tab", { name: "Side chat" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Close Side chat" }))
  await user.click(screen.getByRole("button", { name: "Close side chat" }))
  expect(screen.queryByRole("tab", { name: "Side chat" })).toBeNull()
})
