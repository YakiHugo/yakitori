import {
  Files,
  FolderOpen,
  GitCompareArrows,
  Globe,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Monitor,
  Plus,
  Users,
  X,
} from "lucide-react"
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { ContextExcerpt } from "../../protocol/input-context.ts"
import { connectBrowserViewRequests } from "../browser-view-requests.ts"
import { hasInputDraft, trimInputDraft } from "../input-draft.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import { useAppStore } from "../store/app-store.ts"
import { useEngineStore } from "../store/engine-store.ts"
import {
  isSideChatExpired,
  selectWorkspacePresentation,
  useWorkspaceStore,
  type WorkspaceTab,
} from "../store/workspace-store.ts"
import { BrowserPanel } from "./browser-panel.tsx"
import { CloseSideChatDialog } from "./close-side-chat-dialog.tsx"
import { ComputerPanel } from "./computer-panel.tsx"
import {
  type ContextSourceNavigation,
  ExcerptSourceLayer,
  findContextSource,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import { DiscardFileDialog } from "./file-editor.tsx"
import { SelectionActions } from "./selection-actions.tsx"
import { SideChatPanel } from "./side-chat-panel.tsx"
import { SidebarFrame } from "./sidebar-frame.tsx"
import { SubagentsWorkspace } from "./subagents-workspace.tsx"
import { WindowChrome } from "./window-chrome.tsx"
import { WorkspaceChanges } from "./workspace-changes.tsx"
import { WorkspaceFilePreview, WorkspaceFiles } from "./workspace-files.tsx"

const views = [
  { id: "changes", label: "Changes", icon: GitCompareArrows },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: Files },
  { id: "chat", label: "Side chat", icon: MessageCirclePlus },
  { id: "computer", label: "Computer", icon: Monitor },
  { id: "agents", label: "Subagents", icon: Users },
] as const

function tabLabel(tab: WorkspaceTab): string {
  if (tab.kind === "skill") return tab.name
  if (tab.kind === "file") return tab.path.split("/").at(-1) ?? tab.path
  if ((tab.kind === "browser" || tab.kind === "chat") && tab.title)
    return tab.title
  return views.find((view) => view.id === tab.kind)?.label ?? "Workspace"
}

