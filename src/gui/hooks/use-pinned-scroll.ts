import { useCallback, useLayoutEffect, useRef, useState } from "react"

// Track layout changes too: images, markdown and disclosure panels can grow
// without a new event. Reading history suspends following until an explicit jump.
export function usePinnedScroll(sessionId?: string) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const bottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
    pinnedRef.current = bottom
    setAtBottom(bottom)
  }, [])

  const jumpToBottom = useCallback(() => {
    pinnedRef.current = true
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
    setAtBottom(true)
  }, [])

  const pauseFollowing = useCallback(() => {
    pinnedRef.current = false
  }, [])

  useLayoutEffect(() => {
    // A session change always opens at the latest output, before paint.
    if (sessionId !== undefined) jumpToBottom()
  }, [sessionId, jumpToBottom])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const follow = () => {
      if (pinnedRef.current) viewport.scrollTop = viewport.scrollHeight
      onScroll()
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [onScroll])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && pinnedRef.current)
      viewport.scrollTop = viewport.scrollHeight
  })

  return {
    viewportRef,
    contentRef,
    onScroll,
    atBottom,
    jumpToBottom,
    pauseFollowing,
  }
}
