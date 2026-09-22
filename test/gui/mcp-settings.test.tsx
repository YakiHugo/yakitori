// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { McpSettings } from "../../src/gui/components/mcp-settings.tsx"
import { SettingsPage } from "../../src/gui/components/settings-page.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

const { request, openUrlTarget } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  openUrlTarget:
    vi.fn<(target: { kind: "url"; url: string }) => Promise<void>>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
vi.mock("../../src/gui/lib/open-resource.ts", () => ({ openUrlTarget }))

const docsServer = {
  name: "docs",
  transport: "http" as const,
  enabled: true,
  state: "unconnected" as const,
  toolCount: 0,
  authenticated: false,
}

function session(id: string): ApiSessionDetail {
  return {
    id,
    conversationId: `conversation-${id}`,
    workingDirectory: "/repo",
    title: id,
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    seq: 1,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      turns: 0,
      inputs: 0,
      tools: 0,
      pendingInputs: 0,
      items: 0,
      permissions: 0,
    },
  }
}

beforeEach(() => {
  request.mockReset().mockResolvedValue({ servers: [docsServer] })
  openUrlTarget.mockReset().mockResolvedValue()
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(createInitialAppState())
})

it("opens MCP settings with global status when no conversation is selected", async () => {
  const user = userEvent.setup()
  useAppStore.setState({ settingsSection: "general" })
  render(<SettingsPage />)
  await user.click(screen.getByRole("button", { name: "MCP servers" }))
  expect(await screen.findByText("docs")).toBeDefined()
  expect(
    screen.getByRole("region", { name: "MCP server settings" }),
  ).toBeDefined()
  expect(screen.getByText(/global configuration/)).toBeDefined()
  expect(request).toHaveBeenCalledWith("mcp/status", {})
})

it("refreshes server states while mounted and stops polling when closed", async () => {
  vi.useFakeTimers()
  request.mockResolvedValueOnce({ servers: [docsServer] }).mockResolvedValue({
    servers: [{ ...docsServer, state: "ready", toolCount: 3 }],
  })
  const view = render(<McpSettings />)
  await act(async () => {})
  expect(screen.getByText("Not connected")).toBeDefined()
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(screen.getByText("Connected")).toBeDefined()
  expect(screen.getByText(/3 tools/)).toBeDefined()
  view.unmount()
  const requestsBeforeClose = request.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(request.mock.calls).toHaveLength(requestsBeforeClose)
})

it("does not let an old session response overwrite the current session", async () => {
  let resolveOld!: (value: unknown) => void
  const old = new Promise<unknown>((resolve) => {
    resolveOld = resolve
  })
  useAppStore.setState({ selectedSession: session("old") })
  request.mockImplementation(async (_method, params) =>
    params.sessionId === "old"
      ? old
      : { servers: [{ ...docsServer, name: "current-docs" }] },
  )
  render(<McpSettings />)
  act(() => useAppStore.setState({ selectedSession: session("current") }))
  expect(await screen.findByText("current-docs")).toBeDefined()
  await act(async () =>
    resolveOld({ servers: [{ ...docsServer, name: "old-docs" }] }),
  )
  expect(screen.queryByText("old-docs")).toBeNull()
  expect(request).toHaveBeenCalledWith("mcp/status", { sessionId: "current" })
})

