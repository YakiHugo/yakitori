import { type CSSProperties, useEffect, useLayoutEffect, useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import { startNewEngineSession } from "../store/engine-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { SessionSearch } from "./session-search.tsx"
import { Sidebar } from "./sidebar.tsx"
import { SidebarDragSurface } from "./sidebar-drag.tsx"

export function SidebarFrame({
  open,
  setOpen,
}: Readonly<{ open: boolean; setOpen(value: boolean): void }>) {
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
      windowWidth - 48 - (split && windowWidth >= 960 ? 320 + 352 : 240),
    ),
  )
  const width = Math.min(preferredWidth, maximumWidth)
  const setWidth = (value: number) =>
    setPreferredWidth(Math.max(240, Math.min(maximumWidth, value)))
  const [resizing, setResizing] = useState(false)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    localStorage.setItem("yakitori.sidebarOpen", String(open))
  }, [open])
  useEffect(() => {
    if (!resizing)
      localStorage.setItem("yakitori.sidebarWidth", String(preferredWidth))
  }, [preferredWidth, resizing])
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`)
    return () => {
      document.documentElement.style.removeProperty("--sidebar-width")
    }
  }, [width])
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        useAppStore.getState().settingsSection !== undefined ||
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
        setOpen(!open)
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault()
        startNewEngineSession()
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [open, setOpen])
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
            const left =
              event.currentTarget.parentElement?.getBoundingClientRect().left ??
              0
            setWidth(event.clientX - left)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            setResizing(false)
          }}
          onLostPointerCapture={() => setResizing(false)}
        />
      </aside>
      {searching && <SessionSearch onClose={() => setSearching(false)} />}
    </>
  )
}
