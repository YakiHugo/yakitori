import { PanelLeft } from "lucide-react"
import { type CSSProperties, useEffect, useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { SessionSearch } from "./session-search.tsx"
import { Sidebar } from "./sidebar.tsx"
import { SidebarDragSurface } from "./sidebar-drag.tsx"

export function SidebarFrame() {
  const [open, setOpen] = useState(
    () => localStorage.getItem("yakitori.sidebarOpen") !== "false",
  )
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const saved = Number(localStorage.getItem("yakitori.sidebarWidth"))
    return Number.isFinite(saved) && saved >= 240 && saved <= 520 ? saved : 275
  })
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const split = useWorkspaceStore((state) => state.open && !state.expanded)
  // Resizing the sidebar must leave room for both the chat and content pane.
  const maximumWidth = Math.max(
    240,
    Math.min(
      520,
      windowWidth - (split && windowWidth >= 912 ? 320 + 352 : 240),
    ),
  )
  const width = Math.min(preferredWidth, maximumWidth)
  const setWidth = (value: number) =>
    setPreferredWidth(Math.max(240, Math.min(maximumWidth, value)))
  const [resizing, setResizing] = useState(false)
  const [searching, setSearching] = useState(false)
  const startNewSession = useAppStore((state) => state.startNewSession)
  useEffect(() => {
    localStorage.setItem("yakitori.sidebarOpen", String(open))
  }, [open])
  useEffect(() => {
    if (!resizing)
      localStorage.setItem("yakitori.sidebarWidth", String(preferredWidth))
  }, [preferredWidth, resizing])
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])
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
          aria-valuemin={240}
          aria-valuemax={maximumWidth}
          aria-valuenow={width}
          className="sidebar-resize"
          onDoubleClick={() => setPreferredWidth(275)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            setWidth(width + (event.key === "ArrowLeft" ? -16 : 16))
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            setWidth(event.clientX)
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
