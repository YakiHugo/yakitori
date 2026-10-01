// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionCommandPanel } from "../../src/gui/components/session-command-panel.tsx"
import { createExecutionViewState } from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request } = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: object) => Promise<unknown>>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToMcpStatusChanges: () => () => {},
  }),
}))

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
  request.mockReset()
})

afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

it("shows the selected session's MCP servers and their connection state", async () => {
  request.mockResolvedValue({
    servers: [
      {
        name: "docs",
        enabled: false,
        state: "stopped",
        transport: "stdio",
        toolCount: 0,
        authenticated: false,
      },
      {
        name: "search",
        enabled: true,
        state: "ready",
        transport: "http",
        toolCount: 3,
        authenticated: true,
      },
    ],
  })
  useAppStore.setState({
    selection: { sessionId: "session_a" },
    commandPanel: { kind: "mcp", sessionId: "session_a" },
  })
  render(<SessionCommandPanel />)

  expect(await screen.findByText("docs")).toBeDefined()
  expect(screen.getByText("disabled")).toBeDefined()
  expect(screen.getByText("search")).toBeDefined()
  expect(screen.getByText(/3 tools · Signed in/)).toBeDefined()
  expect(request).toHaveBeenCalledWith("mcp/status", {
    sessionId: "session_a",
  })

  await userEvent.setup().click(screen.getByRole("button", { name: "Close" }))
  expect(screen.queryByRole("region", { name: "MCP status" })).toBeNull()
})

it("uses the last model context and the provider's reported quota window", async () => {
  request.mockResolvedValue({
    subscription: {
      provider: "codex",
      displayName: "Codex",
      availability: "available",
      usage: {
        status: "available",
        buckets: [{ name: "7-day limit", usedPercent: 2 }],
      },
    },
  })
  useAppStore.setState({
    selection: { sessionId: "session_a" },
    selectedSession: {
      id: "session_a",
      conversationId: "conversation_a",
      seq: 0,
      createdAt: "2026-09-28T00:00:00Z",
      updatedAt: "2026-09-28T00:00:00Z",
      currentModel: { provider: "codex", model: "gpt-6-sol" },
      pendingInputs: [],
      pendingPermissions: [],
      counts: {
        inputs: 0,
        pendingInputs: 0,
        turns: 0,
        items: 0,
        permissions: 0,
        tools: 0,
      },
    },
    providers: [
      {
        name: "codex",
        models: [
          {
            id: "gpt-6-sol",
            instructionProfileId: "gpt-6-sol",
            effectiveContextWindowTokens: 200000,
          },
        ],
      },
    ],
    execution: {
      ...createExecutionViewState(),
      lastModel: { provider: "codex", model: "gpt-6-sol" },
      contextTokens: {
        activeContextTokens: 100_000,
        provider: "codex",
        model: "gpt-6-sol",
      },
    },
    commandPanel: { kind: "status", sessionId: "session_a" },
  })
  render(<SessionCommandPanel />)

  expect(screen.getByText("session_a")).toBeDefined()
  expect(
    screen.getByText(/100,000 tokens in the last model context/),
  ).toBeDefined()
  expect(screen.getByText(/50% remaining/)).toBeDefined()
  expect(await screen.findByText(/98% remaining/)).toBeDefined()
  expect(request).toHaveBeenCalledWith("subscription/read", {
    provider: "codex",
  })
})
