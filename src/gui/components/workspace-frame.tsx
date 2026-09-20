import {
  Files,
  GitCompareArrows,
  Globe,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Monitor,
  PanelRight,
  Plus,
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
import type { ContextExcerpt } from "../conversation-context.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  useWorkspaceStore,
  type WorkspaceTab,
} from "../store/workspace-store.ts"
import { BrowserPanel } from "./browser-panel.tsx"
import { CloseSideChatDialog } from "./close-side-chat-dialog.tsx"
import { ComputerPanel } from "./computer-panel.tsx"
import { SelectionActions } from "./selection-actions.tsx"
import { SideChatPanel } from "./side-chat-panel.tsx"
import { SidebarFrame } from "./sidebar-frame.tsx"
import { WorkspaceChanges } from "./workspace-changes.tsx"
import { WorkspaceFilePreview, WorkspaceFiles } from "./workspace-files.tsx"

const views = [
  { id: "changes", label: "Changes", icon: GitCompareArrows },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: Files },
  { id: "chat", label: "Side chat", icon: MessageCirclePlus },
  { id: "computer", label: "Computer", icon: Monitor },
] as const

function tabLabel(tab: WorkspaceTab): string {
  if (tab.kind === "file") return tab.path.split("/").at(-1) ?? tab.path
  if ((tab.kind === "browser" || tab.kind === "chat") && tab.title)
    return tab.title
  return views.find((view) => view.id === tab.kind)?.label ?? "Workspace"
}

