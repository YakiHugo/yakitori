import "./setup-store-environment.ts"
import { beforeEach, expect, it, vi } from "vitest"
import { selectWorkspacePresentation } from "../../src/gui/store/workspace-store.ts"
import { inputParts } from "../gui/input-fixtures.ts"

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it("starts each app window closed even when the previous window had an open workspace", async () => {
  const first = await import("../../src/gui/store/workspace-store.ts")
  expect(
    selectWorkspacePresentation(first.useWorkspaceStore.getState()).open,
  ).toBe(false)
  first.useWorkspaceStore.getState().setOpen(true)
  expect(
    selectWorkspacePresentation(first.useWorkspaceStore.getState()).open,
  ).toBe(true)
  vi.resetModules()
  const next = await import("../../src/gui/store/workspace-store.ts")
  expect(
    selectWorkspacePresentation(next.useWorkspaceStore.getState()).open,
  ).toBe(false)
})

it("inherits pane sizing only on first entry and remembers an empty new-session workspace", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.closeTab("changes")
  store.setOpen(true)
  store.setExpanded(true)
  store.setSession("first")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: true,
    expanded: true,
  })
  store.setOpen(false)
  store.setExpanded(false)
  store.setSession("second")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: false,
    expanded: false,
  })
  store.setSession(undefined)
  expect(selectWorkspacePresentation(useWorkspaceStore.getState())).toEqual({
    open: true,
    expanded: true,
    activeId: undefined,
  })
  expect(
    useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.workspaceSessionId === undefined),
  ).toEqual([])
  store.setSession("first")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: false,
    expanded: false,
  })
})

it("keeps the selected tab when closing another and can empty an inactive new-session workspace", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  const selected = store.addTab("files")
  store.closeTab("changes")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(selected)
  store.setSession("first")
  const active = store.addTab("computer")
  store.closeTab(selected)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(active)
  store.setSession(undefined)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBeUndefined()
  expect(
    useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.workspaceSessionId === undefined),
  ).toEqual([])
})

it("reuses the current root's subagent tab while keeping other roots separate", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  useWorkspaceStore.getState().openAgents("root-one", "child-one")
  const first = selectWorkspacePresentation(
    useWorkspaceStore.getState(),
  ).activeId
  useWorkspaceStore.getState().openAgents("root-one", "child-two")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "agents"),
  ).toHaveLength(1)
  useWorkspaceStore.getState().openAgents("root-two", "child-three")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).not.toBe(first)
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
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(selectWorkspacePresentation(first).activeId)
  for (const tab of useWorkspaceStore
    .getState()
    .tabs.filter((entry) => entry.workspaceSessionId === "session-one")) {
    useWorkspaceStore.getState().closeTab(tab.id)
  }
  useWorkspaceStore.getState().setSession("session-two")
  useWorkspaceStore.getState().setSession("session-one")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBeUndefined()
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
  const first = selectWorkspacePresentation(
    useWorkspaceStore.getState(),
  ).activeId
  store.openSkill("/home/.agents/skills/review/SKILL.md", "review")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(first)
  store.setSession("second")
  store.openSkill("/home/.agents/skills/review/SKILL.md", "review")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).not.toBe(first)
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
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: true,
    expanded: false,
  })
  store.setOpen(false)

  store.setSession("session-one")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: true,
    expanded: true,
    activeId: firstTab,
  })
  store.setSession("session-two")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({
    open: false,
    expanded: false,
  })
  store.activate(secondTab)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(secondTab)
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
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(otherTab)

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

      text: "Explain this",
      source: {
        sessionId: "session_1",
        messageId: "response_1",
        kind: "message",
        label: "Main response",
      },
    },
    "parent",
  )
  const current = useWorkspaceStore.getState()
  expect(selectWorkspacePresentation(current).activeId).not.toBe(previous)
  expect(current.tabs.find((tab) => tab.id === previous)).toMatchObject({
    expiresAt: "2020-01-01T00:00:00.000Z",
  })
  expect(
    current.tabs.find(
      (tab) => tab.id === selectWorkspacePresentation(current).activeId,
    ),
  ).toMatchObject({
    kind: "chat",
    workspaceSessionId: "parent",
    excerpts: [{ id: "quote" }],
  })
})

it("keeps selected context in its explicit side draft and advances focus only when adding", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("main")
  const first = store.addTab("chat", "main")
  const second = store.addTab("chat", "main")
  const excerpt = {
    id: "quote",
    text: "Answer",
    source: {
      kind: "message" as const,
      label: "Response",
      sessionId: "side",
      messageId: "answer",
    },
  }
  store.addChatExcerpt(first, excerpt)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ excerpts: [excerpt], composerFocusRevision: 1 })
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === second),
  ).toMatchObject({ excerpts: [] })
  store.updateChatDraft(first, inputParts(""), [])
  store.addChatExcerpt(first, { ...excerpt, id: "again" })
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ composerFocusRevision: 2 })
  store.setSession("another")
  store.addChatExcerpt(first, { ...excerpt, id: "stale" })
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ composerFocusRevision: 2 })
})

