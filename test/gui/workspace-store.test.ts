// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest"

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it("starts each app window closed even when the previous window had an open workspace", async () => {
  const first = await import("../../src/gui/store/workspace-store.ts")
  expect(first.useWorkspaceStore.getState().open).toBe(false)
  first.useWorkspaceStore.getState().setOpen(true)
  expect(first.useWorkspaceStore.getState().open).toBe(true)
  vi.resetModules()
  const next = await import("../../src/gui/store/workspace-store.ts")
  expect(next.useWorkspaceStore.getState().open).toBe(false)
})

it("reuses the current root's subagent tab while keeping other roots separate", async () => {
  const { useWorkspaceStore } = await import(
    "../../src/gui/store/workspace-store.ts"
  )
  useWorkspaceStore.getState().openAgents("root-one", "child-one")
  const first = useWorkspaceStore.getState().activeId
  useWorkspaceStore.getState().openAgents("root-one", "child-two")
  expect(useWorkspaceStore.getState().activeId).toBe(first)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.kind === "agents"),
  ).toHaveLength(1)
  useWorkspaceStore.getState().openAgents("root-two", "child-three")
  expect(useWorkspaceStore.getState().activeId).not.toBe(first)
  useWorkspaceStore.getState().openAgents("root-one")
  expect(
    useWorkspaceStore.getState().tabs.find((tab) => tab.id === first),
  ).not.toHaveProperty("selectedAgentId")
})
