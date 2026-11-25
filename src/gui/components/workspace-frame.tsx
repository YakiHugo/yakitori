import { useTranslation } from "../i18n/use-translation.ts"
import {
  Files,
  FolderOpen,
  GitCompareArrows,
  Maximize2,
  Minimize2,
  PanelRight,
  SlidersHorizontal,
} from "lucide-react"
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import type { ContextExcerpt } from "../../protocol/input-context.ts"
import { connectBrowserViewRequests } from "../browser-view-requests.ts"
import { useWorkspaceGitStatus } from "../hooks/use-workspace-git-status.ts"
import { hasInputDraft, trimInputDraft } from "../input-draft.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import { selectCurrentThreadId, useAppStore } from "../store/app-store.ts"
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
  requestExcerptEdit,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import { DiscardFileDialog } from "./file-editor.tsx"
import { SelectionActions } from "./selection-actions.tsx"
import { SideChatPanel } from "./side-chat-panel.tsx"
import { SidebarFrame } from "./sidebar-frame.tsx"
import { SubagentsWorkspace } from "./subagents-workspace.tsx"
import { WindowChrome } from "./window-chrome.tsx"
import { WorkspaceChangeSummary } from "./workspace-change-summary.tsx"
import { WorkspaceChanges } from "./workspace-changes.tsx"
import { WorkspaceFilePreview, WorkspaceFiles } from "./workspace-files.tsx"
import { WorkspaceLauncher } from "./workspace-launcher.tsx"
import { WorkspaceTabStrip } from "./workspace-tab-strip.tsx"
import { workspaceTabPresentation } from "./workspace-views.ts"

const emptyLauncher: WorkspaceTab = {
  id: "workspace-launcher",
  kind: "launcher",
}

