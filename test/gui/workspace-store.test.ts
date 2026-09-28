// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest"

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it("starts each app window closed even when the previous window had an open workspace", async () => {
  const first = await import("../../src/gui/store/workspace-store.ts")
  expect(first.useWorkspaceStore.getState().open).toBe(false)
  first.useWorkspaceStore.getState().setOpen(true)
  expect(first.useWorkspaceStore.getState().open).toBe(true)
  vi.resetModules()
  const next = await import("../../src/gui/store/workspace-store.ts")
  expect(next.useWorkspaceStore.getState().open).toBe(false)
})

it("reuses the current root's subagent tab while keeping other roots separate", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  useWorkspaceStore.getState().openAgents("root-one", "child-one")
  const first = useWorkspaceStore.getState().activeId
  useWorkspaceStore.getState().openAgents("root-one", "child-two")
  expect(useWorkspaceStore.getState().activeId).toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "agents"),
  ).toHaveLength(1)
  useWorkspaceStore.getState().openAgents("root-two", "child-three")
  expect(useWorkspaceStore.getState().activeId).not.toBe(first)
  useWorkspaceStore.getState().openAgents("root-one")
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).not.toHaveProperty("selectedAgentId")
})

it("keeps file and browser tabs in their opening session and preserves an emptied panel", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("session-one")
  store.openFile("notes.ts", "/repo")
  store.openBrowser("https://example.com")
  const first = useWorkspaceStore.getState()
  expect(
    first.tabs
      .filter((tab) => tab.workspaceSessionId === "session-one")
      .map((tab) => tab.kind),
  ).toEqual(["changes", "file", "browser"])

  first.setSession("session-two")
  expect(
    useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.workspaceSessionId === "session-two")
      .map((tab) => tab.kind),
  ).toEqual(["changes"])
  useWorkspaceStore.getState().openFile("notes.ts", "/repo")
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "file"),
  ).toHaveLength(2)

  useWorkspaceStore.getState().setSession("session-one")
  expect(useWorkspaceStore.getState().activeId).toBe(first.activeId)
  for (const tab of useWorkspaceStore
    .getState()
    .tabs.filter((entry) => entry.workspaceSessionId === "session-one")) {
    useWorkspaceStore.getState().closeTab(tab.id)
  }
  useWorkspaceStore.getState().setSession("session-two")
  useWorkspaceStore.getState().setSession("session-one")
  expect(useWorkspaceStore.getState().activeId).toBeUndefined()
  expect(
    useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.workspaceSessionId === "session-one"),
  ).toEqual([])
})

it("reuses the same skill preview per session and keeps another session separate", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("first")
  store.openSkill("/home/.agents/skills/review/SKILL.md", "review")
  const first = useWorkspaceStore.getState().activeId
  store.openSkill("/home/.agents/skills/review/SKILL.md", "review")
  expect(useWorkspaceStore.getState().activeId).toBe(first)
  store.setSession("second")
  store.openSkill("/home/.agents/skills/review/SKILL.md", "review")
  expect(useWorkspaceStore.getState().activeId).not.toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "skill"),
  ).toHaveLength(2)
})

it("restores each session's pane and active tab after switching, including agent sizing", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("session-one")
  const firstTab = store.addTab("files")
  store.setExpanded(true)
  store.setSession("session-two")
  const secondTab = store.addTab("computer")
  store.openAgents("session-two")
  expect(useWorkspaceStore.getState()).toMatchObject({
    open: true,
    expanded: false,
  })
  store.setOpen(false)

  store.setSession("session-one")
  expect(useWorkspaceStore.getState()).toMatchObject({
    open: true,
    expanded: true,
    activeId: firstTab,
  })
  store.setSession("session-two")
  expect(useWorkspaceStore.getState()).toMatchObject({
    open: false,
    expanded: false,
  })
  store.activate(secondTab)
  expect(useWorkspaceStore.getState().activeId).toBe(secondTab)
  expect(localStorage.getItem("yakitori.workspaceTab")).toBeNull()
})

it("removes a deleted session's workspace tabs and leaves other sessions intact", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("parent")
  store.addTab("chat", "parent")
  store.openFile("unsaved.ts", "/repo")
  store.setSession("other")
  const otherTab = store.addTab("files")
  store.removeSession("parent")
  expect(
    useWorkspaceStore
      .getState()
      .tabs.some((tab) => tab.workspaceSessionId === "parent"),
  ).toBe(false)
  expect(useWorkspaceStore.getState().activeId).toBe(otherTab)

  store.removeSession("other")
  expect(useWorkspaceStore.getState().sessionId).toBeUndefined()
  expect(
    useWorkspaceStore
      .getState()
      .tabs.every((tab) => tab.workspaceSessionId === undefined),
  ).toBe(true)
  store.setSession("parent")
  expect(
    useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.workspaceSessionId === "parent")
      .map((tab) => tab.kind),
  ).toEqual(["changes"])
})

it("opens a fresh side chat when the previous one has expired", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("parent")
  const previous = store.addTab("chat", "parent")
  store.updateChatStatus(previous, {
    hasMessages: true,
    expiresAt: "2020-01-01T00:00:00.000Z",
  })
  store.askInSideChat(
    {
      id: "quote",
      kind: "selection",
      text: "Explain this",
      source: { kind: "message", label: "Main response" },
    },
    "parent",
  )
  const current = useWorkspaceStore.getState()
  expect(current.activeId).not.toBe(previous)
  expect(current.tabs.find((tab) => tab.id === previous)).toMatchObject({
    expiresAt: "2020-01-01T00:00:00.000Z",
  })
  expect(current.tabs.find((tab) => tab.id === current.activeId)).toMatchObject(
    {
      kind: "chat",
      workspaceSessionId: "parent",
      excerpts: [{ id: "quote" }],
    },
  )
})
