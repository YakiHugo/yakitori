import { describe, expect, it } from "vitest"
import type {
  AgentGraphStore,
  ThreadSpawnEdge,
} from "../../src/core/agent-graph-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { AgentControl } from "../../src/runtime/agent-control.ts"
import { createAgentRuntime } from "../../src/runtime/agent-runtime.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

const TARGET = { provider: "faux", model: "scripted" }

describe("agent V2 recovery invariants", () => {
  it("keeps a queue-only message durable and deduplicated across a restart without starting a turn", async () => {
    const store = new MemoryThreadStore()
    const graphStore = memoryGraphStore()
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "done" }] },
    ])
    const startRuntime = () => {
      const controls = new Map<string, AgentControl>()
      let manager: ThreadManager
      const runtime = createAgentRuntime({
        graphStore,
        getThreadManager: () => manager,
      })
      manager = new ThreadManager({
        store,
        createTurnProcessor(stored) {
          const control = runtime.registerThread(stored)
          controls.set(stored.metadata.id, control)
          return createTurnProcessor({
            stream: provider.stream,
            agentControl: control,
            toolRegistry: createToolRegistry([]),
            loadProjectInstructions: async () => undefined,
          })
        },
      })
      return { runtime, manager, controls }
    }
    const first = startRuntime()
    let second: ReturnType<typeof startRuntime> | undefined
    try {
      const root = await first.manager.createThread({
        workingDirectory: process.cwd(),
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      const control = first.controls.get(root.id)
      if (control === undefined) throw new Error("missing root control")
      const parent = control.bind(root.id, TARGET)
      const child = await parent.spawn({
        taskName: "worker",
        message: "finish",
        agentType: "general",
        forkTurns: "none",
      })
      await parent.wait(1_000)
      const message = {
        target: child.agentId,
        message: "durable information",
        messageId: "queue_message",
      }
      await parent.sendMessage(message)
      expect(provider.callCount).toBe(1)
      const before = await store.readThread(child.agentId)
      expect(
        before?.rollout.filter(({ item }) => item.type === "agent_message"),
      ).toHaveLength(1)
      expect(first.manager.getThread(child.agentId)?.agentStatus).toEqual({
        completed: "done",
      })
      await first.runtime.close()
      await first.manager.shutdown()

      second = startRuntime()
      await second.manager.resumeThread(root.id)
      const restored = second.controls.get(root.id)
      if (restored === undefined)
        throw new Error("missing restored root control")
      await restored.bind(root.id, TARGET).sendMessage(message)
      const after = await store.readThread(child.agentId)
      expect(
        after?.rollout.filter(({ item }) => item.type === "agent_message"),
      ).toHaveLength(1)
      expect(
        after?.rollout.filter(({ item }) => item.type === "turn_started"),
      ).toHaveLength(1)
      expect(
        JSON.stringify(
          second.manager.getThread(child.agentId)?.snapshot().context.history,
        ),
      ).toContain("durable information")
      expect(second.manager.getThread(child.agentId)?.agentStatus).toEqual({
        completed: "done",
      })
      expect(provider.callCount).toBe(1)
    } finally {
      await second?.runtime.close()
      await second?.manager.shutdown()
      await first.runtime.close()
      await first.manager.shutdown()
    }
  })

  it.each([
    "sampled steering",
    "idle task",
    "full capacity",
  ])("replays a follow-up after restart with %s without new execution", async (scenario) => {
    const store = new MemoryThreadStore()
    const graphStore = memoryGraphStore()
    const firstSampling = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const provider = createFauxProvider([
      {
        assertRequest: async () => {
          firstSampling.resolve()
          await releaseFirst.promise
        },
        content: [{ type: "text", text: "initial answer" }],
      },
      { content: [{ type: "text", text: "final answer" }] },
      { waitForAbort: true },
    ])
    const startRuntime = () => {
      const controls = new Map<string, AgentControl>()
      let manager: ThreadManager
      const runtime = createAgentRuntime({
        graphStore,
        maxConcurrentAgents: 2,
        getThreadManager: () => manager,
      })
      manager = new ThreadManager({
        store,
        createTurnProcessor(stored) {
          const control = runtime.registerThread(stored)
          controls.set(stored.metadata.id, control)
          return createTurnProcessor({
            stream: provider.stream,
            agentControl: control,
            toolRegistry: createToolRegistry([]),
            loadProjectInstructions: async () => undefined,
          })
        },
      })
      return { runtime, manager, controls }
    }
    const first = startRuntime()
    let second: ReturnType<typeof startRuntime> | undefined
    try {
      const root = await first.manager.createThread({
        workingDirectory: process.cwd(),
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      const rootControl = first.controls.get(root.id)
      if (rootControl === undefined) throw new Error("missing root control")
      const parent = rootControl.bind(root.id, TARGET)
      const child = await parent.spawn({
        taskName: "worker",
        message: "initial task",
        agentType: "general",
        forkTurns: "none",
      })
      await expect.poll(() => provider.callCount).toBe(1)
      await firstSampling.promise
      const message = {
        target: child.agentId,
        message: "also check recovery",
        messageId: "stable_followup",
      }
      if (scenario === "idle task") {
        releaseFirst.resolve()
        await expect(parent.wait(1_000)).resolves.toMatchObject({
          reason: "status",
        })
      }
      await parent.followup(message)
      releaseFirst.resolve()
      await expect
        .poll(() => first.manager.getThread(child.agentId)?.agentStatus)
        .toEqual({ completed: "final answer" })
      await expect(parent.wait(1_000)).resolves.toMatchObject({
        reason: "status",
      })
      const before = await store.readThread(child.agentId)
      expect(
        before?.rollout.filter(({ item }) => item.type === "turn_started"),
      ).toHaveLength(scenario === "idle task" ? 2 : 1)
      expect(provider.callCount).toBe(2)
      await first.runtime.close()
      await first.manager.shutdown()

      second = startRuntime()
      await second.manager.resumeThread(root.id)
      const secondControl = second.controls.get(root.id)
      if (secondControl === undefined)
        throw new Error("missing restored root control")
      const restoredParent = secondControl.bind(root.id, TARGET)
      await restoredParent.list()
      await restoredParent.wait(1_000)
      if (scenario === "full capacity") {
        await restoredParent.spawn({
          taskName: "blocker",
          message: "hold the slot",
          agentType: "general",
          forkTurns: "none",
        })
        await expect.poll(() => provider.callCount).toBe(3)
      }
      await restoredParent.followup(message)
      await restoredParent.wait(1_000)
      expect(second.manager.getThread(child.agentId)?.agentStatus).toEqual({
        completed: "final answer",
      })
      expect(provider.callCount).toBe(scenario === "full capacity" ? 3 : 2)
      const after = await store.readThread(child.agentId)
      expect(
        after?.rollout.filter(({ item }) => item.type === "turn_started"),
      ).toHaveLength(scenario === "idle task" ? 2 : 1)
    } finally {
      releaseFirst.resolve()
      await second?.runtime.close()
      await second?.manager.shutdown()
      await first.runtime.close()
      await first.manager.shutdown()
    }
  })
})

function memoryGraphStore(): AgentGraphStore {
  const edges = new Map<string, ThreadSpawnEdge>()
  return {
    async upsertThreadSpawnEdge(edge) {
      edges.set(edge.childThreadId, edge)
    },
    async deleteThreadEdges(threadId) {
      for (const [id, edge] of edges) {
        if (edge.parentThreadId === threadId || edge.childThreadId === threadId)
          edges.delete(id)
      }
    },
    async listThreadSpawnChildren(parentThreadId) {
      return [...edges.values()]
        .filter((edge) => edge.parentThreadId === parentThreadId)
        .map((edge) => edge.childThreadId)
    },
    async listThreadSpawnDescendants(rootThreadId) {
      const found: string[] = []
      let parents = [rootThreadId]
      while (parents.length > 0) {
        const children = [...edges.values()]
          .filter((edge) => parents.includes(edge.parentThreadId))
          .map((edge) => edge.childThreadId)
        found.push(...children)
        parents = children
      }
      return found
    },
  }
}
