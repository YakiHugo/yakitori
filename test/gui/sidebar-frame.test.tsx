// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SidebarFrame } from "../../src/gui/components/sidebar-frame.tsx"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

vi.mock("../../src/gui/components/sidebar.tsx", () => ({
  Sidebar: () => <nav aria-label="Sessions">Session list</nav>,
}))
vi.mock("../../src/gui/components/session-search.tsx", () => ({
  SessionSearch: () => <div>Session search</div>,
}))

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1400,
  })
  useWorkspaceStore.setState({ open: false, expanded: false })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function resizeViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  })
  fireEvent.resize(window)
}

function expectWidth(width: number, maximum: number) {
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  expect(divider.getAttribute("aria-valuemin")).toBe("240")
  expect(divider.getAttribute("aria-valuemax")).toBe(String(maximum))
  expect(divider.getAttribute("aria-valuenow")).toBe(String(width))
  expect(
    screen
      .getByRole("complementary", { name: "Sidebar" })
      .style.getPropertyValue("--sidebar-width"),
  ).toBe(`${width}px`)
}

it("starts at 275 pixels with accessible 240–520 pixel resize bounds", () => {
  render(<SidebarFrame />)
  expectWidth(275, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
})

it("temporarily fits the viewport without replacing the preferred width and restores it when space returns", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  render(<SidebarFrame />)
  expectWidth(500, 520)

  resizeViewport(1000)
  expectWidth(328, 328)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")

  resizeViewport(1400)
  expectWidth(500, 520)
})

it("reserves room when the split workspace opens and restores the preferred width when it expands or closes", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  resizeViewport(1000)
  render(<SidebarFrame />)
  expectWidth(500, 520)

  act(() => useWorkspaceStore.getState().setOpen(true))
  expectWidth(328, 328)
  act(() => useWorkspaceStore.getState().setExpanded(true))
  expectWidth(500, 520)
  act(() => useWorkspaceStore.getState().setExpanded(false))
  expectWidth(328, 328)
  act(() => useWorkspaceStore.getState().setOpen(false))
  expectWidth(500, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")
})

it("uses split-pane bounds at 912 pixels and viewport bounds below that breakpoint", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  resizeViewport(912)
  render(<SidebarFrame />)
  expectWidth(240, 240)

  resizeViewport(911)
  expectWidth(500, 520)
  resizeViewport(750)
  expectWidth(500, 510)
  resizeViewport(470)
  expectWidth(240, 240)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")
})

it("adjusts the divider with arrow keys, stops at the minimum, and resets to 275 on double click", () => {
  render(<SidebarFrame />)
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  fireEvent.keyDown(divider, { key: "ArrowLeft" })
  expectWidth(259, 520)
  fireEvent.keyDown(divider, { key: "ArrowLeft" })
  fireEvent.keyDown(divider, { key: "ArrowLeft" })
  expectWidth(240, 520)
  fireEvent.keyDown(divider, { key: "ArrowLeft" })
  expectWidth(240, 520)
  fireEvent.keyDown(divider, { key: "ArrowRight" })
  expectWidth(256, 520)
  fireEvent.doubleClick(divider)
  expectWidth(275, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
})

it("limits keyboard resizing to the space available beside the split workspace", () => {
  localStorage.setItem("yakitori.sidebarWidth", "320")
  useWorkspaceStore.setState({ open: true })
  resizeViewport(1000)
  render(<SidebarFrame />)
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  fireEvent.keyDown(divider, { key: "ArrowRight" })
  expectWidth(328, 328)
  fireEvent.keyDown(divider, { key: "ArrowRight" })
  expectWidth(328, 328)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("328")
})

it("resets the preferred width to 275 while constrained and reveals that default when space returns", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  resizeViewport(912)
  render(<SidebarFrame />)
  expectWidth(240, 240)

  fireEvent.doubleClick(
    screen.getByRole("separator", { name: "Sidebar width" }),
  )
  expectWidth(240, 240)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
  resizeViewport(1400)
  expectWidth(275, 520)
})

it("clamps pointer resizing to its bounds and saves the chosen width on release", () => {
  render(<SidebarFrame />)
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  const captured = new Set<number>()
  // Happy DOM has no pointer capture; retain the browser's capture semantics
  // while exercising SidebarFrame's actual pointer handlers.
  Object.defineProperties(divider, {
    setPointerCapture: { value: (id: number) => captured.add(id) },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => captured.delete(id) },
  })
  fireEvent.pointerDown(divider, { button: 0, pointerId: 1 })
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 180 })
  expectWidth(240, 520)
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800 })
  expectWidth(520, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
  fireEvent.pointerUp(divider, { pointerId: 1 })
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("520")
})
