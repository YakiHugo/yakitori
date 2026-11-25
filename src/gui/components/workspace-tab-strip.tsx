import { Plus, X } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import type { WorkspaceTab } from "../store/workspace-store.ts"
import { workspaceTabPresentation } from "./workspace-views.ts"

export function WorkspaceTabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNewTab,
}: Readonly<{
  tabs: readonly WorkspaceTab[]
  activeId: string
  onActivate: (id: string) => void
  onClose: (tab: WorkspaceTab) => void
  onNewTab: () => void
}>) {
  const selectedTab = useRef<HTMLDivElement>(null)
  const launcherActive = tabs.some(
    (tab) => tab.id === activeId && tab.kind === "launcher",
  )

  useLayoutEffect(() => {
    const tab = selectedTab.current
    const strip = tab?.parentElement
    if (!activeId || !tab || !strip) return
    const reveal = () =>
      tab.scrollIntoView({ block: "nearest", inline: "nearest" })
    reveal()
    const resize = new ResizeObserver(reveal)
    resize.observe(strip)
    return () => resize.disconnect()
  }, [activeId])

  return (
    <div className="workspace-tab-strip">
      <div
        className="workspace-tabs"
        role="tablist"
        aria-label="Workspace views"
      >
        {tabs.map((tab, index) => {
          const { id } = tab
          const { label, icon: Icon, title } = workspaceTabPresentation(tab)
          const selected = id === activeId
          return (
            <div
              key={id}
              ref={selected ? selectedTab : undefined}
              className="workspace-tab"
              data-active={selected}
            >
              <button
                id={`workspace-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`workspace-content-${id}`}
                tabIndex={selected ? 0 : -1}
                title={title ?? label}
                onClick={() => onActivate(id)}
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
                  const entry = next === undefined ? undefined : tabs[next]
                  if (!entry) return
                  event.preventDefault()
                  onActivate(entry.id)
                  document.getElementById(`workspace-tab-${entry.id}`)?.focus()
                }}
              >
                <Icon size={14} aria-hidden="true" />
                <span>
                  {label}
                  {tab.kind === "file" && tab.dirty ? " •" : ""}
                </span>
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={`Close ${label}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onClose(tab)}
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
      {(tabs.length > 1 || !launcherActive) && (
        <button
          type="button"
          className="sidebar-icon workspace-add-tab"
          aria-label="Add workspace tab"
          title="New tab"
          onClick={onNewTab}
        >
          <Plus size={17} />
        </button>
      )}
    </div>
  )
}
