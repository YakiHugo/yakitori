// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useState } from "react"
import { SidebarFrame } from "../../src/gui/components/sidebar-frame.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  chooseNewEngine,
  initializeEngineSessions,
  useEngineStore,
} from "../../src/gui/store/engine-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

vi.mock("../../src/gui/components/sidebar.tsx", () => ({
  Sidebar: () => <nav aria-label="Sessions">Session list</nav>,
}))
vi.mock("../../src/gui/components/session-search.tsx", () => ({
  SessionSearch: () => <div>Session search</div>,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (original) => ({
  ...(await original<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => ({
    subscribeToEngineSessionChanges: () => () => {},
    request: async (method: string) => {
      if (method === "engine/list") return { engines: [] }
      if (method === "engineSession/list") return { sessions: [] }
      throw new Error(`Unexpected request: ${method}`)
    },
  }),
}))

function Frame() {
  const [open, setOpen] = useState(true)
  return <SidebarFrame open={open} setOpen={setOpen} />
}

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
  expect(
    document.documentElement.style.getPropertyValue("--sidebar-width"),
  ).toBe(`${width}px`)
}

it("starts at 275 pixels with accessible 240–520 pixel resize bounds", () => {
  render(<Frame />)
  expectWidth(275, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
})

it("temporarily fits the viewport without replacing the preferred width and restores it when space returns", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  render(<Frame />)
  expectWidth(500, 520)

  resizeViewport(1000)
  expectWidth(280, 280)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")

  resizeViewport(1400)
  expectWidth(500, 520)
})

it("reserves room when the split workspace opens and restores the preferred width when it expands or closes", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  resizeViewport(1000)
  render(<Frame />)
  expectWidth(500, 520)

  act(() => useWorkspaceStore.getState().setOpen(true))
  expectWidth(280, 280)
  act(() => useWorkspaceStore.getState().setExpanded(true))
  expectWidth(500, 520)
  act(() => useWorkspaceStore.getState().setExpanded(false))
  expectWidth(280, 280)
  act(() => useWorkspaceStore.getState().setOpen(false))
  expectWidth(500, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")
})

it("uses split-pane bounds at 960 pixels and viewport bounds below that breakpoint", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  resizeViewport(960)
  render(<Frame />)
  expectWidth(240, 240)

  resizeViewport(959)
  expectWidth(500, 520)
  resizeViewport(750)
  expectWidth(462, 462)
  resizeViewport(470)
  expectWidth(240, 240)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("500")
})

it("adjusts the divider with arrow keys, stops at the minimum, and resets to 275 on double click", () => {
  render(<Frame />)
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
  render(<Frame />)
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  fireEvent.keyDown(divider, { key: "ArrowRight" })
  expectWidth(280, 280)
  fireEvent.keyDown(divider, { key: "ArrowRight" })
  expectWidth(280, 280)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("280")
})

it("resets the preferred width to 275 while constrained and reveals that default when space returns", () => {
  localStorage.setItem("yakitori.sidebarWidth", "500")
  useWorkspaceStore.setState({ open: true })
  resizeViewport(960)
  render(<Frame />)
  expectWidth(240, 240)

  fireEvent.doubleClick(
    screen.getByRole("separator", { name: "Sidebar width" }),
  )
  expectWidth(240, 240)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
  resizeViewport(1400)
  expectWidth(275, 520)
})

it("resizes relative to the sidebar edge and saves the clamped width on release", () => {
  render(<Frame />)
  const divider = screen.getByRole("separator", { name: "Sidebar width" })
  const captured = new Set<number>()
  vi.spyOn(
    screen.getByRole("complementary", { name: "Sidebar" }),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(48, 40, 275, 860))
  // Happy DOM has no pointer capture; retain the browser's capture semantics
  // while exercising SidebarFrame's actual pointer handlers.
  Object.defineProperties(divider, {
    setPointerCapture: { value: (id: number) => captured.add(id) },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => captured.delete(id) },
  })
  fireEvent.pointerDown(divider, { button: 0, pointerId: 1 })
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 400 })
  expectWidth(352, 520)
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 180 })
  expectWidth(240, 520)
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800 })
  expectWidth(520, 520)
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("275")
  fireEvent.pointerUp(divider, { pointerId: 1 })
  expect(localStorage.getItem("yakitori.sidebarWidth")).toBe("520")
})

it("keeps the selected external engine when the new-session shortcut clears native selection", async () => {
  useAppStore.setState(createInitialAppState())
  await initializeEngineSessions()
  chooseNewEngine("external")
  render(<Frame />)
  fireEvent.keyDown(window, { key: "n", metaKey: true })
  expect(useEngineStore.getState().engineId).toBe("external")
  expect(useEngineStore.getState().sessionId).toBeUndefined()
  expect(useAppStore.getState().selection.sessionId).toBeUndefined()
})
