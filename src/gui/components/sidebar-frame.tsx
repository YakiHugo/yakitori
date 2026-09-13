import { SidebarDragSurface } from "./sidebar-drag.tsx"
import { useEffect, useState, type CSSProperties } from "react"
import { PanelLeft } from "lucide-react"
import { Sidebar } from "./sidebar.tsx"
import { SessionSearch } from "./session-search.tsx"
import { useAppStore } from "../store/app-store.ts"

export function SidebarFrame() {
  const [open, setOpen] = useState(
    () => localStorage.getItem("yakitori.sidebarOpen") !== "false",
  )
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("yakitori.sidebarWidth"))
    return Number.isFinite(saved) && saved >= 220 && saved <= 480 ? saved : 352
  })
  const [resizing, setResizing] = useState(false)
  const [searching, setSearching] = useState(false)
  const startNewSession = useAppStore((state) => state.startNewSession)
  useEffect(() => {
    localStorage.setItem("yakitori.sidebarOpen", String(open))
  }, [open])
  useEffect(() => {
    if (!resizing) localStorage.setItem("yakitori.sidebarWidth", String(width))
  }, [width, resizing])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return
      // Preserve editor formatting shortcuts while the composer is focused.
      if (
        event.key.toLowerCase() === "b" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      ) {
        event.preventDefault()
        setOpen((value) => !value)
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault()
        startNewSession()
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [startNewSession])
  return (
    <>
      <aside
        className="sidebar-frame"
        aria-label="Sidebar"
        data-open={open}
        data-resizing={resizing}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <div className="sidebar-inner" inert={!open}>
          <div className="sidebar-toolbar">
            <button
              type="button"
              aria-label="Hide sidebar"
              title="Hide sidebar (⌘B)"
              className="sidebar-icon"
              onClick={() => setOpen(false)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <SidebarDragSurface>
            <Sidebar onSearch={() => setSearching(true)} />
          </SidebarDragSurface>
        </div>
        <hr
          tabIndex={open ? 0 : -1}
          aria-label="Sidebar width"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={480}
          aria-valuenow={width}
          className="sidebar-resize"
          onDoubleClick={() => setWidth(352)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            setWidth((value) =>
              Math.max(
                220,
                Math.min(480, value + (event.key === "ArrowLeft" ? -16 : 16)),
              ),
            )
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            setWidth(
              Math.max(
                220,
                Math.min(480, window.innerWidth * 0.6, event.clientX),
              ),
            )
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            setResizing(false)
          }}
          onLostPointerCapture={() => setResizing(false)}
        />
      </aside>
      {!open && (
        <button
          type="button"
          aria-label="Show sidebar"
          title="Show sidebar (⌘B)"
          className="sidebar-icon sidebar-show"
          onClick={() => setOpen(true)}
        >
          <PanelLeft size={16} />
        </button>
      )}
      {searching && <SessionSearch onClose={() => setSearching(false)} />}
    </>
  )
}