export function WorkspaceFrame({
  children,
  heading,
  sessionActions,
  usageAccountId,
}: Readonly<{
  children: ReactNode
  heading?: ReactNode
  sessionActions?: ReactNode
  usageAccountId?: string | undefined
}>) {
  const { t } = useTranslation()
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("yakitori.sidebarOpen") !== "false",
  )
  const { open, expanded, activeId } = useWorkspaceStore(
    selectWorkspacePresentation,
  )
  const setOpen = useWorkspaceStore((state) => state.setOpen)
  const tabs = useWorkspaceStore((state) => state.tabs)
  const nativeSessionId = useAppStore((state) => state.selection.sessionId)
  const nativeThreadId = useAppStore(selectCurrentThreadId)
  const sessionThreadIds = useAppStore((state) => state.sessionThreadIds)
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
  const workspaceSessionId = external ? sessionId : nativeThreadId
  const visibleTabs = tabs.filter(
    (tab) => tab.workspaceSessionId === workspaceSessionId,
  )
  const contentTabs = tabs.filter((tab) => tab.kind !== "launcher")
  const newTab = visibleTabs.find((tab) => tab.kind === "launcher")
  const launcher =
    newTab ?? (activeId === undefined ? emptyLauncher : undefined)
  const selectedTabId = activeId ?? launcher?.id ?? emptyLauncher.id
  const sessionIdForTab = (tab: WorkspaceTab) => {
    const owner = tab.workspaceSessionId
    if (owner === undefined) return undefined
    if (owner === workspaceSessionId) return sessionId
    return (
      Object.entries(sessionThreadIds).find(
        ([, threadId]) => threadId === owner,
      )?.[0] ?? owner
    )
  }
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
  const workspaceToggle = useRef<HTMLButtonElement>(null)
  const launcherInput = useRef<HTMLInputElement>(null)
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
  const [resizing, setResizing] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const overviewTrigger = useRef<HTMLButtonElement>(null)
  const overview = useRef<HTMLElement>(null)
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
  const mainVisible = !open || !expanded
  const canOpenOverview = Boolean(cwd) && !settingsOpen && mainVisible
  const showOverview = overviewOpen && canOpenOverview
  const overviewGit = useWorkspaceGitStatus({
    cwd,
    apiBase,
    active: showOverview,
  })
  const addToMain = (excerpt: ContextExcerpt) => {
    useWorkspaceStore.getState().setExpanded(false)
    if (window.innerWidth < 1180) setOpen(false)
    addPromptExcerpt(excerpt)
  }
  const focusSelectedTab = () => {
    const workspace = selectWorkspacePresentation(useWorkspaceStore.getState())
    document
      .getElementById(`workspace-tab-${workspace.activeId ?? emptyLauncher.id}`)
      ?.focus()
  }
  const openFromLauncher = (openView: () => void) => {
    flushSync(() => {
      openView()
      if (newTab) closeTab(newTab.id)
    })
    focusSelectedTab()
  }
  const requestClose = (tab: WorkspaceTab) => {
    if (
      tab === emptyLauncher ||
      (tab.kind === "launcher" && visibleTabs.length === 1)
    ) {
      flushSync(() => {
        if (tab !== emptyLauncher) closeTab(tab.id)
        setOpen(false)
      })
      workspaceToggle.current?.focus()
      return
    }
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
    else {
      flushSync(() => closeTab(tab.id))
      focusSelectedTab()
    }
  }
  const projectOverviewTrigger = canOpenOverview ? (
    <button
      ref={overviewTrigger}
      type="button"
      className="sidebar-icon workspace-overview-trigger"
      aria-label={
        overviewOpen ? t("Hide project overview") : t("Show project overview")
      }
      aria-expanded={overviewOpen}
      aria-controls={overviewOpen ? "workspace-project-overview" : undefined}
      title={
        overviewOpen ? t("Hide project overview") : t("Show project overview")
      }
      onClick={() => {
        if (!overviewOpen && open && window.innerWidth < 960) setOpen(false)
        setOverviewOpen(!overviewOpen)
      }}
    >
      <SlidersHorizontal size={16} />
    </button>
  ) : null

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
    useWorkspaceStore.getState().setSession(workspaceSessionId)
  }, [workspaceSessionId])

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
    if (!resizing && widthRatio !== undefined)
      localStorage.setItem("yakitori.workspaceSplit", String(widthRatio))
  }, [widthRatio, resizing])
  useEffect(() => {
    if (!canOpenOverview) setOverviewOpen(false)
  }, [canOpenOverview])
  // A transient popover must not reappear in a different conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing sessions closes the popover without being read by the effect.
  useEffect(() => {
    setOverviewOpen(false)
  }, [workspaceSessionId])

  useEffect(() => {
    if (!showOverview) return
    overview.current?.focus()
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (overview.current?.contains(target) ||
        overviewTrigger.current?.contains(target))
    const dismissOutside = (event: Event) => {
      if (!inside(event.target)) setOverviewOpen(false)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (!isUnmodifiedEscape(event)) return
      event.preventDefault()
      event.stopPropagation()
      setOverviewOpen(false)
      overviewTrigger.current?.focus()
    }
    document.addEventListener("pointerdown", dismissOutside)
    document.addEventListener("focusin", dismissOutside)
    document.addEventListener("keydown", dismissEscape)
    return () => {
      document.removeEventListener("pointerdown", dismissOutside)
      document.removeEventListener("focusin", dismissOutside)
      document.removeEventListener("keydown", dismissEscape)
    }
  }, [showOverview])

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
      if (
        isUnmodifiedEscape(event) &&
        window.innerWidth < 1180 &&
        selectWorkspacePresentation(useWorkspaceStore.getState()).open
      ) {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [setOpen, addTab, sessionId, external])

  return (
    <div
      className="window-shell"
      style={{ "--workspace-width": `${width}px` } as CSSProperties}
    >
      <WindowChrome
        usageAccountId={usageAccountId}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        heading={
          <>
            {heading}
            {mainVisible &&
              !settingsOpen &&
              (sessionActions || projectOverviewTrigger) && (
                <div className="window-session-actions">
                  {sessionActions}
                  {projectOverviewTrigger}
                </div>
              )}
          </>
        }
        workspaceToolbar={
          !settingsOpen && (
            <div
              className="workspace-header"
              data-open={open}
              data-expanded={open && expanded}
            >
              {open && (
                <>
                  <WorkspaceTabStrip
                    tabs={
                      launcher === emptyLauncher
                        ? [...visibleTabs, launcher]
                        : visibleTabs
                    }
                    activeId={selectedTabId}
                    onActivate={(id) => {
                      if (id !== emptyLauncher.id) activate(id)
                    }}
                    onClose={requestClose}
                    onNewTab={() => {
                      if (launcher !== emptyLauncher)
                        flushSync(() => addTab("launcher"))
                      launcherInput.current?.focus()
                    }}
                  />
                  <button
                    type="button"
                    className="sidebar-icon"
                    aria-label={
                      expanded
                        ? t("Restore workspace size")
                        : t("Expand workspace")
                    }
                    title={
                      expanded
                        ? t("Restore split")
                        : t("Fill view with content · Option-click for Chat")
                    }
                    onClick={(event) => {
                      if (event.altKey) {
                        useWorkspaceStore.getState().setExpanded(false)
                        setOpen(false)
                      } else useWorkspaceStore.getState().setExpanded(!expanded)
                    }}
                  >
                    {expanded ? (
                      <Minimize2 size={15} />
                    ) : (
                      <Maximize2 size={15} />
                    )}
                  </button>
                </>
              )}
              <button
                ref={workspaceToggle}
                type="button"
                className="sidebar-icon workspace-toggle"
                aria-label={open ? t("Hide workspace") : t("Show workspace")}
                aria-expanded={open}
                aria-controls="workspace-panel"
                title={
                  open ? t("Hide workspace (⌘⇧B)") : t("Show workspace (⌘⇧B)")
                }
                onClick={() => setOpen(!open)}
              >
                <PanelRight size={16} />
              </button>
            </div>
          )
        }
      />
      <div
        ref={shell}
        className="app-shell workspace-shell flex min-h-0 flex-1 text-foreground"
        data-workspace-open={open}
        data-workspace-expanded={open && expanded}
      >
        <SidebarFrame open={sidebarOpen} setOpen={setSidebarOpen} />
        <div className="workspace-main">
          {children}
          {showOverview && cwd && (
            <aside
              ref={overview}
              id="workspace-project-overview"
              className="workspace-overview"
              role="dialog"
              aria-label={t("Project overview")}
              tabIndex={-1}
            >
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
                    aria-label={t("Open project files")}
                    title={t("Open project files")}
                    onClick={() => {
                      setOverviewOpen(false)
                      addTab("files", sessionId)
                    }}
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
                <div className="workspace-project-body">
                  <button
                    type="button"
                    className="workspace-project-changes"
                    onClick={() => {
                      setOverviewOpen(false)
                      addTab("changes", sessionId)
                    }}
                  >
                    <GitCompareArrows size={18} />
                    <span>{t("Changes")}</span>
                  </button>
                  {overviewGit.status?.branch ? (
                    <p className="workspace-project-branch">
                      {overviewGit.status.branch}
                    </p>
                  ) : null}
                  {overviewGit.error ? (
                    <div className="workspace-project-status" role="alert">
                      <p>{overviewGit.error}</p>
                      <button type="button" onClick={overviewGit.refresh}>
                        {t("Retry")}
                      </button>
                    </div>
                  ) : overviewGit.loading && !overviewGit.status ? (
                    <p className="workspace-project-status" role="status">
                      {t("Loading changes…")}
                    </p>
                  ) : overviewGit.status ? (
                    <WorkspaceChangeSummary
                      status={overviewGit.status}
                      onReview={(path, staged) => {
                        setOverviewOpen(false)
                        useWorkspaceStore.getState().openChanges(path, staged)
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </aside>
          )}
        </div>
        <aside
          id="workspace-panel"
          aria-label={t("Workspace")}
          aria-hidden={!open}
          inert={!open}
          className="workspace-frame"
          data-resizing={resizing}
          data-open={open}
          data-expanded={expanded}
        >
          <hr
            tabIndex={0}
            aria-label={t("Workspace width")}
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
          <div className="workspace-body">
            {contentTabs.map((tab) => (
              <div
                key={`${apiBase}:${tab.id}`}
                id={`workspace-content-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`workspace-tab-${tab.id}`}
                className="workspace-content"
                data-kind={tab.kind}
                hidden={
                  !open ||
                  tab.workspaceSessionId !== workspaceSessionId ||
                  activeId !== tab.id
                }
              >
                {tab.workspaceSessionId !== workspaceSessionId &&
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
                          selectCurrentThreadId(useAppStore.getState())
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
                    {...(sessionIdForTab(tab)
                      ? { skillSessionId: sessionIdForTab(tab) as string }
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
                    {tab.kind === "files" ? (
                      <div className="workspace-root" title={cwd}>
                        {cwd}
                      </div>
                    ) : null}
                    {tab.kind === "files" ? (
                      <WorkspaceFiles
                        key={workspaceSessionId}
                        cwd={cwd}
                        apiBase={apiBase}
                        onOpenFile={(path) => openFile(path, cwd)}
                      />
                    ) : (
                      <WorkspaceChanges
                        key={workspaceSessionId}
                        cwd={cwd}
                        apiBase={apiBase}
                        active={open && activeId === tab.id}
                        target={tab.kind === "changes" ? tab.target : undefined}
                      />
                    )}
                  </>
                ) : (
                  <div className="workspace-empty">
                    <Files size={28} strokeWidth={1.25} />
                    <strong>
                      {t("Your workspace, alongside your conversation")}
                    </strong>
                    <p>
                      {t(
                        "Select a project or open a conversation to browse files and review changes.",
                      )}
                    </p>
                  </div>
                )}
              </div>
            ))}
            {launcher && (
              <div
                key={`${apiBase}:${workspaceSessionId}:${launcher.id}`}
                id={`workspace-content-${launcher.id}`}
                role="tabpanel"
                aria-labelledby={`workspace-tab-${launcher.id}`}
                className="workspace-content"
                data-kind="launcher"
                hidden={!open || selectedTabId !== launcher.id}
              >
                <WorkspaceLauncher
                  active={open && selectedTabId === launcher.id}
                  apiBase={apiBase}
                  cwd={cwd}
                  external={external}
                  inputRef={launcherInput}
                  onOpenView={(view) =>
                    openFromLauncher(() => addTab(view, sessionId))
                  }
                  onOpenFile={(path, root) =>
                    openFromLauncher(() => openFile(path, root))
                  }
                  onOpenUrl={(url) =>
                    openFromLauncher(() =>
                      useWorkspaceStore.getState().openBrowser(url),
                    )
                  }
                />
              </div>
            )}
            {activeFile && expanded ? (
              <aside
                className="workspace-file-explorer"
                aria-label={t("Project files")}
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
            name={workspaceTabPresentation(closingFile, t).label}
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
                  ownerId: `main:${nativeThreadId}`,
                  conversation: t("main conversation"),
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
                        conversation: workspaceTabPresentation(tab, t).label,
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
                // Mount the card before asking its owner to edit the new quote.
                flushSync(() => {
                  if (sideChatId)
                    useWorkspaceStore
                      .getState()
                      .addChatExcerpt(sideChatId, excerpt)
                  else addToMain(excerpt)
                })
                requestExcerptEdit({
                  ownerId: sideChatId
                    ? `side:${sideChatId}`
                    : `main:${nativeThreadId}`,
                  excerptId: excerpt.id,
                  creating: true,
                })
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
            title={workspaceTabPresentation(closing, t).label}
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