it("opens OAuth in the existing URL handler and follows pending login to completion", async () => {
  vi.useFakeTimers()
  useAppStore.setState({ selectedSession: session("work") })
  let loginState: "initial" | "pending" | "ready" = "initial"
  request.mockImplementation(async (method) => {
    if (method === "mcp/login") {
      loginState = "pending"
      return { authorizationUrl: "https://docs.example/authorize" }
    }
    return {
      servers: [
        {
          ...docsServer,
          ...(loginState === "pending" ? { loginState: "pending" } : {}),
          ...(loginState === "ready"
            ? { state: "ready", authenticated: true, toolCount: 2 }
            : {}),
        },
      ],
    }
  })
  render(<McpSettings />)
  await act(async () => {})
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Log in to docs" })),
  )
  expect(request).toHaveBeenCalledWith("mcp/login", {
    name: "docs",
    sessionId: "work",
  })
  expect(openUrlTarget).toHaveBeenCalledWith({
    kind: "url",
    url: "https://docs.example/authorize",
  })
  expect(screen.getByText("Waiting for sign-in in your browser…")).toBeDefined()
  expect(screen.getByRole("button", { name: "Log in to docs" })).toHaveProperty(
    "disabled",
    true,
  )
  loginState = "ready"
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  expect(screen.getByRole("button", { name: "Log out of docs" })).toBeDefined()
  expect(screen.getByText(/Signed in/)).toBeDefined()
})

it("refreshes after logout and reconnect without sending credentials", async () => {
  const user = userEvent.setup()
  useAppStore.setState({ selectedSession: session("work") })
  let authenticated = true
  let connected = true
  request.mockImplementation(async (method) => {
    if (method === "mcp/logout") {
      authenticated = false
      connected = false
      return {}
    }
    if (method === "mcp/reconnect") {
      connected = true
      return {}
    }
    return {
      servers: [
        {
          ...docsServer,
          authenticated,
          state: connected ? "ready" : "stopped",
          toolCount: connected ? 2 : 0,
        },
      ],
    }
  })
  render(<McpSettings />)
  await user.click(
    await screen.findByRole("button", { name: "Log out of docs" }),
  )
  expect(await screen.findByText("Stopped")).toBeDefined()
  expect(request).toHaveBeenCalledWith("mcp/logout", {
    name: "docs",
    sessionId: "work",
  })
  await user.click(screen.getByRole("button", { name: "Reconnect docs" }))
  expect(await screen.findByText("Connected")).toBeDefined()
  expect(request).toHaveBeenCalledWith("mcp/reconnect", {
    name: "docs",
    sessionId: "work",
  })
})

it("shows request and server errors, retaining prior status and allowing retry", async () => {
  const user = userEvent.setup()
  let failRefresh = false
  let failReconnect = true
  request.mockImplementation(async (method) => {
    if (method === "mcp/reconnect") {
      if (failReconnect) throw new Error("Server refused the connection")
      return {}
    }
    if (failRefresh) throw new Error("Server status unavailable")
    return {
      servers: [{ ...docsServer, state: "failed", error: "Login required" }],
    }
  })
  render(<McpSettings />)
  expect(await screen.findByText("Login required")).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Reconnect docs" }))
  expect(
    await screen.findByText("docs: Server refused the connection"),
  ).toBeDefined()
  failReconnect = false
  await user.click(screen.getByRole("button", { name: "Reconnect docs" }))
  expect(screen.queryByText("docs: Server refused the connection")).toBeNull()
  failRefresh = true
  await user.click(screen.getByRole("button", { name: "Refresh" }))
  expect(await screen.findByText(/Server status unavailable/)).toBeDefined()
  expect(screen.getByText("docs")).toBeDefined()
  failRefresh = false
  await user.click(screen.getByRole("button", { name: "Refresh" }))
  expect(screen.queryByText(/Server status unavailable/)).toBeNull()
})

it("reports failed browser opening and offers no login action for local processes", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) =>
    method === "mcp/login"
      ? { authorizationUrl: "https://docs.example/authorize" }
      : {
          servers: [
            docsServer,
            {
              ...docsServer,
              name: "local",
              transport: "stdio",
              enabled: false,
            },
          ],
        },
  )
  openUrlTarget.mockRejectedValueOnce(new Error("Browser could not open"))
  render(<McpSettings />)
  await user.click(
    await screen.findByRole("button", { name: "Log in to docs" }),
  )
  expect(await screen.findByText("docs: Browser could not open")).toBeDefined()
  expect(screen.queryByRole("button", { name: "Log in to local" })).toBeNull()
  expect(
    screen.getByRole("button", { name: "Reconnect local" }),
  ).toHaveProperty("disabled", true)
})