export function WorkspaceFrame({
  children,
  heading,
}: Readonly<{ children: ReactNode; heading?: ReactNode }>) {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("yakitori.sidebarOpen") !== "false",
  )
  const { open, expanded, activeId } = useWorkspaceStore(
    selectWorkspacePresentation,
  )
  const setOpen = useWorkspaceStore((state) => state.setOpen)
  const tabs = useWorkspaceStore((state) => state.tabs)
  const nativeSessionId = useAppStore((state) => state.selection.sessionId)
  const externalEngine = useEngineStore((state) => state.engineId)
  const externalSessionId = useEngineStore((state) => state.sessionId)
  const externalCwd = useEngineStore(
    (state) =>
      state.snapshot?.session.cwd ??
      state.sessions.find((session) => session.id === state.sessionId)?.cwd,
  )
  const externalProjectId = useEngineStore(
    (state) =>
      state.snapshot?.session.projectId ??
      state.sessions.find((session) => session.id === state.sessionId)
        ?.projectId,
  )
  const external = externalEngine !== undefined
  const settingsOpen = useAppStore(
    (state) => state.settingsSection !== undefined,
  )
  const projectName = useAppStore((state) => {
    const projectId =
      external && externalSessionId !== undefined
        ? externalProjectId
        : state.selection.sessionId === undefined
          ? state.currentProject
          : state.selectedSession?.id === state.selection.sessionId
            ? state.selectedSession.projectId
            : undefined
    return state.projects.find((project) => project.id === projectId)?.name
  })
  const sessionId = external
    ? (externalSessionId ?? `engine-draft:${externalEngine}`)
    : nativeSessionId
  const visibleTabs = tabs.filter((tab) => tab.workspaceSessionId === sessionId)
  const activeFile = visibleTabs.find(
    (tab): tab is Extract<WorkspaceTab, { kind: "file" }> =>
      tab.id === activeId && tab.kind === "file",
  )
  const addTab = useWorkspaceStore((state) => state.addTab)
  const activate = useWorkspaceStore((state) => state.activate)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const askInSideChat = useWorkspaceStore((state) => state.askInSideChat)
  const selectionRevision = useAppStore(
    (state) => state.sessionSelectionIntentRevision,
  )
  const excerpts = useAppStore((state) => state.promptExcerpts)
  const addPromptExcerpt = useAppStore((state) => state.addPromptExcerpt)
  const shell = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(() =>
    Math.max(672, window.innerWidth - 275),
  )
  const [widthRatio, setWidthRatio] = useState<number | undefined>(() => {
    const saved = Number(localStorage.getItem("yakitori.workspaceSplit"))
    return saved > 0 && saved < 1 ? saved : undefined
  })
  const maximumWidth = Math.max(320, available - 480)
  const defaultWidth = Math.min(
    maximumWidth,
    Math.max(320, Math.min(440, available * 0.38)),
  )
  const width = Math.round(
    Math.min(
      maximumWidth,
      Math.max(
        320,
        widthRatio === undefined ? defaultWidth : widthRatio * available,
      ),
    ),
  )
  const setWidth = (value: number) =>
    setWidthRatio(Math.min(maximumWidth, Math.max(320, value)) / available)
  const [closing, setClosing] =
    useState<Extract<WorkspaceTab, { kind: "chat" }>>()
  const [closingFile, setClosingFile] =
    useState<Extract<WorkspaceTab, { kind: "file" }>>()
  const [adding, setAdding] = useState(false)
  const [resizing, setResizing] = useState(false)
  const apiBase = useAppStore((state) => state.apiBase)
  const nativeCwd = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? state.projects.find((project) => project.id === state.currentProject)
          ?.roots[0]
      : state.selectedSession?.id === state.selection.sessionId
        ? state.selectedSession.workingDirectory
        : undefined,
  )
  const cwd = external
    ? externalSessionId === undefined
      ? nativeCwd
      : externalCwd
    : nativeCwd
  const addToMain = (excerpt: ContextExcerpt) => {
    useWorkspaceStore.getState().setExpanded(false)
    if (window.innerWidth < 1180) setOpen(false)
    addPromptExcerpt(excerpt)
  }
  const requestClose = (tab: WorkspaceTab) => {
    if (tab.kind === "file" && tab.dirty) {
      setClosingFile(tab)
      return
    }
    if (
      tab.kind === "chat" &&
      (tab.hasMessages ||
        tab.activeTurnId ||
        hasInputDraft(trimInputDraft(tab.draft)) ||
        tab.excerpts.length)
    )
      setClosing(tab)
    else closeTab(tab.id)
  }

  useEffect(() => {
    if (external) return
    const reveal = (event: Event) => {
      const { source } = (event as CustomEvent<ContextSourceNavigation>).detail
      const workspace = useWorkspaceStore.getState()
      if (source.kind === "file")
        workspace.openFile(
          source.path,
          cwd ?? (source.path.slice(0, source.path.lastIndexOf("/")) || "/"),
        )
      else if (source.kind === "browser") workspace.openBrowser(source.url)
      else {
        const element = findContextSource(source, true)
        const tabId = element?.closest<HTMLElement>("[data-side-chat-id]")
          ?.dataset.sideChatId
        const tab = workspace.tabs.find(
          (tab) =>
            tab.id === tabId && tab.workspaceSessionId === workspace.sessionId,
        )
        if (tab) {
          workspace.activate(tab.id)
          requestAnimationFrame(() =>
            element?.scrollIntoView({ block: "center", behavior: "smooth" }),
          )
        }
      }
    }
    window.addEventListener(revealContextSourceEvent, reveal)
    return () => window.removeEventListener(revealContextSourceEvent, reveal)
  }, [external, cwd])

  useLayoutEffect(() => {
    useWorkspaceStore.getState().setSession(sessionId)
  }, [sessionId])

  useLayoutEffect(() => {
    const element = shell.current
    if (!element) return
    const update = () => {
      const sidebar = element.querySelector(".sidebar-frame")
      const bounds = element.getBoundingClientRect()
      const width = bounds.width - (sidebar?.getBoundingClientRect().width ?? 0)
      if (width > 0) {
        setAvailable(width)
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    const sidebar = element.querySelector(".sidebar-frame")
    if (sidebar) observer.observe(sidebar)
    update()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (open && activeId)
      document
        .getElementById(`workspace-tab-${activeId}`)
        ?.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        })
  }, [open, activeId])

  useEffect(() => {
    if (!resizing && widthRatio !== undefined)
      localStorage.setItem("yakitori.workspaceSplit", String(widthRatio))
  }, [widthRatio, resizing])
  useEffect(() => {
    const bridge = window.yakitoriDesktop?.browser
    if (!bridge) return
    return connectBrowserViewRequests(bridge)
  }, [])
  useEffect(() => {
    return window.yakitoriDesktop?.browser?.onShortcut((action) => {
      if (useAppStore.getState().settingsSection !== undefined) return
      if (action === "toggle-workspace")
        setOpen(!selectWorkspacePresentation(useWorkspaceStore.getState()).open)
      else if (!external || action !== "new-side-chat")
        addTab(
          action === "new-browser"
            ? "browser"
            : action === "open-files"
              ? "files"
              : "chat",
          sessionId,
        )
    })
  }, [addTab, setOpen, sessionId, external])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        useAppStore.getState().settingsSection !== undefined ||
        document.querySelector("dialog[open]") ||
        event.isComposing
      )
        return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b" &&
        !event.isComposing &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault()
        setOpen(!selectWorkspacePresentation(useWorkspaceStore.getState()).open)
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
        const key = event.key.toLowerCase()
        if (key === "t" && !event.altKey) {
          event.preventDefault()
          addTab("browser")
        }
        if (key === "p" && !event.altKey) {
          event.preventDefault()
          addTab("files")
        }
        if (key === "s" && event.altKey && !external) {
          event.preventDefault()
          addTab("chat", sessionId)
        }
      }
      if (isUnmodifiedEscape(event)) {
        if (adding) {
          event.preventDefault()
          setAdding(false)
        } else if (
          window.innerWidth < 1180 &&
          selectWorkspacePresentation(useWorkspaceStore.getState()).open
        ) {
          event.preventDefault()
          setOpen(false)
        }
      }
    }
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".workspace-add")
      )
        setAdding(false)
    }
    window.addEventListener("keydown", keydown)
    window.addEventListener("pointerdown", dismiss)
    return () => {
      window.removeEventListener("keydown", keydown)
      window.removeEventListener("pointerdown", dismiss)
    }
  }, [setOpen, addTab, adding, sessionId, external])

  return (
    <div className="window-shell">
      <WindowChrome
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        heading={heading}
        workspaceOpen={open}
        onToggleWorkspace={() => setOpen(!open)}
      />
      <div
        ref={shell}
        className="app-shell workspace-shell flex min-h-0 flex-1 text-foreground"
        data-workspace-open={open}
        data-workspace-expanded={open && expanded}
      >
        <SidebarFrame open={sidebarOpen} setOpen={setSidebarOpen} />
        {children}
        {!open && !settingsOpen && cwd && (
          <aside className="workspace-overview" aria-label="Project overview">
            <div className="workspace-project-card">
              <div className="workspace-project-heading">
                <span className="workspace-project-name" title={cwd}>
                  {projectName ||
                    cwd.split(/[\\/]/).filter(Boolean).at(-1) ||
                    cwd}
                </span>
                <button
                  type="button"
                  className="sidebar-icon"
                  aria-label="Open project files"
                  title="Open project files"
                  onClick={() => addTab("files", sessionId)}
                >
                  <FolderOpen size={16} />
                </button>
              </div>
              <button
                type="button"
                className="workspace-project-changes"
                onClick={() => addTab("changes", sessionId)}
              >
                <GitCompareArrows size={18} />
                <span>Changes</span>
              </button>
            </div>
          </aside>
        )}
        <aside
          aria-label="Workspace"
          aria-hidden={!open}
          inert={!open}
          className="workspace-frame"
          data-resizing={resizing}
          data-open={open}
          data-expanded={expanded}
          style={{ "--workspace-width": `${width}px` } as CSSProperties}
        >
          <hr
            tabIndex={0}
            aria-label="Workspace width"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={maximumWidth}
            aria-valuenow={width}
            className="workspace-resize"
            onDoubleClick={() => setWidth(defaultWidth)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return
              event.preventDefault()
              setWidth(width + (event.key === "ArrowLeft" ? 16 : -16))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizing(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return
              setWidth(window.innerWidth - event.clientX)
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
              setResizing(false)
            }}
            onLostPointerCapture={() => setResizing(false)}
          />
          <header className="workspace-header">
            <div
              className="workspace-tabs"
              role="tablist"
              aria-label="Workspace views"
            >
              {visibleTabs.map((tab, index) => {
                const { id } = tab
                const label = tabLabel(tab)
                const Icon =
                  tab.kind === "file" || tab.kind === "skill"
                    ? Files
                    : (views.find((view) => view.id === tab.kind)?.icon ??
                      Files)
                return (
                  <div
                    key={id}
                    className="workspace-tab"
                    data-active={activeId === id}
                  >
                    <button
                      id={`workspace-tab-${id}`}
                      type="button"
                      role="tab"
                      aria-selected={activeId === id}
                      aria-controls={`workspace-content-${id}`}
                      tabIndex={activeId === id ? 0 : -1}
                      title={label}
                      onClick={() => activate(id)}
                      onKeyDown={(event) => {
                        const next =
                          event.key === "ArrowRight"
                            ? (index + 1) % visibleTabs.length
                            : event.key === "ArrowLeft"
                              ? (index + visibleTabs.length - 1) %
                                visibleTabs.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? visibleTabs.length - 1
                                  : undefined
                        if (next === undefined) return
                        event.preventDefault()
                        const entry = visibleTabs[next]
                        if (!entry) return
                        activate(entry.id)
                        document
                          .getElementById(`workspace-tab-${entry.id}`)
                          ?.focus()
                      }}
                    >
                      <Icon size={14} />
                      <span>
                        {label}
                        {tab.kind === "file" && tab.dirty ? " •" : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="workspace-tab-close"
                      aria-label={`Close ${label}`}
                      onClick={() => requestClose(tab)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="workspace-add">
              <button
                type="button"
                className="sidebar-icon"
                aria-label="Add workspace tab"
                aria-haspopup="menu"
                aria-expanded={adding}
                onClick={() => setAdding((value) => !value)}
              >
                <Plus size={17} />
              </button>
              {adding && (
                <div
                  role="menu"
                  aria-label="Open workspace view"
                  className="workspace-add-menu"
                >
                  {views
                    .filter(
                      ({ id }) =>
                        !external ||
                        id === "changes" ||
                        id === "files" ||
                        id === "browser",
                    )
                    .map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          addTab(id, sessionId)
                          setAdding(false)
                        }}
                      >
                        <Icon size={17} />
                        <span>{label}</span>
                        {id === "browser" ? (
                          <kbd>⌘T</kbd>
                        ) : id === "files" ? (
                          <kbd>⌘P</kbd>
                        ) : id === "chat" ? (
                          <kbd>⌥⌘S</kbd>
                        ) : null}
                      </button>
                    ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="sidebar-icon"
              aria-label={
                expanded ? "Restore workspace size" : "Expand workspace"
              }
              title={
                expanded
                  ? "Restore split"
                  : "Fill view with content · Option-click for Chat"
              }
              onClick={(event) => {
                if (event.altKey) {
                  useWorkspaceStore.getState().setExpanded(false)
                  setOpen(false)
                } else useWorkspaceStore.getState().setExpanded(!expanded)
              }}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          </header>
          <div className="workspace-body">
            {tabs.map((tab) => (
              <div
                key={`${apiBase}:${tab.id}`}
                id={`workspace-content-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`workspace-tab-${tab.id}`}
                className="workspace-content"
                hidden={
                  !open ||
                  tab.workspaceSessionId !== sessionId ||
                  activeId !== tab.id
                }
              >
                {tab.workspaceSessionId !== sessionId &&
                (tab.kind === "changes" ||
                  tab.kind === "files" ||
                  tab.kind === "computer") ? null : tab.kind === "agents" ? (
                  <SubagentsWorkspace
                    apiBase={apiBase}
                    sourceSessionId={tab.sourceSessionId ?? sessionId}
                    selectedAgentId={tab.selectedAgentId}
                    active={open && activeId === tab.id}
                    onSelect={(id) =>
                      useWorkspaceStore.getState().selectAgent(tab.id, id)
                    }
                  />
                ) : tab.kind === "computer" ? (
                  <ComputerPanel
                    apiBase={apiBase}
                    active={open && activeId === tab.id}
                  />
                ) : tab.kind === "chat" ? (
                  <SideChatPanel
                    tab={tab}
                    apiBase={apiBase}
                    cwd={cwd}
                    active={open && activeId === tab.id}
                  />
                ) : tab.kind === "browser" ? (
                  <BrowserPanel
                    tabId={tab.id}
                    active={open && activeId === tab.id}
                    {...(tab.initialUrl === undefined
                      ? {}
                      : { initialUrl: tab.initialUrl })}
                    onTitleChange={(title) =>
                      useWorkspaceStore
                        .getState()
                        .setBrowserTitle(tab.id, title)
                    }
                    onSelection={(selection) => {
                      if (external) return
                      const workspace = selectWorkspacePresentation(
                        useWorkspaceStore.getState(),
                      )
                      if (
                        !workspace.open ||
                        workspace.activeId !== tab.id ||
                        tab.workspaceSessionId !==
                          useAppStore.getState().selection.sessionId
                      )
                        return
                      const excerpt: ContextExcerpt = {
                        id: `excerpt_${crypto.randomUUID()}`,
                        text: selection.text,
                        source: {
                          kind: "browser",
                          label: selection.title || selection.url,
                          url: selection.url,
                        },
                      }
                      if (selection.action === "chat")
                        askInSideChat(excerpt, sessionId)
                      else addToMain(excerpt)
                    }}
                  />
                ) : tab.kind === "skill" ? (
                  <WorkspaceFilePreview
                    cwd={tab.path.slice(0, tab.path.lastIndexOf("/")) || "/"}
                    path={tab.path}
                    apiBase={apiBase}
                    skill
                    {...(tab.workspaceSessionId
                      ? { skillSessionId: tab.workspaceSessionId }
                      : {})}
                    {...(tab.projectId
                      ? { skillProjectId: tab.projectId }
                      : {})}
                  />
                ) : tab.kind === "file" ? (
                  <WorkspaceFilePreview
                    cwd={tab.cwd}
                    path={tab.path}
                    apiBase={apiBase}
                    onDirtyChange={(dirty) =>
                      useWorkspaceStore.getState().setFileDirty(tab.id, dirty)
                    }
                  />
                ) : cwd ? (
                  <>
                    <div className="workspace-root" title={cwd}>
                      {cwd}
                    </div>
                    {tab.kind === "files" ? (
                      <WorkspaceFiles
                        key={sessionId ?? "draft"}
                        cwd={cwd}
                        apiBase={apiBase}
                        onOpenFile={(path) => openFile(path, cwd)}
                      />
                    ) : (
                      <WorkspaceChanges
                        key={sessionId ?? "draft"}
                        cwd={cwd}
                        apiBase={apiBase}
                      />
                    )}
                  </>
                ) : (
                  <div className="workspace-empty">
                    <Files size={28} strokeWidth={1.25} />
                    <strong>Your workspace, alongside your conversation</strong>
                    <p>
                      Select a project or open a conversation to browse files
                      and review changes.
                    </p>
                  </div>
                )}
              </div>
            ))}
            {visibleTabs.length === 0 && !external && (
              <div className="workspace-empty">
                <MessageCirclePlus size={30} strokeWidth={1.25} />
                <strong>Open something alongside your conversation</strong>
                <p>
                  Browse the web, read a file, or ask a question in a temporary
                  side chat.
                </p>
                <button
                  type="button"
                  className="rounded-lg border px-3 py-2 text-foreground"
                  onClick={() => addTab("chat", sessionId)}
                >
                  New side chat
                </button>
              </div>
            )}
            {activeFile && expanded ? (
              <aside
                className="workspace-file-explorer"
                aria-label="Project files"
              >
                <WorkspaceFiles
                  cwd={activeFile.cwd}
                  apiBase={apiBase}
                  onOpenFile={(path) => openFile(path, activeFile.cwd)}
                />
              </aside>
            ) : null}
          </div>
        </aside>
        {closingFile ? (
          <DiscardFileDialog
            name={tabLabel(closingFile)}
            onCancel={() => setClosingFile(undefined)}
            onDiscard={() => {
              closeTab(closingFile.id)
              setClosingFile(undefined)
            }}
          />
        ) : null}
        {!external && (
          <>
            <ExcerptSourceLayer
              items={[
                ...excerpts.map((excerpt, index) => ({
                  excerpt,
                  number: index + 1,
                  ownerId: `main:${selectionRevision}`,
                  conversation: "main conversation",
                })),
                ...visibleTabs.flatMap((tab) =>
                  tab.kind === "chat" &&
                  !isSideChatExpired(tab) &&
                  open &&
                  tab.id === activeId
                    ? tab.excerpts.map((excerpt, index) => ({
                        excerpt,
                        number: index + 1,
                        ownerId: `side:${tab.id}`,
                        conversation: tabLabel(tab),
                      }))
                    : [],
                ),
              ]}
            />
            <SelectionActions
              readOnlySideChatIds={visibleTabs.flatMap((tab) =>
                tab.kind === "chat" && isSideChatExpired(tab) ? [tab.id] : [],
              )}
              key={`${apiBase}:${selectionRevision}:${open}:${activeId}`}
              onAddToConversation={(excerpt, sideChatId) => {
                const app = useAppStore.getState()
                if (
                  app.apiBase !== apiBase ||
                  app.sessionSelectionIntentRevision !== selectionRevision
                )
                  return
                if (sideChatId)
                  useWorkspaceStore
                    .getState()
                    .addChatExcerpt(sideChatId, excerpt)
                else addToMain(excerpt)
              }}
              onAskInSideChat={(excerpt, sideChatId) => {
                const app = useAppStore.getState()
                if (
                  app.apiBase !== apiBase ||
                  app.sessionSelectionIntentRevision !== selectionRevision
                )
                  return
                askInSideChat(excerpt, sessionId, sideChatId)
              }}
            />
          </>
        )}
        {closing && (
          <CloseSideChatDialog
            title={tabLabel(closing)}
            onCancel={() => setClosing(undefined)}
            onConfirm={() => {
              closeTab(closing.id)
              setClosing(undefined)
            }}
          />
        )}
      </div>
    </div>
  )
}
