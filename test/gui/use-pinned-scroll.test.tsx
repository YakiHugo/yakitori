// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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
        top = Math.max(
          0,
          Math.min(viewport.scrollHeight - viewport.clientHeight, value),
        )
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
it("jumps to find matches immediately and keeps streaming growth from moving the match", () => {
  render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  const range = document.createRange()
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({ top: 300 - viewport.scrollTop }),
  })
  act(() => scroll.jumpToFindMatch(range))
  expect(viewport.scrollTop).toBe(220)
  expect(frames.size).toBe(0)
  Object.defineProperty(viewport, "scrollHeight", { value: 1600 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(220)
  expect(scroll.atBottom).toBe(false)
})
it("follows explicit layout changes that do not resize the content box", () => {
  render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => scroll.onLayoutChange())
  expect(viewport.scrollTop).toBe(1000)

  fireEvent.wheel(viewport, { deltaY: -20 })
  viewport.scrollTop = 700
  fireEvent.scroll(viewport)
  Object.defineProperty(viewport, "scrollHeight", { value: 1600 })
  act(() => scroll.onLayoutChange())
  expect(viewport.scrollTop).toBe(700)
})
it.each([
  "click",
  "wheel",
  "touch",
])("keeps following after %s at the bottom", (gesture) => {
  render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  if (gesture === "click")
    fireEvent.pointerDown(scroll.contentRef.current as HTMLElement)
  if (gesture === "wheel") fireEvent.wheel(viewport, { deltaY: 20 })
  if (gesture === "touch")
    fireEvent.touchStart(viewport, { touches: [{ clientY: 200 }] })
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(1000)
})
it.each([
  ["pointer", () => fireEvent.pointerDown(screen.getByRole("button"))],
  [
    "keyboard",
    () => fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" }),
  ],
])("keeps a disclosure trigger stationary for %s activation", (_, activate) => {
  render(<Fixture />)
  const viewport = geometry()
  const trigger = document.createElement("button")
  trigger.setAttribute("aria-expanded", "false")
  trigger.setAttribute("aria-controls", "details")
  scroll.contentRef.current?.append(trigger)
  act(() => resize())

  activate()
  // Native scroll anchoring can emit a scroll event during the first few
  // pixels of growth, while the viewport is still inside the bottom threshold.
  Object.defineProperty(viewport, "scrollHeight", { value: 1210 })
  fireEvent.scroll(viewport)
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => resize())

  expect(viewport.scrollTop).toBe(800)
  expect(scroll.atBottom).toBe(false)
})
it("does not treat inline editing keyboard navigation as transcript scrolling", () => {
  render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  const input = document.createElement("textarea")
  scroll.contentRef.current?.append(input)
  fireEvent.keyDown(input, { key: "ArrowUp" })
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(1000)
})
it("jumpToElement scrolls to the target and stops following growth", () => {
  render(<Fixture />)
  const viewport = geometry()
  const target = document.createElement("div")
  scroll.contentRef.current?.append(target)
  Object.defineProperty(target, "getBoundingClientRect", {
    value: () => ({ top: 600 - viewport.scrollTop }),
  })
  act(() => scroll.jumpToElement(target))
  frame(300)
  expect(viewport.scrollTop).toBe(576)
  expect(scroll.atBottom).toBe(false)
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(576)
})
it("arrow up on the transcript detaches from the bottom", () => {
  render(<Fixture />)
  const viewport = geometry()
  act(() => resize())
  fireEvent.keyDown(viewport, { key: "ArrowUp" })
  viewport.scrollTop = 700
  fireEvent.scroll(viewport)
  Object.defineProperty(viewport, "scrollHeight", { value: 1400 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(700)
  viewport.scrollTop = 1000
  fireEvent.scroll(viewport)
  fireEvent.keyDown(viewport, { key: "ArrowDown" })
  Object.defineProperty(viewport, "scrollHeight", { value: 1600 })
  act(() => resize())
  expect(viewport.scrollTop).toBe(1200)
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
