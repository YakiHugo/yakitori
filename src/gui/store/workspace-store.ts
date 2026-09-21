import { create } from "zustand"
import type { ImageAttachment } from "../../kernel/events.ts"
import type { ContextExcerpt } from "../conversation-context.ts"

export type WorkspaceView =
  | "changes"
  | "files"
  | "browser"
  | "chat"
  | "computer"
  | "agents"
export type WorkspaceTab =
  | { id: string; kind: "changes" | "files" | "computer" }
  | { id: string; kind: "browser"; initialUrl?: string; title?: string }
  | { id: string; kind: "file"; path: string; cwd: string; dirty?: boolean }
  | {
      id: string
      kind: "agents"
      sourceSessionId?: string
      selectedAgentId?: string
    }
  | {
      id: string
      kind: "chat"
      draft: string
      excerpts: readonly ContextExcerpt[]
      attachments: readonly ImageAttachment[]
      sourceSessionId?: string
      title?: string
      hasMessages?: boolean
      activeTurnId?: string
      error?: string
    }

type WorkspaceStore = {
  open: boolean
  expanded: boolean
  tabs: readonly WorkspaceTab[]
  activeId: string | undefined
  setOpen(open: boolean): void
  setExpanded(expanded: boolean): void
  activate(id: string): void
  addTab(kind: WorkspaceView, sourceSessionId?: string): string
  closeTab(id: string): void
  openFile(path: string, cwd: string): void
  setFileDirty(id: string, dirty: boolean): void
  openBrowser(url: string): void
  openAgents(sourceSessionId: string, agentId?: string): void
  selectAgent(tabId: string, agentId?: string): void
  askInSideChat(excerpt: ContextExcerpt, sourceSessionId?: string): void
  updateChatStatus(
    id: string,
    status: { hasMessages: boolean; activeTurnId?: string; error?: string },
  ): void
  setBrowserTitle(id: string, title: string): void
  updateChatDraft(
    id: string,
    draft: string,
    excerpts: readonly ContextExcerpt[],
    attachments?: readonly ImageAttachment[],
  ): void
}

function initialTabs(): WorkspaceTab[] {
  // Only ordinary workspace views survive app restarts. Chat contents and web
  // tabs belong to the current window, never localStorage.
  const saved = localStorage.getItem("yakitori.workspaceTab")
  const kind = saved === "files" || saved === "computer" ? saved : "changes"
  return [{ id: kind, kind }]
}

