// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useSessionAgents } from "../../src/gui/hooks/use-session-agents.ts"
import type { AppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import { getAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import type { ApiListAgentsResponse } from "../../src/server/protocol.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: vi.fn(),
}))

const child = {
  agentId: "child",
  taskName: "review",
  path: "/root/review",
  status: "running" as const,
}
function deferredAgents() {
  let resolve!: (response: ApiListAgentsResponse) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ApiListAgentsResponse>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

let rpc: FakeRpcClient
beforeEach(() => {
  rpc = new FakeRpcClient()
  vi.mocked(getAppRpcClient).mockReturnValue(rpc as unknown as AppRpcClient)
})
afterEach(cleanup)

it("a newer same-root snapshot survives a late error from the preceding refresh", async () => {
  const first = deferredAgents()
  const second = deferredAgents()
  let call = 0
  rpc.respond = () => (++call === 1 ? first.promise : second.promise)
  const { result } = renderHook(() =>
    useSessionAgents("http://api.test", "root", true),
  )
  act(() => rpc.emitSessionActivity(undefined))
  await act(async () => second.resolve({ agents: [child] }))
  expect(result.current.agents).toEqual([child])
  await act(async () => first.reject(new Error("Old refresh failed")))
  expect(result.current.agents).toEqual([child])
  expect(result.current.error).toBeUndefined()
  expect(result.current.loading).toBe(false)
})

it("changing the API owner hides old children and rejects the previous owner's slow result", async () => {
  const oldRequest = deferredAgents()
  rpc.respond = () => oldRequest.promise
  const next = new FakeRpcClient()
  next.respond = () => ({ agents: [] })
  vi.mocked(getAppRpcClient).mockImplementation(
    (apiBase) =>
      (apiBase === "http://first.test" ? rpc : next) as unknown as AppRpcClient,
  )
  const { result, rerender } = renderHook(
    ({ apiBase }) => useSessionAgents(apiBase, "same-root", true),
    { initialProps: { apiBase: "http://first.test" } },
  )
  rerender({ apiBase: "http://second.test" })
  expect(result.current.agents).toEqual([])
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => oldRequest.resolve({ agents: [child] }))
  expect(result.current.agents).toEqual([])
  expect(rpc.sessionActivityListeners.size).toBe(0)
  expect(rpc.sidebarChangeListeners.size).toBe(0)
})

it("hiding a list stops invalidation listeners without closing the shared RPC client", async () => {
  const hiddenRequest = deferredAgents()
  rpc.respond = () => hiddenRequest.promise
  const close = vi.spyOn(rpc, "close")
  const { result, rerender, unmount } = renderHook(
    ({ enabled }) => useSessionAgents("http://api.test", "root", enabled),
    { initialProps: { enabled: true } },
  )
  rerender({ enabled: false })
  await act(async () => hiddenRequest.resolve({ agents: [child] }))
  expect(result.current.agents).toEqual([])
  expect(rpc.sessionActivityListeners.size).toBe(0)
  expect(rpc.sidebarChangeListeners.size).toBe(0)
  act(() => {
    window.dispatchEvent(new Event("focus"))
    rpc.emitSessionActivity(undefined)
  })
  expect(rpc.requestsFor("agent/list")).toHaveLength(1)
  rpc.respond = () => ({ agents: [child] })
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.agents).toEqual([child]))
  expect(rpc.requestsFor("agent/list")).toHaveLength(2)
  unmount()
  expect(close).not.toHaveBeenCalled()
  expect(rpc.sessionActivityListeners.size).toBe(0)
  expect(rpc.sidebarChangeListeners.size).toBe(0)
})
