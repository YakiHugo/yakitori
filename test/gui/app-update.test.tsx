// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { AppUpdate } from "../../src/gui/components/app-update.tsx"
import type {
  DesktopBuildInfo,
  DesktopUpdateBridge,
  DesktopUpdateRelease,
  DesktopUpdateState,
} from "../../src/protocol/desktop-update.ts"

const current: DesktopBuildInfo = {
  repository: "hugo/yakitori",
  version: "0.0.0",
  commit: "abcdef0123456789",
  dirty: false,
  channel: "main",
  buildNumber: 41,
  buildAttempt: 1,
  builtAt: "2026-11-14T12:00:00Z",
  platform: "darwin",
  arch: "arm64",
}
const release: DesktopUpdateRelease = {
  version: "0.0.0",
  commit: "123456789abcdef0",
  buildNumber: 42,
  buildAttempt: 1,
  publishedAt: "2026-11-15T12:00:00Z",
  releaseUrl: "https://example.com/releases/42",
}

function desktop(initial: DesktopUpdateState) {
  let listener: ((state: DesktopUpdateState) => void) | undefined
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const bridge = {
    getState: vi.fn(async () => initial),
    check: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    onState: vi.fn((next: (state: DesktopUpdateState) => void) => {
      listener = next
      return unsubscribe
    }),
  } satisfies DesktopUpdateBridge
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { updates: bridge },
  })
  return {
    bridge,
    unsubscribe,
    emit(state: DesktopUpdateState) {
      act(() => listener?.(state))
    },
  }
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})

it("hides in a browser without a desktop bridge", () => {
  render(<AppUpdate />)
  expect(screen.queryByRole("button")).toBeNull()
})

it.each([
  { phase: "idle", current },
  { phase: "checking", current },
  { phase: "unavailable", reason: "No packaged build" },
] satisfies DesktopUpdateState[])("keeps $phase status quiet", async (state) => {
  const { bridge } = desktop(state)
  render(<AppUpdate />)
  await waitFor(() => expect(bridge.getState).toHaveBeenCalledOnce())
  expect(screen.queryByRole("button")).toBeNull()
})

