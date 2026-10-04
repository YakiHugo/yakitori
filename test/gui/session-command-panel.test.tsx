// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
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

it("keeps quota values and errors with their provider while the same status panel remains open", async () => {
  const responses = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }[]
  >()
  request.mockImplementation(async (_method, params) => {
    const provider = (params as { provider: string }).provider
    return new Promise((resolve, reject) => {
      const pending = responses.get(provider) ?? []
      pending.push({ resolve, reject })
      responses.set(provider, pending)
    })
  })
  useAppStore.setState({
    selection: { sessionId: "session_a" },
    commandPanel: { kind: "status", sessionId: "session_a" },
    execution: {
      ...createExecutionViewState(),
      lastModel: { provider: "codex", model: "codex-model" },
    },
  })
  render(<SessionCommandPanel />)
  const answer = (provider: string, index: number, bucket: string) => {
    const response = responses.get(provider)?.[index]
    if (!response) throw new Error(`Missing ${provider} quota request`)
    response.resolve({
      subscription: {
        provider,
        displayName: provider,
        availability: "available",
        usage: {
          status: "available",
          buckets: [{ name: bucket, usedPercent: 12 }],
        },
      },
    })
  }
  await act(async () => answer("codex", 0, "ChatGPT quota"))
  expect(screen.getByText("ChatGPT quota")).toBeDefined()
  act(() =>
    useAppStore.setState((state) => ({
      execution: {
        ...state.execution,
        lastModel: { provider: "grok", model: "grok-model" },
      },
    })),
  )
  expect(screen.getByText("grok usage limits")).toBeDefined()
  expect(screen.queryByText("ChatGPT quota")).toBeNull()
  expect(screen.getByText("Loading usage limits…")).toBeDefined()
  await waitFor(() => expect(responses.get("grok")).toHaveLength(1))
  await act(async () =>
    responses.get("grok")?.[0]?.reject(new Error("Grok quota unavailable")),
  )
  expect(screen.getByRole("alert").textContent).toBe("Grok quota unavailable")
  expect(screen.queryByText("ChatGPT quota")).toBeNull()
  act(() =>
    useAppStore.setState((state) => ({
      execution: {
        ...state.execution,
        lastModel: { provider: "codex", model: "codex-model" },
      },
    })),
  )
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.getByText("Loading usage limits…")).toBeDefined()
  act(() =>
    useAppStore.setState((state) => ({
      execution: {
        ...state.execution,
        lastModel: { provider: "kimi", model: "kimi-model" },
      },
    })),
  )
  await act(async () => answer("kimi", 0, "Kimi quota"))
  await act(async () => answer("codex", 1, "Stale ChatGPT quota"))
  expect(screen.getByText("kimi usage limits")).toBeDefined()
  expect(screen.getByText("Kimi quota")).toBeDefined()
  expect(screen.queryByText("Stale ChatGPT quota")).toBeNull()
})