export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const open = useWorkspaceStore((state) => state.open)
  const setOpen = useWorkspaceStore((state) => state.setOpen)
  const expanded = useWorkspaceStore((state) => state.expanded)
  const tabs = useWorkspaceStore((state) => state.tabs)
  const activeId = useWorkspaceStore((state) => state.activeId)
  const addTab = useWorkspaceStore((state) => state.addTab)
  const activate = useWorkspaceStore((state) => state.activate)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const askInSideChat = useWorkspaceStore((state) => state.askInSideChat)
  const excerpts = useAppStore((state) => state.promptExcerpts)
  const updateExcerpt = useAppStore((state) => state.updatePromptExcerpt)
  const removeExcerpt = useAppStore((state) => state.removePromptExcerpt)
  const addPromptExcerpt = useAppStore((state) => state.addPromptExcerpt)
  const shell = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(() =>
    Math.max(672, window.innerWidth - 275),
  )
  const [widthRatio, setWidthRatio] = useState<number | undefined>(() => {
    const saved = Number(localStorage.getItem("yakitori.workspaceWidthRatio"))
    return saved > 0 && saved < 1 ? saved : undefined
  })
  const maximumWidth = Math.max(320, available - 352)
  const defaultWidth = Math.min(
    maximumWidth,
    Math.max(
      320,
      Math.min(window.innerHeight * 1.6, available - 500),
      Math.min(640, available - 352),
    ),
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
  const [adding, setAdding] = useState(false)
  const [resizing, setResizing] = useState(false)
  const apiBase = useAppStore((state) => state.apiBase)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const cwd = useAppStore(
    (state) =>
      state.selectedSession?.workingDirectory ??
      state.projects.find((project) => project.id === state.currentProject)
        ?.roots[0],
  )
  const addToMain = (excerpt: ContextExcerpt) => {
    if (excerpt.kind === "selection") {
      useWorkspaceStore.getState().setExpanded(false)
    }
    addPromptExcerpt(excerpt)
  }
  const requestClose = (tab: WorkspaceTab) => {
    if (
      tab.kind === "chat" &&
      (tab.hasMessages ||
        tab.activeTurnId ||
        tab.draft.trim() ||
        tab.excerpts.length ||
        tab.attachments.length)
    )
      setClosing(tab)
    else closeTab(tab.id)
  }

  useLayoutEffect(() => {
    const element = shell.current
    if (!element) return
    const update = () => {
      const sidebar = element.querySelector(".sidebar-frame")
      const bounds = element.getBoundingClientRect()
      const width = bounds.width - (sidebar?.getBoundingClientRect().width ?? 0)
      if (width > 0) {
        setAvailable(width)
        // Initialize the split once from the actual remaining workspace.
        // Subsequent window/sidebar resizing preserves that split ratio.
        setWidthRatio(
          (saved) =>
            saved ??
            Math.min(
              Math.max(320, width - 352),
              Math.max(
                320,
                Math.min(bounds.height * 1.6, width - 500),
                Math.min(640, width - 352),
              ),
            ) / width,
        )
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
      localStorage.setItem("yakitori.workspaceWidthRatio", String(widthRatio))
  }, [widthRatio, resizing])
  useEffect(() => {
    return window.yakitoriDesktop?.browser?.onShortcut((action) => {
      if (action === "toggle-workspace")
        setOpen(!useWorkspaceStore.getState().open)
      else
        addTab(
          action === "new-browser"
            ? "browser"
            : action === "open-files"
              ? "files"
              : "chat",
          sessionId,
        )
    })
  }, [addTab, setOpen, sessionId])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]") || event.isComposing) return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b" &&
        !event.isComposing &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault()
        setOpen(!useWorkspaceStore.getState().open)
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
        if (key === "s" && event.altKey) {
          event.preventDefault()
          addTab("chat", sessionId)
        }
      }
      if (event.key === "Escape") {
        if (adding) setAdding(false)
        else if (window.innerWidth < 1180) setOpen(false)
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
  }, [setOpen, addTab, adding, sessionId])

  return (
    <div
      ref={shell}
      className="app-shell workspace-shell flex h-screen overflow-hidden text-foreground"
      data-workspace-open={open}
      data-workspace-expanded={open && expanded}
    >
      <SidebarFrame />
      {children}
      {!open && (
        <button
          type="button"
          aria-label="Show workspace"
          title="Show workspace (⌘⇧B)"
          className="sidebar-icon workspace-show"
          onClick={() => setOpen(true)}
        >
          <PanelRight size={16} />
        </button>
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
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            setWidth(width + (event.key === "ArrowLeft" ? 16 : -16))
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
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
            {tabs.map((tab, index) => {
              const { id } = tab
              const label = tabLabel(tab)
              const Icon =
                tab.kind === "file"
                  ? Files
                  : (views.find((view) => view.id === tab.kind)?.icon ?? Files)
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
                          ? (index + 1) % tabs.length
                          : event.key === "ArrowLeft"
                            ? (index + tabs.length - 1) % tabs.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? tabs.length - 1
                                : undefined
                      if (next === undefined) return
                      event.preventDefault()
                      const entry = tabs[next]
                      if (!entry) return
                      activate(entry.id)
                      document
                        .getElementById(`workspace-tab-${entry.id}`)
                        ?.focus()
                    }}
                  >
                    <Icon size={14} />
                    <span>{label}</span>
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
                {views.map(({ id, label, icon: Icon }) => (
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
          <button
            type="button"
            className="sidebar-icon"
            aria-label="Hide workspace"
            title="Hide workspace (⌘⇧B)"
            onClick={() => setOpen(false)}
          >
            <X size={15} />
          </button>
        </header>
        {tabs.map((tab) => (
          <div
            key={`${apiBase}:${tab.id}`}
            id={`workspace-content-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`workspace-tab-${tab.id}`}
            className="workspace-content"
            hidden={!open || activeId !== tab.id}
          >
            {tab.kind === "computer" ? (
              <ComputerPanel apiBase={apiBase} />
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
                  useWorkspaceStore.getState().setBrowserTitle(tab.id, title)
                }
                onSelection={(selection) => {
                  const excerpt: ContextExcerpt = {
                    kind: "selection",
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
            ) : tab.kind === "file" ? (
              <WorkspaceFilePreview
                cwd={tab.cwd}
                path={tab.path}
                apiBase={apiBase}
              />
            ) : cwd ? (
              <>
                <div className="workspace-root" title={cwd}>
                  {cwd}
                </div>
                {tab.kind === "files" ? (
                  <WorkspaceFiles
                    cwd={cwd}
                    apiBase={apiBase}
                    onOpenFile={(path) => openFile(path, cwd)}
                  />
                ) : (
                  <WorkspaceChanges cwd={cwd} apiBase={apiBase} />
                )}
              </>
            ) : (
              <div className="workspace-empty">
                <Files size={28} strokeWidth={1.25} />
                <strong>Your workspace, alongside your conversation</strong>
                <p>
                  Select a project or open a conversation to browse files and
                  review changes.
                </p>
              </div>
            )}
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="workspace-empty">
            <MessageCirclePlus size={30} strokeWidth={1.25} />
            <strong>Open something alongside your conversation</strong>
            <p>
              Browse the web, read a file, or ask a question in a temporary side
              chat.
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
      </aside>
      <SelectionActions
        key={`${apiBase}:${sessionId ?? "draft"}`}
        annotations={excerpts.filter(
          (excerpt) => excerpt.kind === "annotation",
        )}
        onAddToConversation={addToMain}
        onUpdateAnnotation={updateExcerpt}
        onRemoveAnnotation={removeExcerpt}
        onAskInSideChat={(excerpt) => askInSideChat(excerpt, sessionId)}
      />
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
  )
}
