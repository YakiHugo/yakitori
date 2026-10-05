import type { InputPart } from "../../kernel/events.ts"
import { create } from "zustand"
import type { ContextExcerpt } from "../conversation-context.ts"

export type WorkspaceView =
  | "changes"
  | "files"
  | "browser"
  | "chat"
  | "computer"
  | "agents"
export type WorkspaceTab = (
  | { id: string; kind: "changes" | "files" | "computer" }
  | { id: string; kind: "browser"; initialUrl?: string; title?: string }
  | { id: string; kind: "file"; path: string; cwd: string; dirty?: boolean }
  | {
      id: string
      kind: "skill"
      path: string
      name: string
      projectId?: string
    }
  | {
      id: string
      kind: "agents"
      sourceSessionId?: string
      selectedAgentId?: string
    }
  | {
      id: string
      kind: "chat"
      draft: readonly InputPart[]
      composerFocusRevision?: number
      excerpts: readonly ContextExcerpt[]
      sourceSessionId?: string
      title?: string
      hasMessages?: boolean
      activeTurnId?: string
      expiresAt?: string
      error?: string
    }
) & { workspaceSessionId?: string | undefined }

type WorkspaceStore = {
  open: boolean
  expanded: boolean
  tabs: readonly WorkspaceTab[]
  activeId: string | undefined
  sessionId: string | undefined
  // Only inactive sessions are stored here; the active session uses the flat fields.
  presentationBySession: Record<
    string,
    { open: boolean; expanded: boolean; activeId: string | undefined }
  >
  setOpen(open: boolean): void
  setExpanded(expanded: boolean): void
  setSession(sessionId: string | undefined): void
  removeSession(sessionId: string): void
  activate(id: string): void
  addTab(kind: WorkspaceView, sourceSessionId?: string): string
  closeTab(id: string): void
  openFile(path: string, cwd: string): void
  openSkill(path: string, name: string, projectId?: string): void
  setFileDirty(id: string, dirty: boolean): void
  openBrowser(url: string): void
  openAgents(sourceSessionId: string, agentId?: string): void
  selectAgent(tabId: string, agentId?: string): void
  askInSideChat(
    excerpt: ContextExcerpt,
    sourceSessionId?: string,
    sourceTabId?: string,
  ): void
  addChatExcerpt(id: string, excerpt: ContextExcerpt): void
  updateChatExcerpt(excerpt: ContextExcerpt): void
  removeChatExcerpt(id: string): void
  updateChatStatus(
    id: string,
    status: {
      hasMessages: boolean
      activeTurnId?: string
      expiresAt?: string
      error?: string
    },
  ): void
  setBrowserTitle(id: string, title: string): void
  updateChatDraft(
    id: string,
    draft: readonly InputPart[],
    excerpts: readonly ContextExcerpt[],
  ): void
}

