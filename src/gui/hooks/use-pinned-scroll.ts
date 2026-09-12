import { useCallback, useLayoutEffect, useRef, useState } from "react"

// Codex's thread scroll controller distinguishes layout restoration, following,
// and a cancelable 260ms user jump. Native scroll events alone cannot tell them apart.
export function usePinnedScroll(sessionId?: string) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  const animation = useRef<number | undefined>(undefined)
  const [atBottom, setAtBottom] = useState(true)

  const cancelAnimation = useCallback(() => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current)
    animation.current = undefined
  }, [])
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const bottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24
    setAtBottom(bottom)
    if (animation.current === undefined && bottom) following.current = true
  }, [])
  const pauseFollowing = useCallback(() => {
    cancelAnimation()
    following.current = false
  }, [cancelAnimation])

  const scrollTo = useCallback(
    (target: () => number, follow: boolean) => {
      cancelAnimation()
      const viewport = viewportRef.current
      if (!viewport) return
      following.current = false
      const start = viewport.scrollTop
      const startedAt = performance.now()
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches
      const step = (now: number) => {
        const progress = reduced
          ? 1
          : Math.max(0, Math.min(1, (now - startedAt) / 260))
        const end = Math.max(
          0,
          Math.min(target(), viewport.scrollHeight - viewport.clientHeight),
        )
        viewport.scrollTop = start + (end - start) * (1 - (1 - progress) ** 3)
        if (progress < 1) animation.current = requestAnimationFrame(step)
        else {
          animation.current = undefined
          following.current = follow
          setAtBottom(
            viewport.scrollHeight -
              viewport.scrollTop -
              viewport.clientHeight <=
              24,
          )
        }
      }
      animation.current = requestAnimationFrame(step)
    },
    [cancelAnimation],
  )
  const jumpToBottom = useCallback(() => {
    scrollTo(() => viewportRef.current?.scrollHeight ?? 0, true)
  }, [scrollTo])
  const jumpToElement = useCallback(
    (node: HTMLElement) => {
      const viewport = viewportRef.current
      if (!viewport) return
      scrollTo(
        () =>
          viewport.scrollTop +
          node.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          24,
        false,
      )
    },
    [scrollTo],
  )

  useLayoutEffect(() => {
    if (sessionId === undefined) return
    cancelAnimation()
    following.current = true
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
    setAtBottom(true)
  }, [sessionId, cancelAnimation])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const follow = () => {
      if (following.current && animation.current === undefined)
        viewport.scrollTop = viewport.scrollHeight
      setAtBottom(
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
          24,
      )
    }
    const interrupt = () => pauseFollowing()
    const keyInterrupt = (event: globalThis.KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        interrupt()
    }
    viewport.addEventListener("wheel", interrupt, { passive: true })
    viewport.addEventListener("touchstart", interrupt, { passive: true })
    viewport.parentElement?.addEventListener("pointerdown", interrupt)
    viewport.addEventListener("keydown", keyInterrupt)
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(viewport)
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimation()
      viewport.removeEventListener("wheel", interrupt)
      viewport.removeEventListener("touchstart", interrupt)
      viewport.parentElement?.removeEventListener("pointerdown", interrupt)
      viewport.removeEventListener("keydown", keyInterrupt)
    }
  }, [pauseFollowing, cancelAnimation])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && following.current && animation.current === undefined)
      viewport.scrollTop = viewport.scrollHeight
  })
  return {
    viewportRef,
    contentRef,
    onScroll,
    atBottom,
    jumpToBottom,
    jumpToElement,
    pauseFollowing,
  }
}
