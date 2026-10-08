// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionCommandPanel } from "../../src/gui/components/session-command-panel.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { McpStatusChangedNotification } from "../../src/server/rpc/methods.ts"

const { request, changes } = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: object) => Promise<unknown>>(),
  changes: new Set<(value: McpStatusChangedNotification) => void>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToMcpStatusChanges: (
      listener: (value: McpStatusChangedNotification) => void,
    ) => {
      changes.add(listener)
      return () => changes.delete(listener)
    },
  }),
}))
beforeEach(() => {
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "session-a" },
    commandPanel: { kind: "mcp", sessionId: "session-a" },
  })
  request.mockReset()
})
afterEach(() => {
  cleanup()
  changes.clear()
})

it.each([
  "success",
  "failure",
])("ignores a superseded MCP status %s after a newer notification refresh", async (outcome) => {
  const pending: {
    resolve(value: unknown): void
    reject(error: Error): void
  }[] = []
  request.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )
  render(<SessionCommandPanel />)
  act(() => {
    for (const listener of changes) listener({ sessionId: "session-a" })
  })
  expect(pending).toHaveLength(2)
  await act(async () =>
    pending[1]?.resolve({
      servers: [
        {
          name: "current-server",
          enabled: true,
          state: "ready",
          transport: "stdio",
          toolCount: 3,
          authenticated: false,
        },
      ],
    }),
  )
  expect(screen.getByText("current-server")).toBeDefined()
  await act(async () => {
    if (outcome === "success") pending[0]?.resolve({ servers: [] })
    else pending[0]?.reject(new Error("obsolete request failed"))
  })
  expect(screen.getByText("current-server")).toBeDefined()
  expect(screen.queryByRole("alert")).toBeNull()
})