const tabs: WorkspaceTab[] = [{ id: "changes", kind: "changes" }]
export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  open: false,
  expanded: false,
  tabs,
  activeId: tabs[0]?.id,
  sessionId: undefined,
  presentationBySession: {},
  setOpen: (open) => set({ open }),
  setExpanded: (expanded) => set({ expanded }),
  setSession(sessionId) {
    const current = get()
    if (current.sessionId === sessionId) return
    const visible = current.tabs.filter(
      (tab) => tab.workspaceSessionId === sessionId,
    )
    const key = sessionId ?? ""
    const remembered = current.presentationBySession[key]
    const created = visible.length === 0 && !remembered
    const tabs = created
      ? [
          ...current.tabs,
          {
            id: `workspace_${crypto.randomUUID()}`,
            kind: "changes" as const,
            ...(sessionId === undefined
              ? {}
              : { workspaceSessionId: sessionId }),
          },
        ]
      : current.tabs
    const activeId = visible.some((tab) => tab.id === remembered?.activeId)
      ? remembered?.activeId
      : (visible[0]?.id ?? (created ? tabs.at(-1)?.id : undefined))
    const { [key]: _restored, ...inactive } = current.presentationBySession
    set({
      sessionId,
      tabs,
      open: remembered?.open ?? current.open,
      expanded: remembered?.expanded ?? current.expanded,
      presentationBySession: {
        ...inactive,
        [current.sessionId ?? ""]: {
          open: current.open,
          expanded: current.expanded,
          activeId: current.activeId,
        },
      },
      activeId,
    })
  },
  removeSession(sessionId) {
    if (get().sessionId === sessionId) get().setSession(undefined)
    const state = get()
    const { [sessionId]: _removed, ...presentationBySession } =
      state.presentationBySession
    set({
      tabs: state.tabs.filter((tab) => tab.workspaceSessionId !== sessionId),
      presentationBySession,
    })
  },
  activate(id) {
    const tab = get().tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.workspaceSessionId !== get().sessionId) return
    set({ open: true, activeId: id })
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
              tab.workspaceSessionId === get().sessionId &&
              (tab.kind !== "agents" ||
                tab.sourceSessionId === sourceSessionId),
          )
        : undefined
    if (reusable) {
      get().activate(reusable.id)
      return reusable.id
    }
    const id = `workspace_${crypto.randomUUID()}`
    const count = get().tabs.filter(
      (tab) =>
        tab.kind === "chat" && tab.workspaceSessionId === get().sessionId,
    ).length
    const tab: WorkspaceTab =
      kind === "chat"
        ? {
            id,
            kind,
            ...(get().sessionId === undefined
              ? {}
              : { workspaceSessionId: get().sessionId }),
            draft: [],
            excerpts: [],
            title: count === 0 ? "Side chat" : `Side chat ${count + 1}`,
            ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
          }
        : kind === "agents"
          ? {
              id,
              kind,
              ...(get().sessionId === undefined
                ? {}
                : { workspaceSessionId: get().sessionId }),
              ...(sourceSessionId ? { sourceSessionId } : {}),
            }
          : {
              id,
              kind,
              ...(get().sessionId === undefined
                ? {}
                : { workspaceSessionId: get().sessionId }),
            }
    set({ tabs: [...get().tabs, tab] })
    get().activate(id)
    return id
  },
  closeTab(id) {
    const current = get()
    const index = current.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const remaining = current.tabs.filter((tab) => tab.id !== id)
    const owner = current.tabs[index]?.workspaceSessionId
    const ownerTabs = remaining.filter(
      (tab) => tab.workspaceSessionId === owner,
    )
    const key = owner ?? ""
    const inactive = current.presentationBySession[key]
    set({
      tabs: remaining,
      activeId:
        current.activeId === id ? ownerTabs.at(-1)?.id : current.activeId,
      ...(inactive?.activeId === id
        ? {
            presentationBySession: {
              ...current.presentationBySession,
              [key]: { ...inactive, activeId: ownerTabs.at(-1)?.id },
            },
          }
        : {}),
    })
  },
  openFile(path, cwd) {
    const existing = get().tabs.find(
      (tab) =>
        tab.kind === "file" &&
        tab.workspaceSessionId === get().sessionId &&
        tab.cwd === cwd &&
        tab.path === path,
    )
    if (existing) return get().activate(existing.id)
    const id = `workspace_${crypto.randomUUID()}`
    set({
      tabs: [
        ...get().tabs,
        {
          id,
          kind: "file",
          path,
          cwd,
          ...(get().sessionId === undefined
            ? {}
            : { workspaceSessionId: get().sessionId }),
        },
      ],
    })
    get().activate(id)
  },
  openSkill(path, name, projectId) {
    const current = get()
    const existing = current.tabs.find(
      (tab) =>
        tab.kind === "skill" &&
        tab.workspaceSessionId === current.sessionId &&
        tab.projectId === projectId &&
        tab.path === path,
    )
    if (existing) return get().activate(existing.id)
    const id = `workspace_${crypto.randomUUID()}`
    set({
      tabs: [
        ...current.tabs,
        {
          id,
          kind: "skill",
          path,
          name,
          ...(projectId === undefined ? {} : { projectId }),
          ...(current.sessionId === undefined
            ? {}
            : { workspaceSessionId: current.sessionId }),
        },
      ],
    })
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
    set({
      tabs: [
        ...get().tabs,
        {
          id,
          kind: "browser",
          initialUrl,
          ...(get().sessionId === undefined
            ? {}
            : { workspaceSessionId: get().sessionId }),
        },
      ],
    })
    get().activate(id)
  },
  openAgents(sourceSessionId, agentId) {
    const id = get().addTab("agents", sourceSessionId)
    get().selectAgent(id, agentId)
    get().setExpanded(false)
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
  askInSideChat(excerpt, sourceSessionId, sourceTabId) {
    const state = get()
    const available = state.tabs.filter(
      (tab) =>
        tab.kind === "chat" &&
        tab.id !== sourceTabId &&
        tab.workspaceSessionId === state.sessionId &&
        !tab.activeTurnId &&
        (tab.expiresAt === undefined ||
          Date.now() < Date.parse(tab.expiresAt)) &&
        tab.sourceSessionId === sourceSessionId,
    )
    const current =
      available.find((tab) => tab.id === state.activeId) ??
      (available.length === 1 ? available[0] : undefined)
    const id = current?.id ?? get().addTab("chat", sourceSessionId)
    get().addChatExcerpt(id, excerpt)
  },
  addChatExcerpt(id, excerpt) {
    const state = get()
    if (
      !state.tabs.some(
        (tab) =>
          tab.id === id &&
          tab.kind === "chat" &&
          tab.workspaceSessionId === state.sessionId,
      )
    )
      return
    set({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.kind === "chat"
          ? {
              ...tab,
              excerpts: [...tab.excerpts, excerpt],
              composerFocusRevision: (tab.composerFocusRevision ?? 0) + 1,
            }
          : tab,
      ),
    })
    get().activate(id)
  },
  updateChatExcerpt(excerpt) {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "chat" && tab.workspaceSessionId === state.sessionId
          ? {
              ...tab,
              excerpts: tab.excerpts.map((item) =>
                item.id === excerpt.id ? excerpt : item,
              ),
            }
          : tab,
      ),
    }))
  },
  removeChatExcerpt(id) {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "chat" && tab.workspaceSessionId === state.sessionId
          ? { ...tab, excerpts: tab.excerpts.filter((item) => item.id !== id) }
          : tab,
      ),
    }))
  },
  updateChatStatus(id, status) {
    const update = (tab: WorkspaceTab): WorkspaceTab => {
      if (tab.id !== id || tab.kind !== "chat") return tab
      const {
        activeTurnId: _active,
        expiresAt: _expires,
        error: _error,
        ...rest
      } = tab
      return { ...rest, ...status }
    }
    const current = get()
    const tab = current.tabs.find((entry) => entry.id === id)
    if (
      tab?.kind !== "chat" ||
      (tab.hasMessages === status.hasMessages &&
        tab.activeTurnId === status.activeTurnId &&
        tab.expiresAt === status.expiresAt &&
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
  updateChatDraft(id, draft, excerpts) {
    const update = (tab: Extract<WorkspaceTab, { kind: "chat" }>) => ({
      ...tab,
      draft,
      excerpts,
    })
    const current = get()
    set({
      tabs: current.tabs.map((tab) =>
        tab.id === id && tab.kind === "chat" ? update(tab) : tab,
      ),
    })
  },
}))
