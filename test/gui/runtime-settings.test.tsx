// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ConfigurationSnapshot } from "../../src/protocol/configuration.ts"
import { SettingsPage } from "../../src/gui/components/settings-page.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

function snapshot(enabled = false, version = "first"): ConfigurationSnapshot {
  return {
    configuration: { agents: { exposeModelOverrides: enabled } },
    effective: { agents: { expose_model_overrides: enabled } },
    origins: {},
    layers: [{ source: "user", path: "/home/config.toml", version }],
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({
    ...createInitialAppState(),
    settingsSection: "general",
  })
  request
    .mockReset()
    .mockImplementation(async (method, params) =>
      method === "config/write"
        ? snapshot(params.value === true, "second")
        : snapshot(),
    )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openSettings() {
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole("button", { name: "Runtime" }))
  await act(async () => {})
  return screen.getByRole("switch", { name: "Subagent model selection" })
}

it("opens runtime settings and persists the toggle against the user configuration version", async () => {
  const control = await openSettings()
  expect(screen.getByRole("region", { name: "Runtime settings" })).toBeDefined()
  expect(control.getAttribute("aria-checked")).toBe("false")
  fireEvent.click(control)
  expect(control.getAttribute("aria-checked")).toBe("true")
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(request).toHaveBeenCalledWith("config/write", {
    keyPath: ["agents", "expose_model_overrides"],
    value: true,
    expectedVersion: "first",
  })
  fireEvent.click(control)
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(request).toHaveBeenLastCalledWith("config/write", {
    keyPath: ["agents", "expose_model_overrides"],
    value: false,
    expectedVersion: "second",
  })
})

it("shows the effective project override without offering an ineffective user edit", async () => {
  request.mockResolvedValue({
    ...snapshot(true),
    origins: {
      "agents.expose_model_overrides": {
        source: "project",
        path: "/repo/.yakitori/config.toml",
        version: "project",
      },
    },
  })
  const control = await openSettings()
  expect(control.getAttribute("aria-checked")).toBe("true")
  expect(control).toHaveProperty("disabled", true)
  expect(
    screen.getByText(
      /This project overrides the setting in \/repo\/\.yakitori\/config.toml/,
    ),
  ).toBeDefined()
  expect(
    request.mock.calls.filter(([method]) => method === "config/write"),
  ).toHaveLength(0)
})

it("keeps failed edits visible and retries with a freshly read version", async () => {
  let writes = 0
  let reads = 0
  request.mockImplementation(async (method, params) => {
    if (method === "config/read")
      return snapshot(false, ++reads === 1 ? "first" : "external-edit")
    if (++writes === 1)
      throw new Error(
        "Configuration was modified since last read. Fetch it and retry.",
      )
    return snapshot(params.value === true, "third")
  })
  const control = await openSettings()
  fireEvent.click(control)
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(screen.getByRole("alert").textContent).toContain(
    "Configuration was modified",
  )
  expect(control.getAttribute("aria-checked")).toBe("true")
  fireEvent.click(screen.getByRole("button", { name: "Retry changes" }))
  await act(async () => {})
  expect(request).toHaveBeenLastCalledWith("config/write", {
    keyPath: ["agents", "expose_model_overrides"],
    value: true,
    expectedVersion: "external-edit",
  })
  expect(screen.queryByRole("alert")).toBeNull()
  expect(control.getAttribute("aria-checked")).toBe("true")
})

it("flushes queued changes when navigating away", async () => {
  fireEvent.click(await openSettings())
  fireEvent.click(screen.getByRole("button", { name: "General" }))
  await act(async () => {})
  expect(request).toHaveBeenCalledWith("config/write", {
    keyPath: ["agents", "expose_model_overrides"],
    value: true,
    expectedVersion: "first",
  })
})

it("reports configuration read failures and allows a fresh read", async () => {
  request.mockRejectedValueOnce(new Error("Runtime configuration unavailable"))
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole("button", { name: "Runtime" }))
  await act(async () => {})
  expect(screen.getByRole("alert").textContent).toBe(
    "Runtime configuration unavailable",
  )
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await act(async () => {})
  expect(
    screen.getByRole("switch", { name: "Subagent model selection" }),
  ).toBeDefined()
  expect(screen.queryByRole("alert")).toBeNull()
})
