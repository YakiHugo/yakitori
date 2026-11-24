import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ComputerPanel } from "../../src/gui/components/computer-panel.tsx"
import type { ComputerUseStatus } from "../../src/protocol/connections.ts"

const { request, listeners } = vi.hoisted(() => ({
  request: vi.fn(),
  listeners: new Set<(status: ComputerUseStatus) => void>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToComputerStatusChanges(
      listener: (status: ComputerUseStatus) => void,
    ) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }),
}))
afterEach(cleanup)

it.each([
  true,
  false,
])("waits for computer takeover settlement before offering reconnection (connected=%s)", async (connected) => {
  const stopped = Promise.withResolvers<ComputerUseStatus>()
  const status: ComputerUseStatus = {
    available: true,
    connected,
    inputOwner: { sessionId: "owner", turnId: "turn_owner" },
    backend: "yakitori-native",
    serverName: "computer",
    tools: ["observe", "input", "app"],
  }
  request.mockImplementation(async (method: string) =>
    method === "computer/takeover" ? stopped.promise : status,
  )
  render(<ComputerPanel apiBase="http://localhost:4100" />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Take over computer" }),
  )
  expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull()
  expect(
    screen
      .getByRole("button", { name: "Waiting for input release…" })
      .hasAttribute("disabled"),
  ).toBe(true)
  await act(async () => {
    stopped.resolve({
      available: true,
      backend: "yakitori-native",
      serverName: "computer",
      tools: [],
      connected: false,
    })
  })
  expect(
    screen
      .getByRole("button", { name: "Connect computer" })
      .hasAttribute("disabled"),
  ).toBe(false)
})

it("requires OS access before presenting a connected computer as ready, and refreshes after access changes", async () => {
  const status: ComputerUseStatus = {
    available: true,
    connected: true,
    backend: "yakitori-native",
    serverName: "computer",
    tools: ["observe", "input", "app"],
    permissions: { accessibility: false, screenRecording: true },
  }
  let current = status
  request.mockImplementation(async (method: string) =>
    method === "computer/preview/catalog"
      ? { targets: [] }
      : method === "computer/preview/stop"
        ? {}
        : current,
  )
  render(<ComputerPanel apiBase="http://localhost:4100" />)
  await screen.findByText("Connected · macOS access required")
  expect(screen.queryByText("Ready for your next message")).toBeNull()
  current = {
    ...status,
    permissions: { accessibility: true, screenRecording: true },
  }
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh computer connection" }),
  )
  await screen.findByText("Ready for your next message")
  expect(screen.queryByText("Connected · macOS access required")).toBeNull()
})

it("reflects connection changes pushed by the server without another permission probe", async () => {
  request.mockClear()
  const status: ComputerUseStatus = {
    available: true,
    connected: true,
    backend: "yakitori-native",
    serverName: "computer",
    tools: ["observe", "input", "app"],
    permissions: { accessibility: true, screenRecording: true },
  }
  request.mockImplementation(async (method) =>
    method === "computer/preview/catalog"
      ? { targets: [] }
      : method === "computer/preview/stop"
        ? {}
        : { ...status, connected: false, tools: [] },
  )
  render(<ComputerPanel apiBase="http://localhost:4100" />)
  await screen.findByRole("button", { name: "Connect computer" })
  await act(async () => {
    for (const listener of listeners) listener(status)
  })
  await screen.findByText("Ready for your next message")
  expect(
    request.mock.calls.filter(([method]) => method === "computer/status"),
  ).toHaveLength(1)
})
