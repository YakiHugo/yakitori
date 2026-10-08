// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ActivitySpinner } from "../../src/gui/components/activity-spinner.tsx"
import { ImageLightbox } from "../../src/gui/components/image-lightbox.tsx"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("owns the activity frame timer only while the spinner is mounted", () => {
  vi.useFakeTimers()
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: false,
  } as MediaQueryList)
  const { unmount } = render(<ActivitySpinner />)
  expect(screen.getByRole("status").textContent).toBe("⠋")
  act(() => vi.advanceTimersByTime(100))
  expect(screen.getByRole("status").textContent).toBe("⠙")
  act(() => vi.advanceTimersByTime(900))
  expect(screen.getByRole("status").textContent).toBe("⠋")
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it("does not animate activity when reduced motion was requested at mount", () => {
  vi.useFakeTimers()
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
  } as MediaQueryList)
  render(<ActivitySpinner />)
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByRole("status").textContent).toBe("⠋")
  expect(vi.getTimerCount()).toBe(0)
})

it("fits a loaded image, bounds zoom, and releases its Escape listener on unmount", () => {
  const onClose = vi.fn()
  const { unmount } = render(
    <ImageLightbox
      src="https://example.com/image.png"
      name="sample"
      onClose={onClose}
    />,
  )
  const image = screen.getByRole("img", { name: "sample" })
  Object.defineProperties(image, {
    naturalWidth: { value: 1200 },
    naturalHeight: { value: 600 },
  })
  const parent = image.parentElement
  if (!parent) throw new Error("Expected image viewport")
  Object.defineProperties(parent, {
    clientWidth: { value: 800 },
    clientHeight: { value: 300 },
  })
  fireEvent.load(image)
  expect(image.style.width).toBe("600px")
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
  expect(image.style.width).toBe("750px")
  for (let count = 0; count < 30; count += 1)
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
  expect(screen.getByRole("button", { name: "Zoom in" })).toHaveProperty(
    "disabled",
    true,
  )
  expect(image.style.width).toBe("3000px")
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
  expect(image.style.width).toBe("600px")
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).toHaveBeenCalledTimes(1)
  unmount()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it("refits after viewport changes while preserving actual-size pixels", () => {
  const addListener = vi.spyOn(window, "addEventListener")
  const removeListener = vi.spyOn(window, "removeEventListener")
  const { unmount } = render(
    <ImageLightbox
      src="diagram.svg"
      name="resizable diagram"
      onClose={() => {}}
    />,
  )
  const image = screen.getByRole("img", { name: "resizable diagram" })
  Object.defineProperties(image, {
    naturalWidth: { value: 1200 },
    naturalHeight: { value: 600 },
  })
  const viewport = image.parentElement
  if (!viewport) throw new Error("Expected image viewport")
  let width = 800
  let height = 600
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  })
  viewport.style.padding = "0px 40px 16px"
  fireEvent.load(image)
  expect(image.style.width).toBe("720px")

  width = 400
  fireEvent(window, new Event("resize"))
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
  expect(image.style.width).toBe("320px")

  fireEvent.click(screen.getByRole("button", { name: "Actual size" }))
  expect(image.style.width).toBe("1200px")
  height = 116
  fireEvent(window, new Event("resize"))
  expect(image.style.width).toBe("1200px")
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
  expect(image.style.width).toBe("200px")

  width = 1000
  height = 816
  fireEvent(window, new Event("resize"))
  expect(image.style.width).toBe("920px")

  // Reset takes a fresh measurement even if a resize notification is pending.
  width = 300
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
  expect(image.style.width).toBe("220px")
  const resizeListener = addListener.mock.calls.find(
    ([event]) => event === "resize",
  )?.[1]
  expect(resizeListener).toBeTypeOf("function")
  unmount()
  expect(removeListener).toHaveBeenCalledWith("resize", resizeListener)
})
