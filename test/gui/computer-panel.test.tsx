import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ComputerPanel } from "../../src/gui/components/computer-panel.tsx"
import type { ComputerUseStatus } from "../../src/protocol/connections.ts"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
afterEach(cleanup)

it("requires OS access before presenting a connected computer as ready, and refreshes after access changes", async () => {
  const status: ComputerUseStatus = {
    available: true,
    connected: true,
    backend: "yakitori-native",
    serverName: "computer",
    tools: ["control"],
    permissions: { accessibility: false, screenRecording: true },
  }
  request.mockResolvedValue(status)
  render(<ComputerPanel apiBase="http://localhost:4100" />)
  await screen.findByText("Connected · macOS access required")
  expect(screen.queryByText("Ready for your next message")).toBeNull()
  request.mockResolvedValue({
    ...status,
    permissions: { accessibility: true, screenRecording: true },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh computer connection" }),
  )
  await screen.findByText("Ready for your next message")
  expect(screen.queryByText("Connected · macOS access required")).toBeNull()
})
