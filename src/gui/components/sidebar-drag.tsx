import {
  createContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { sessionListKey, useAppStore } from "../store/app-store.ts"
import type { SidebarChange } from "../../core/session-sidebar.ts"

export const SidebarDragKind = createContext<string | undefined>(undefined)

type DragSource = Readonly<{
  kind: string
  id: string
  label: string
  projectId: string | undefined
}>
type Drop = Readonly<{
  element: HTMLElement
  edge?: "before" | "after"
  label: string
  change?: SidebarChange
  project?: Readonly<{ targetId: string; after: boolean }>
  pinProject?: boolean
}>

// Only explicit data attributes identify destinations. Dragging a conversation
// changes sidebar membership, never its execution project or working directory.
function dropAt(
  source: DragSource,
  element: HTMLElement,
  y: number,
): Drop | undefined {
  const state = useAppStore.getState()
  const kind = element.dataset.sidebarDrop
  const id = element.dataset.dropId
  const after =
    y > element.getBoundingClientRect().top + element.offsetHeight / 2
  if (
    source.kind === "section" &&
    kind === "section" &&
    id &&
    id !== "pinned" &&
    id !== source.id
  ) {
    const ids = state.sidebar.sections
      .map((section) => section.id)
      .filter((sectionId) => sectionId !== source.id)
    if (
      !state.sidebar.sections.some((section) => section.id === source.id) ||
      !ids.includes(id)
    )
      return
    ids.splice(ids.indexOf(id) + (after ? 1 : 0), 0, source.id)
    return {
      element,
      edge: after ? "after" : "before",
      label: `Move ${after ? "after" : "before"} ${element.dataset.dropLabel}`,
      change: { type: "reorder-sections", sectionIds: ids },
    }
  }
  if (source.kind === "project") {
    const project = state.projects.find((project) => project.id === source.id)
    if (
      kind === "project" &&
      id &&
      id !== source.id &&
      project?.pinned === state.projects.find((p) => p.id === id)?.pinned
    )
      return {
        element,
        edge: after ? "after" : "before",
        label: `Move ${after ? "after" : "before"} ${element.dataset.dropLabel}`,
        project: { targetId: id, after },
      }
    if ((kind === "section" && id === "pinned") || kind === "default") {
      const pinned = kind === "section"
      if (project && project.pinned !== pinned)
        return {
          element,
          label: pinned ? "Pin project" : "Return to Projects",
          pinProject: pinned,
        }
    }
  }
  if (source.kind !== "session") return
  if (kind === "section" && id)
    return {
      element,
      label: `Move to ${element.dataset.dropLabel}`,
      change: { type: "move-session", sessionId: source.id, sectionId: id },
    }
  if (kind === "default" || (kind === "project" && id === source.projectId))
    return {
      element,
      label: "Return to project",
      change: { type: "move-session", sessionId: source.id, sectionId: null },
    }
  const sectionId = element.dataset.dropSection
  if (kind !== "session" || !sectionId || !id || id === source.id) return
  const list = state.sessionsByProject[sessionListKey(undefined, { sectionId })]
  const rows = list?.sessions ?? []
  const next = rows
    .slice(rows.findIndex((row) => row.id === id) + 1)
    .find((row) => row.id !== source.id)
  // An unloaded next page is not the section's end. Keep the visible before
  // boundary; dropping on the section header always appends to the full list.
  const useAfter =
    after && (next !== undefined || list?.nextCursor === undefined)
  const beforeSessionId = useAfter ? next?.id : id
  return {
    element,
    edge: useAfter ? "after" : "before",
    label: `Move ${useAfter ? "after" : "before"} ${element.dataset.dropLabel}`,
    change: {
      type: "move-session",
      sessionId: source.id,
      sectionId,
      ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
    },
  }
}

export function SidebarDragSurface({
  children,
}: Readonly<{ children: ReactNode }>) {
  const root = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<DragSource>()
  const [announcement, setAnnouncement] = useState("")
  const pending = useRef<
    | {
        source: DragSource
        origin: HTMLElement
        x: number
        y: number
        startX: number
        startY: number
        active: boolean
        pointerId: number
        drop?: Drop | undefined
      }
    | undefined
  >(undefined)
  const suppressedUntil = useRef(0)
  useEffect(() => {
    let frame = 0
    let hoverTimer: ReturnType<typeof setTimeout> | undefined
    let hoverId: string | undefined
    let previousTime = 0
    const clearDrop = () => {
      pending.current?.drop?.element.removeAttribute("data-drop-active")
      if (line.current) line.current.style.display = "none"
    }
    const finish = (commit: boolean) => {
      const drag = pending.current
      if (!drag) return
      clearDrop()
      clearTimeout(hoverTimer)
      hoverId = undefined
      cancelAnimationFrame(frame)
      document.documentElement.classList.remove("sidebar-is-dragging")
      drag.origin.removeAttribute("data-dragging")
      pending.current = undefined
      setSource(undefined)
      if (!drag.active) return
      suppressedUntil.current = Date.now() + 300
      drag.origin.focus({ preventScroll: true })
      const drop = drag.drop
      if (!commit || !drop) {
        setAnnouncement("Move cancelled.")
        return
      }
      const state = useAppStore.getState()
      setAnnouncement("Saving order…")
      const completion = drop.change
        ? state.changeSidebar(drop.change)
        : drop.project
          ? state.moveProject(
              drag.source.id,
              drop.project.targetId,
              drop.project.after,
            )
          : state.toggleProjectPinned(drag.source.id)
      void completion.then((done) => {
        setAnnouncement(
          done
            ? "Sidebar order saved."
            : "Could not move item. The previous order is kept.",
        )
        if (done) {
          const button = [
            ...(root.current?.querySelectorAll<HTMLElement>("[data-drag-id]") ??
              []),
          ].find((element) => element.dataset.dragId === drag.source.id)
          button?.focus({ preventScroll: true })
        }
      })
    }
    const update = (now: number) => {
      const drag = pending.current
      if (!drag?.active) return
      const delta = previousTime === 0 ? 16 : Math.min(32, now - previousTime)
      previousTime = now
      const viewport = root.current?.querySelector<HTMLElement>(
        "[data-radix-scroll-area-viewport]",
      )
      if (viewport) {
        const rect = viewport.getBoundingClientRect()
        if (
          drag.x >= rect.left &&
          drag.x <= rect.right &&
          drag.y >= rect.top &&
          drag.y <= rect.bottom
        ) {
          const speed =
            drag.y < rect.top + 36
              ? -(1 - (drag.y - rect.top) / 36)
              : drag.y > rect.bottom - 36
                ? 1 - (rect.bottom - drag.y) / 36
                : 0
          viewport.scrollTop += speed * delta * 0.65
        }
      }
      const under = document
        .elementFromPoint(drag.x, drag.y)
        ?.closest<HTMLElement>("[data-sidebar-drop]")
      const drop =
        under && root.current?.contains(under)
          ? dropAt(drag.source, under, drag.y)
          : undefined
      clearDrop()
      drag.drop = drop
      if (drop) {
        drop.element.dataset.dropActive = drop.edge ?? "inside"
        if (line.current && drop.edge) {
          const rect = drop.element.getBoundingClientRect()
          Object.assign(line.current.style, {
            display: "block",
            left: `${rect.left + 6}px`,
            top: `${(drop.edge === "before" ? rect.top : rect.bottom) - 1}px`,
            width: `${rect.width - 12}px`,
          })
        }
      }
      const nextHover =
        drop?.change?.type === "move-session"
          ? (drop.change.sectionId ?? undefined)
          : undefined
      if (nextHover !== hoverId) {
        clearTimeout(hoverTimer)
        hoverId = nextHover
        if (nextHover)
          hoverTimer = setTimeout(
            () => useAppStore.getState().setSectionOpen(nextHover, true),
            450,
          )
      }
      if (ghost.current) {
        ghost.current.style.transform = `translate3d(${Math.max(8, Math.min(window.innerWidth - ghost.current.offsetWidth - 8, drag.x + 14))}px, ${Math.max(8, Math.min(window.innerHeight - ghost.current.offsetHeight - 8, drag.y + 12))}px, 0)`
        const hint = ghost.current.querySelector("small")
        if (hint)
          hint.textContent =
            drop?.label ?? "Choose a destination · Esc to cancel"
      }
      frame = requestAnimationFrame(update)
    }
    const move = (event: PointerEvent) => {
      const drag = pending.current
      if (!drag || event.pointerId !== drag.pointerId) return
      drag.x = event.clientX
      drag.y = event.clientY
      if (
        !drag.active &&
        Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5
      ) {
        drag.active = true
        drag.origin.dataset.dragging = "true"
        document.documentElement.classList.add("sidebar-is-dragging")
        setSource(drag.source)
        setAnnouncement(`Moving ${drag.source.label}. Escape cancels.`)
        previousTime = 0
        frame = requestAnimationFrame(update)
      }
      if (drag.active) event.preventDefault()
    }
    const up = (event: PointerEvent) => {
      const drag = pending.current
      if (drag?.pointerId !== event.pointerId) return
      if (drag.active) {
        clearDrop()
        const under = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-sidebar-drop]")
        drag.drop =
          under && root.current?.contains(under)
            ? dropAt(drag.source, under, event.clientY)
            : undefined
      }
      finish(true)
    }
    const cancel = () => finish(false)
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pending.current) {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener("pointermove", move, { passive: false })
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("blur", cancel)
    window.addEventListener("keydown", key, true)
    return () => {
      cancel()
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("blur", cancel)
      window.removeEventListener("keydown", key, true)
    }
  }, [])
  return (
    <SidebarDragKind value={source?.kind}>
      <div
        ref={root}
        className="sidebar-drag-surface"
        onPointerDownCapture={(event) => {
          if (
            event.button !== 0 ||
            event.pointerType === "touch" ||
            document.querySelector("dialog[open]")
          )
            return
          const state = useAppStore.getState()
          if (
            state.inFlightActions.has("sidebar-update") ||
            state.inFlightActions.has("project-order")
          )
            return
          const element = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-sidebar-drag]",
          )
          if (!element?.dataset.dragId) return
          pending.current = {
            source: {
              kind: element.dataset.sidebarDrag ?? "",
              id: element.dataset.dragId,
              label: element.dataset.dragLabel ?? "",
              projectId: element.dataset.dragProject,
            },
            origin: element,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            pointerId: event.pointerId,
          }
        }}
        onClickCapture={(event) => {
          if (Date.now() < suppressedUntil.current) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        {children}
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
      </div>
      {source &&
        createPortal(
          <>
            <div ref={ghost} className="sidebar-drag-ghost">
              <span>{source.label}</span>
              <small>Choose a destination · Esc to cancel</small>
            </div>
            <div ref={line} className="sidebar-drop-line" />
          </>,
          document.body,
        )}
    </SidebarDragKind>
  )
}
