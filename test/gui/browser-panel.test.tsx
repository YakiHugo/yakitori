// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  WorkspaceBrowserBridge,
  WorkspaceBrowserViewport,
} from "../../src/desktop/workspace-browser-types.ts"
import { BrowserPanel } from "../../src/gui/components/browser-panel.tsx"

const capturedPage = "data:image/png;base64,captured-page"
const viewport =
  vi.fn<(input: WorkspaceBrowserViewport) => Promise<string | undefined>>()
const bridge: WorkspaceBrowserBridge = {
  create: vi.fn(async ({ tabId }) => ({
    tabId,
    url: "https://example.com",
    title: "Example",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })),
  viewport,
  navigate: vi.fn(async () => {}),
  action: vi.fn(async () => {}),
  selection: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  onState: vi.fn(() => () => {}),
  onSelection: vi.fn(() => () => {}),
  onShortcut: vi.fn(() => () => {}),
}
const popups: HTMLElement[] = []

function popup(x: number) {
  const element = document.createElement("div")
  element.setAttribute("role", "menu")
  const rect = new DOMRect(x, 150, 200, 100)
  vi.spyOn(element, "getClientRects").mockReturnValue(
    Object.assign([rect], { item: () => rect }),
  )
  document.body.append(element)
  popups.push(element)
  return element
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  viewport.mockReset()
  viewport.mockImplementation(async (input) =>
    input.visible && input.occluded ? capturedPage : undefined,
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(600, 100, 400, 500),
  )
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { browser: bridge },
  })
})

afterEach(() => {
  cleanup()
  for (const element of popups.splice(0)) element.remove()
  vi.restoreAllMocks()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})

describe("native browser viewport coordination", () => {
  it("synchronizes popup overlap even when native occlusion suspends animation frames", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1)
    const adjacent = popup(50)
    const view = render(<BrowserPanel tabId="browser-tab" active />)
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith({
        tabId: "browser-tab",
        visible: true,
        occluded: false,
        x: 600,
        y: 100,
        width: 400,
        height: 500,
      }),
    )
    expect(view.container.querySelector("img")).toBeNull()

    const overlapping = popup(650)
    fireEvent(window, new Event("resize"))
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, occluded: true }),
      ),
    )
    await waitFor(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        capturedPage,
      ),
    )
    overlapping.remove()
    fireEvent(window, new Event("resize"))
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, occluded: false }),
      ),
    )
    await waitFor(() => expect(view.container.querySelector("img")).toBeNull())
    expect(adjacent.isConnected).toBe(true)
  })

  it("hides the native page and its preview when its tab becomes inactive", async () => {
    popup(650)
    const view = render(<BrowserPanel tabId="browser-tab" active />)
    await waitFor(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        capturedPage,
      ),
    )
    view.rerender(<BrowserPanel tabId="browser-tab" active={false} />)
    expect(view.container.querySelector("img")).toBeNull()
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ tabId: "browser-tab", visible: false }),
      ),
    )
  })

  it("ignores a delayed capture after the overlapping popup is gone", async () => {
    const capture = deferred<string | undefined>()
    viewport.mockImplementation(async (input) =>
      input.occluded ? capture.promise : undefined,
    )
    const overlapping = popup(650)
    const view = render(<BrowserPanel tabId="browser-tab" active />)
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ occluded: true }),
      ),
    )
    overlapping.remove()
    fireEvent(window, new Event("resize"))
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, occluded: false }),
      ),
    )
    await act(async () => capture.resolve(capturedPage))
    expect(view.container.querySelector("img")).toBeNull()
  })

  it("ignores a delayed capture from an earlier active tab lifetime", async () => {
    const capture = deferred<string | undefined>()
    viewport.mockImplementation(async (input) =>
      input.visible && input.occluded ? capture.promise : undefined,
    )
    const overlapping = popup(650)
    const view = render(<BrowserPanel tabId="browser-tab" active />)
    await waitFor(() =>
      expect(viewport).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, occluded: true }),
      ),
    )
    view.rerender(<BrowserPanel tabId="browser-tab" active={false} />)
    overlapping.remove()
    view.rerender(<BrowserPanel tabId="browser-tab" active />)
    await waitFor(() =>
      expect(viewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, occluded: false }),
      ),
    )
    await act(async () => capture.resolve(capturedPage))
    expect(view.container.querySelector("img")).toBeNull()
  })
})
