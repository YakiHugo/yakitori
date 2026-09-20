// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useSessionAgents } from "../../src/gui/hooks/use-session-agents.ts"
import type { ApiListAgentsResponse } from "../../src/server/protocol.ts"

const rpc = vi.hoisted(() => ({
  request: vi.fn(),
  activity: undefined as (() => void) | undefined,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request: rpc.request,
    subscribeToSessionActivity: (listener: () => void) => {
      rpc.activity = listener
      return () => {
        rpc.activity = undefined
      }
    },
    subscribeToSidebarChanges: () => () => {},
  }),
}))
beforeEach(() => {
  rpc.request.mockReset()
  rpc.activity = undefined
})
afterEach(cleanup)

const child = {
  agentId: "child-review",
  taskName: "review",
  path: "/root/review",
  status: "running" as const,
}

it("refreshes live child status, retains the last list on errors, and allows retry", async () => {
  rpc.request.mockResolvedValue({ agents: [child] })
  const hook = renderHook(() =>
    useSessionAgents("http://api.test", "root", true),
  )
  await waitFor(() => expect(hook.result.current.agents).toEqual([child]))
  rpc.request.mockRejectedValueOnce(new Error("Disconnected"))
  act(() => rpc.activity?.())
  await waitFor(() => expect(hook.result.current.error).toBe("Disconnected"))
  expect(hook.result.current.agents).toEqual([child])
  rpc.request.mockResolvedValue({
    agents: [{ ...child, status: { completed: "Reviewed" } }],
  })
  act(() => hook.result.current.refresh())
  await waitFor(() =>
    expect(hook.result.current.agents[0]?.status).toEqual({
      completed: "Reviewed",
    }),
  )
  expect(hook.result.current.error).toBeUndefined()
  hook.unmount()
  expect(rpc.activity).toBeUndefined()
})

it("ignores a previous root's slow list response and does not fetch while hidden", async () => {
  let resolveOld!: (value: ApiListAgentsResponse) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise<ApiListAgentsResponse>((resolve) => {
        resolveOld = resolve
      }),
  )
  const hook = renderHook(
    ({ root, active }) => useSessionAgents("http://api.test", root, active),
    { initialProps: { root: "first", active: true } },
  )
  rpc.request.mockResolvedValue({ agents: [] })
  hook.rerender({ root: "second", active: true })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  await act(async () => resolveOld({ agents: [child] }))
  expect(hook.result.current.agents).toEqual([])
  hook.rerender({ root: "second", active: false })
  rpc.request.mockClear()
  act(() => window.dispatchEvent(new Event("focus")))
  expect(rpc.request).not.toHaveBeenCalled()
})
