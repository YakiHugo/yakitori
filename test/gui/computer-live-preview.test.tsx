import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ComputerLivePreview } from "../../src/gui/components/computer-live-preview.tsx"
import type { ComputerPreviewFrame } from "../../src/protocol/computer-preview.ts"
import {
  computerPreviewCatalog,
  computerPreviewFrame,
} from "../fixtures/computer-preview.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  request.mockReset()
})

function deferred<T>() {
  let finish: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    finish = resolve
  })
  return {
    promise,
    resolve(value: T) {
      if (!finish) throw new Error("Deferred preview was not initialized")
      finish(value)
    },
  }
}
const captures = () =>
  request.mock.calls.filter(([method]) => method === "computer/preview/capture")

it("starts only on request, maps the physical pointer and releases a hidden viewer", async () => {
  const frame = computerPreviewFrame()
  request.mockImplementation(async (method) =>
    method === "computer/preview/catalog"
      ? computerPreviewCatalog
      : method === "computer/preview/capture"
        ? frame
        : {},
  )
  const view = render(
    <ComputerLivePreview apiBase="http://localhost:4100" active enabled />,
  )
  await screen.findByText("Owned fixture window")
  expect(captures()).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Start preview" }))
  await screen.findByRole("img", { name: "Live computer preview" })
  const pointer = screen.getByRole("img", { name: "Pointer position" })
  expect([pointer.style.left, pointer.style.top]).toEqual(["20%", "30%"])
  const owner = captures()[0]?.[1].viewerId
  view.rerender(
    <ComputerLivePreview
      apiBase="http://localhost:4100"
      active={false}
      enabled
    />,
  )
  expect(
    screen.queryByRole("img", { name: "Live computer preview" }),
  ).toBeNull()
  expect(request).toHaveBeenCalledWith("computer/preview/stop", {
    viewerId: owner,
  })
})

it("serializes slow frames and ignores an in-flight reply after Stop", async () => {
  const first = deferred<ComputerPreviewFrame>(),
    second = deferred<ComputerPreviewFrame>()
  let count = 0
  request.mockImplementation(async (method) => {
    if (method === "computer/preview/catalog") return computerPreviewCatalog
    if (method === "computer/preview/capture")
      return ++count === 1 ? first.promise : second.promise
    return {}
  })
  render(<ComputerLivePreview apiBase="http://localhost:4100" active enabled />)
  await screen.findByText("Owned fixture window")
  fireEvent.click(screen.getByRole("button", { name: "Start preview" }))
  expect(captures()).toHaveLength(1)
  vi.useFakeTimers()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(captures()).toHaveLength(1)
  const frame = computerPreviewFrame()
  await act(async () => first.resolve(frame))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(749)
  })
  expect(captures()).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(captures()).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: "Stop preview" }))
  await act(async () =>
    second.resolve({ ...frame, dataUrl: "data:image/png;base64,late-frame" }),
  )
  expect(
    screen
      .getByRole("img", { name: "Live computer preview" })
      .getAttribute("src"),
  ).toBe(frame.dataUrl)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(captures()).toHaveLength(2)
  expect(screen.getByRole("status").textContent).toBe("Paused")
})

it("does not retarget a resumed preview to the screen when its original window disappeared", async () => {
  let catalog = computerPreviewCatalog
  request.mockImplementation(async (method) =>
    method === "computer/preview/catalog"
      ? catalog
      : method === "computer/preview/capture"
        ? computerPreviewFrame()
        : {},
  )
  const view = render(
    <ComputerLivePreview apiBase="http://localhost:4100" active enabled />,
  )
  await screen.findByText("Owned fixture window")
  fireEvent.click(screen.getByRole("button", { name: "Start preview" }))
  await screen.findByRole("img", { name: "Live computer preview" })
  view.rerender(
    <ComputerLivePreview
      apiBase="http://localhost:4100"
      active={false}
      enabled
    />,
  )
  catalog = {
    targets: [
      {
        id: "screen",
        label: "Display 1",
        target: { scope: "screen", displayId: 1 },
      },
    ],
  }
  view.rerender(
    <ComputerLivePreview apiBase="http://localhost:4100" active enabled />,
  )
  await screen.findByText(
    "The preview target closed or restarted. Choose a target again.",
  )
  expect(
    screen
      .getByRole("button", { name: "Start preview" })
      .hasAttribute("disabled"),
  ).toBe(true)
  expect(captures()).toHaveLength(1)
  const catalogs = request.mock.calls.filter(
    ([method]) => method === "computer/preview/catalog",
  )
  expect(catalogs[0]?.[1].viewerId).not.toBe(catalogs[1]?.[1].viewerId)
})

it("does not create a preview connection without screen access", () => {
  render(
    <ComputerLivePreview
      apiBase="http://localhost:4100"
      active
      enabled={false}
    />,
  )
  expect(
    screen.getByText("Allow Screen Recording to preview apps."),
  ).not.toBeNull()
  expect(request).not.toHaveBeenCalled()
})
