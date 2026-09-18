import { useLayoutEffect, useRef } from "react"
import { useAppStore } from "../store/app-store.ts"

// FLIP only committed list changes. Pointer feedback lives in the drag surface;
// expanding a group keeps Radix's continuous height animation.
export function useSidebarMotion() {
  const ref = useRef<HTMLElement>(null)
  const previous = useRef(new Map<string, number>())
  const sidebar = useAppStore((state) => state.sidebar)
  const projects = useAppStore((state) => state.projects)
  const lists = useAppStore((state) => state.sessionsByProject)
  // biome-ignore lint/correctness/useExhaustiveDependencies: These committed snapshots trigger DOM measurements; pointer and disclosure updates must not restart layout motion.
  useLayoutEffect(() => {
    const nav = ref.current
    const nodes = () => [
      ...(nav?.querySelectorAll<HTMLElement>("[data-sidebar-layout]") ?? []),
    ]
    // Layout offsets exclude scrolling and running transforms, so unrelated
    // refresh responses cannot restart or cancel an in-progress move.
    const measure = (measured: HTMLElement[]) =>
      new Map(
        measured.map((node) => {
          let top = 0
          let element: HTMLElement | null = node
          while (element) {
            top += element.offsetTop
            element =
              element.offsetParent instanceof HTMLElement
                ? element.offsetParent
                : null
          }
          return [node.dataset.sidebarLayout ?? "", top] as const
        }),
      )
    // Measuring walks offsetParent chains (forced sync layout per node), so a
    // burst of store updates collapses into one measure+animate pass per
    // frame; a new update cancels the pending frame.
    const frame = window.requestAnimationFrame(() => {
      const measured = nodes()
      const next = measure(measured)
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        for (const node of measured) {
          const id = node.dataset.sidebarLayout ?? ""
          const old = previous.current.get(id)
          const rect = next.get(id)
          if (
            old === undefined ||
            rect === undefined ||
            typeof node.animate !== "function"
          )
            continue
          const parentId = node.parentElement?.closest<HTMLElement>(
            "[data-sidebar-layout]",
          )?.dataset.sidebarLayout
          const oldParent = parentId
            ? previous.current.get(parentId)
            : undefined
          const newParent = parentId ? next.get(parentId) : undefined
          const parentDelta =
            oldParent !== undefined && newParent !== undefined
              ? oldParent - newParent
              : 0
          const delta = old - rect - parentDelta
          if (Math.abs(delta) < 1) continue
          const running = node
            .getAnimations()
            .filter((animation) => animation.id === "sidebar-layout")
          const currentOffset =
            running.length === 0
              ? 0
              : new DOMMatrixReadOnly(getComputedStyle(node).transform).m42
          for (const animation of running) animation.cancel()
          const animation = node.animate(
            [
              { transform: `translateY(${delta + currentOffset}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          )
          animation.id = "sidebar-layout"
        }
      }
      previous.current = next
    })
    // Disclosure height animations own their layout. Use their settled positions
    // as the baseline for the next reorder instead of replaying the collapse.
    const settled = () => {
      previous.current = measure(nodes())
    }
    nav?.addEventListener("animationend", settled)
    return () => {
      window.cancelAnimationFrame(frame)
      nav?.removeEventListener("animationend", settled)
    }
  }, [sidebar, projects, lists])
  return ref
}
