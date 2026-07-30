import { type RefObject, useRef } from "react"

export type PinnedScroll = {
  readonly viewportRef: RefObject<HTMLDivElement | null>
  readonly onScroll: () => void
  readonly pinToBottom: () => void
}

// Only autoscroll when the user is already near the bottom, so reading
// history is never interrupted by incoming output.
export function usePinnedScroll(): PinnedScroll {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  return {
    viewportRef,
    onScroll: () => {
      const viewport = viewportRef.current
      if (!viewport) return
      pinnedRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
    },
    pinToBottom: () => {
      const viewport = viewportRef.current
      if (viewport && pinnedRef.current) {
        viewport.scrollTop = viewport.scrollHeight
      }
    },
  }
}
