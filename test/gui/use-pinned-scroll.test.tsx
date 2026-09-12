// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { usePinnedScroll } from "../../src/gui/hooks/use-pinned-scroll.ts"

let scroll: ReturnType<typeof usePinnedScroll>
let resize: () => void
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
function Fixture({ sessionId = "one" }: { sessionId?: string }) {
  scroll = usePinnedScroll(sessionId)
  return (
    <div ref={scroll.viewportRef} onScroll={scroll.onScroll}>
      <div ref={scroll.contentRef} />
    </div>
  )
}
function frame(now: number) {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(now)
  })
}
beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.spyOn(performance, "now").mockReturnValue(0)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function geometry() {
  const viewport = scroll.viewportRef.current as HTMLDivElement
  let top = 0
  Object.defineProperties(viewport, {
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(800, value))
      },
      configurable: true,
    },
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
  })
  return viewport
}
it("restores at the bottom without animating and keeps layout growth pinned", () => {
  const { rerender } = render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  expect(viewport.scrollTop).toBe(800)
  viewport.scrollTop = 300
  fireEvent.wheel(viewport, { deltaY: -20 })
  rerender(<Fixture sessionId="two" />)
  expect(viewport.scrollTop).toBe(800)
  expect(frames.size).toBe(0)
})
it("does not resume following when layout changes during history reading", () => {
  render(<Fixture />)
  const viewport = geometry()
  fireEvent.wheel(viewport, { deltaY: -20 })
  viewport.scrollTop = 100
  fireEvent.scroll(viewport)
  act(() => resize())
  expect(viewport.scrollTop).toBe(100)
  expect(scroll.atBottom).toBe(false)
})
it("animates a jump to the current bottom and lets user scrolling cancel it", () => {
  render(<Fixture />)
  const viewport = geometry()
  viewport.scrollTop = 0
  act(() => scroll.jumpToBottom())
  frame(100)
  expect(viewport.scrollTop).toBeGreaterThan(0)
  expect(viewport.scrollTop).toBeLessThan(800)
  const beforeInterrupt = viewport.scrollTop
  fireEvent.wheel(viewport, { deltaY: -20 })
  frame(300)
  expect(viewport.scrollTop).toBe(beforeInterrupt)
  act(() => resize())
  expect(viewport.scrollTop).toBe(beforeInterrupt)
  act(() => scroll.jumpToBottom())
  frame(300)
  expect(viewport.scrollTop).toBe(800)
  expect(scroll.atBottom).toBe(true)
})