it.each([
  { expired: true, expiresAt: "2099-01-01T00:00:00.000Z" },
  { expired: false, expiresAt: "2020-01-01T00:00:00.000Z" },
])("keeps an expired side draft frozen even before its UI updates: %j", async (expiry) => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("main")
  const id = store.addTab("chat", "main")
  const excerpt = {
    id: "quote",
    text: "Answer",
    source: {
      kind: "message" as const,
      label: "Response",
      sessionId: "side",
      messageId: "answer",
    },
    anchor: { startOffset: 0, endOffset: 6 },
  }
  store.addChatExcerpt(id, excerpt)
  store.updateChatDraft(id, inputParts("Unsent question"), [excerpt])
  const other = store.addTab("chat", "main")
  store.updateChatStatus(id, { hasMessages: true, ...expiry })

  store.addChatExcerpt(id, { ...excerpt, id: "late" })
  store.updateChatExcerpt(id, { ...excerpt, comment: "Late edit" })
  store.removeChatExcerpt(id, excerpt.id)

  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(other)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === id),
  ).toMatchObject({
    draft: inputParts("Unsent question"),
    excerpts: [excerpt],
    composerFocusRevision: 1,
  })

  store.updateChatStatus(id, {
    hasMessages: true,
    expiresAt: "2099-01-01T00:00:00.000Z",
    expired: false,
  })
  store.addChatExcerpt(id, { ...excerpt, id: "renewed" })
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(id)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === id),
  ).toMatchObject({
    excerpts: [excerpt, { ...excerpt, id: "renewed" }],
    composerFocusRevision: 2,
  })
})

it("asks in a distinct side chat and does not choose between unrelated idle drafts", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("main")
  const first = store.addTab("chat", "main")
  const excerpt = {
    id: "quote",
    text: "Answer",
    source: {
      sessionId: "session_1",
      messageId: "response_1",
      kind: "message" as const,
      label: "Response",
    },
  }
  store.askInSideChat(excerpt, "main", first)
  const second = selectWorkspacePresentation(
    useWorkspaceStore.getState(),
  ).activeId
  expect(second).not.toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ excerpts: [] })
  store.addTab("browser")
  store.askInSideChat({ ...excerpt, id: "next" }, "main")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).not.toBe(first)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).not.toBe(second)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "chat"),
  ).toHaveLength(3)
})

it("repairs an inactive session's selection without changing the active session", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("first")
  const fallback = store.addTab("files")
  const removed = store.addTab("browser")
  store.setSession("second")
  const second = store.addTab("computer")
  store.closeTab(removed)
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(second)
  store.setSession("first")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(fallback)
  expect(
    useWorkspaceStore.getState().tabs.some((tab) => tab.id === removed),
  ).toBe(false)
})

it("cannot activate or add excerpts to a tab owned by another session", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("first")
  const first = store.addTab("chat", "first")
  store.setSession("second")
  const second = store.addTab("chat", "second")
  store.activate(first)
  store.addChatExcerpt(first, {
    id: "quote",

    text: "Text",
    source: {
      sessionId: "session_1",
      messageId: "response_1",
      kind: "message",
      label: "Response",
    },
  })
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(second)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ excerpts: [] })
})

it("replaces background chat status without retaining ended turns or old errors", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("first")
  const first = store.addTab("chat", "first")
  store.updateChatStatus(first, {
    hasMessages: true,
    activeTurnId: "turn",
    error: "Old failure",
    expired: true,
  })
  store.setSession("second")
  const second = selectWorkspacePresentation(
    useWorkspaceStore.getState(),
  ).activeId
  store.updateChatStatus(first, { hasMessages: true, expired: false })
  const tab = useWorkspaceStore.getState().tabs.find((tab) => tab.id === first)
  expect(tab).not.toHaveProperty("activeTurnId")
  expect(tab).not.toHaveProperty("error")
  expect(tab).toMatchObject({ hasMessages: true, expired: false })
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe(second)
})

it("edits and removes an excerpt only in the named side draft", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  const store = useWorkspaceStore.getState()
  store.setSession("parent")
  const first = store.addTab("chat", "parent")
  const second = store.addTab("chat", "parent")
  const excerpt = {
    id: "shared_source",
    text: "Original",
    source: { kind: "file" as const, label: "File", path: "/repo/file.ts" },
  }
  store.addChatExcerpt(first, excerpt)
  store.addChatExcerpt(second, excerpt)
  store.updateChatExcerpt(first, { ...excerpt, comment: "First only" })
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === second),
  ).toMatchObject({ excerpts: [excerpt] })
  store.removeChatExcerpt(first, excerpt.id)
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).toMatchObject({ excerpts: [] })
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === second),
  ).toMatchObject({ excerpts: [excerpt] })
})