it("loads desktop status, follows events, and unsubscribes on unmount", async () => {
  const { emit, unsubscribe } = desktop({
    phase: "available",
    current,
    release,
  })
  const { unmount } = render(<AppUpdate />)
  expect(screen.queryByRole("button")).toBeNull()
  await screen.findByRole("button", { name: "Update available" })
  emit({ phase: "ready", current, release })
  expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy()
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it("keeps a newer desktop event when the initial snapshot arrives late", async () => {
  const { bridge, emit } = desktop({ phase: "idle", current })
  const snapshot = Promise.withResolvers<DesktopUpdateState>()
  bridge.getState.mockReturnValueOnce(snapshot.promise)
  render(<AppUpdate />)
  emit({ phase: "ready", current, release })
  await act(async () =>
    snapshot.resolve({ phase: "available", current, release }),
  )
  expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Update available" })).toBeNull()
})

it("shows build details and warns before replacing a dirty local build", async () => {
  const user = userEvent.setup()
  const { bridge } = desktop({
    phase: "available",
    current: { ...current, channel: "local", dirty: true },
    release,
  })
  render(<AppUpdate />)
  await user.click(
    await screen.findByRole("button", { name: "Update available" }),
  )
  expect(screen.getByRole("dialog").textContent).toContain("abcdef0 · Local build")
  expect(screen.getByRole("dialog").textContent).toContain("1234567 · Build 42")
  expect(screen.getByText(/Updating replaces this local build/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Download update" }))
  expect(bridge.download).toHaveBeenCalledOnce()
  expect(bridge.install).not.toHaveBeenCalled()
})

it("offers a local build action without describing it as a download", async () => {
  const user = userEvent.setup()
  const { bridge, emit } = desktop({
    phase: "available",
    current: { ...current, channel: "local", dirty: true },
    release: { ...release, source: "local" },
  })
  render(<AppUpdate />)
  await user.click(await screen.findByRole("button", { name: "Update available" }))
  expect(screen.queryByRole("button", { name: "Download update" })).toBeNull()
  expect(screen.queryByText(/Updating replaces this local build/)).toBeNull()
  await user.click(screen.getByRole("button", { name: "Build local update" }))
  expect(bridge.download).toHaveBeenCalledOnce()
  expect(bridge.install).not.toHaveBeenCalled()
  emit({ phase: "preparing", current, release: { ...release, source: "local" } })
  expect(screen.getByRole("status").textContent).toBe("Building local update…")
})

it("includes verified reused content in progress and reports local reuse", async () => {
  const user = userEvent.setup()
  desktop({
    phase: "downloading",
    current,
    release,
    downloadedBytes: 25 * 1024 * 1024,
    reusedBytes: 50 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
  })
  render(<AppUpdate />)
  await user.click(await screen.findByRole("button", { name: "Downloading update" }))
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("75")
  expect(screen.getByText("50 MiB reused from this device")).toBeTruthy()
})

it("reports download percentages and indeterminate preparation", async () => {
  const user = userEvent.setup()
  const { emit } = desktop({
    phase: "downloading",
    current,
    release,
    downloadedBytes: 25,
    totalBytes: 100,
  })
  render(<AppUpdate />)
  await user.click(
    await screen.findByRole("button", { name: "Downloading update" }),
  )
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("25")
  expect(screen.getByRole("status").textContent).toContain("25%")
  emit({ phase: "preparing", current, release })
  expect(screen.getByRole("status").textContent).toBe("Preparing update…")
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false)
})

it("requires explicit restart confirmation and disables installation in progress", async () => {
  const user = userEvent.setup()
  const { bridge, emit } = desktop({ phase: "ready", current, release })
  render(<AppUpdate />)
  await user.click(
    await screen.findByRole("button", { name: "Restart to update" }),
  )
  expect(bridge.install).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Restart and update" }))
  expect(bridge.install).toHaveBeenCalledOnce()
  emit({ phase: "installing", current, release })
  expect(
    (
      screen.getByRole("button", {
        name: "Installing update",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true)
  expect(
    screen.queryByRole("button", { name: "Restart and update" }),
  ).toBeNull()
})

it.each([
  "check",
  "download",
  "install",
] as const)("retries a failed %s with its visible error", async (retry) => {
  const user = userEvent.setup()
  const { bridge } = desktop({
    phase: "error",
    current,
    release,
    message: "Connection interrupted",
    retry,
  })
  render(<AppUpdate />)
  await user.click(await screen.findByRole("button", { name: "Update failed" }))
  expect(screen.getByRole("alert").textContent).toBe("Connection interrupted")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(bridge[retry]).toHaveBeenCalledOnce()
})

it("shows rejected action requests and allows retrying the same operation", async () => {
  const user = userEvent.setup()
  const { bridge } = desktop({ phase: "available", current, release })
  bridge.download.mockRejectedValueOnce(new Error("Desktop connection lost"))
  render(<AppUpdate />)
  await user.click(
    await screen.findByRole("button", { name: "Update available" }),
  )
  await user.click(screen.getByRole("button", { name: "Download update" }))
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Desktop connection lost",
  )
  await user.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Download update" }),
    ).toBeTruthy(),
  )
  expect(bridge.download).toHaveBeenCalledTimes(2)
})

it("surfaces an initial bridge failure and reloads status on retry", async () => {
  const user = userEvent.setup()
  const { bridge } = desktop({ phase: "available", current, release })
  bridge.getState.mockRejectedValueOnce(new Error("Desktop unavailable"))
  render(<AppUpdate />)
  await user.click(await screen.findByRole("button", { name: "Update failed" }))
  expect(screen.getByRole("alert").textContent).toBe("Desktop unavailable")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(
    await screen.findByRole("button", { name: "Download update" }),
  ).toBeTruthy()
})

it("focuses the popover, restores focus on Escape, and dismisses outside", async () => {
  const user = userEvent.setup()
  desktop({ phase: "available", current, release })
  render(
    <>
      <AppUpdate />
      <button type="button">Outside</button>
    </>,
  )
  const trigger = await screen.findByRole("button", {
    name: "Update available",
  })
  await user.click(trigger)
  expect(document.activeElement).toBe(screen.getByRole("dialog"))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await user.click(trigger)
  await user.click(screen.getByRole("button", { name: "Outside" }))
  expect(screen.queryByRole("dialog")).toBeNull()
})