const tabs = initialTabs()
export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  open: false,
  expanded: false,
  tabs,
  activeId: tabs[0]?.id,
  setOpen: (open) => set({ open }),
  setExpanded: (expanded) => set({ expanded }),
  activate(id) {
    const tab = get().tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (
      tab.kind === "changes" ||
      tab.kind === "files" ||
      tab.kind === "computer"
    )
      localStorage.setItem("yakitori.workspaceTab", tab.kind)
    get().setOpen(true)
    set({ activeId: id })
  },
  addTab(kind, sourceSessionId) {
    const reusable =
      kind === "changes" ||
      kind === "files" ||
      kind === "computer" ||
      kind === "agents"
        ? get().tabs.find(
            (tab) =>
              tab.kind === kind &&
              (tab.kind !== "agents" ||
                tab.sourceSessionId === sourceSessionId),
          )
        : undefined
    if (reusable) {
      get().activate(reusable.id)
      return reusable.id
    }
    const id = `workspace_${crypto.randomUUID()}`
    const count = get().tabs.filter((tab) => tab.kind === "chat").length
    const tab: WorkspaceTab =
      kind === "chat"
        ? {
            id,
            kind,
            draft: "",
            excerpts: [],
            attachments: [],
            title: count === 0 ? "Side chat" : `Side chat ${count + 1}`,
            ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
          }
        : kind === "agents"
          ? { id, kind, ...(sourceSessionId ? { sourceSessionId } : {}) }
          : { id, kind }
    set({ tabs: [...get().tabs, tab] })
    get().activate(id)
    return id
  },
  closeTab(id) {
    const current = get()
    const index = current.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const remaining = current.tabs.filter((tab) => tab.id !== id)
    set({
      tabs: remaining,
      activeId:
        current.activeId === id
          ? remaining[Math.min(index, remaining.length - 1)]?.id
          : current.activeId,
    })
  },
  openFile(path, cwd) {
    const existing = get().tabs.find(
      (tab) => tab.kind === "file" && tab.cwd === cwd && tab.path === path,
    )
    if (existing) return get().activate(existing.id)
    const id = `workspace_${crypto.randomUUID()}`
    set({ tabs: [...get().tabs, { id, kind: "file", path, cwd }] })
    get().activate(id)
  },
  setFileDirty(id, dirty) {
    const current = get().tabs.find((tab) => tab.id === id)
    if (current?.kind !== "file" || Boolean(current.dirty) === dirty) return
    set({
      tabs: get().tabs.map((tab) =>
        tab.id === id ? { ...current, dirty } : tab,
      ),
    })
  },
  openBrowser(initialUrl) {
    const id = `workspace_${crypto.randomUUID()}`
    set({ tabs: [...get().tabs, { id, kind: "browser", initialUrl }] })
    get().activate(id)
  },
  openAgents(sourceSessionId, agentId) {
    const id = get().addTab("agents", sourceSessionId)
    get().selectAgent(id, agentId)
    set({ expanded: false })
  },
  selectAgent(tabId, agentId) {
    set({
      tabs: get().tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== "agents") return tab
        const { selectedAgentId: _, ...rest } = tab
        return { ...rest, ...(agentId ? { selectedAgentId: agentId } : {}) }
      }),
    })
  },
  askInSideChat(excerpt, sourceSessionId) {
    const state = get()
    const available = state.tabs.filter(
      (tab) =>
        tab.kind === "chat" &&
        !tab.activeTurnId &&
        tab.sourceSessionId === sourceSessionId,
    )
    const current =
      available.find((tab) => tab.id === state.activeId) ?? available.at(-1)
    const id = current?.id ?? get().addTab("chat", sourceSessionId)
    set({
      tabs: get().tabs.map((tab) =>
        tab.id === id && tab.kind === "chat"
          ? { ...tab, excerpts: [...tab.excerpts, excerpt] }
          : tab,
      ),
    })
    get().activate(id)
  },
  updateChatStatus(id, status) {
    const update = (tab: WorkspaceTab): WorkspaceTab => {
      if (tab.id !== id || tab.kind !== "chat") return tab
      const { activeTurnId: _active, error: _error, ...rest } = tab
      return { ...rest, ...status }
    }
    const current = get()
    const tab = current.tabs.find((entry) => entry.id === id)
    if (
      tab?.kind !== "chat" ||
      (tab.hasMessages === status.hasMessages &&
        tab.activeTurnId === status.activeTurnId &&
        tab.error === status.error)
    )
      return
    set({ tabs: current.tabs.map(update) })
  },
  setBrowserTitle(id, title) {
    const tab = get().tabs.find((entry) => entry.id === id)
    if (tab?.kind !== "browser" || tab.title === title) return
    set({
      tabs: get().tabs.map((entry) =>
        entry.id === id ? { ...tab, title } : entry,
      ),
    })
  },
  updateChatDraft(id, draft, excerpts, attachments) {
    const update = (tab: Extract<WorkspaceTab, { kind: "chat" }>) => ({
      ...tab,
      draft,
      excerpts,
      ...(attachments === undefined ? {} : { attachments }),
    })
    const current = get()
    set({
      tabs: current.tabs.map((tab) =>
        tab.id === id && tab.kind === "chat" ? update(tab) : tab,
      ),
    })
  },
}))
