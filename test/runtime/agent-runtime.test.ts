import { describe, expect, it } from "vitest"
import type {
  AgentGraphStore,
  ThreadSpawnEdge,
} from "../../src/core/agent-graph-store.ts"
import type { TurnProcessor } from "../../src/core/session.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { AgentControl } from "../../src/runtime/agent-control.ts"
import { createAgentRuntime } from "../../src/runtime/agent-runtime.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const TARGET = { provider: "faux", model: "scripted" }

describe("agent runtime", () => {
  it("rolls back child registration when graph persistence fails", async () => {
    const graph = memoryGraphStore()
    const store = new MemoryThreadStore()
    const controls = new Map<string, AgentControl>()
    let manager: ThreadManager
    const runtime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => manager,
    })
    manager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = runtime.registerThread(stored)
        controls.set(stored.metadata.id, control)
        return immediateProcessor()
      },
    })
    const root = await manager.createThread({
      workingDirectory: "/workspace",
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    const rootControl = controls.get(root.id)
    if (rootControl === undefined) throw new Error("missing root control")
    graph.failNextUpsert()

    await expect(
      rootControl.bind(root.id, TARGET).spawn({
        taskName: "retryable",
        message: "first attempt",
        agentType: "general",
        forkTurns: "none",
      }),
    ).rejects.toThrow("graph write failed")
    const rootAgent = rootControl.bind(root.id, TARGET)
    const spawned = await rootAgent.spawn({
      taskName: "retryable",
      message: "second attempt",
      agentType: "general",
      forkTurns: "none",
    })
    expect(spawned).toMatchObject({ path: "/root/retryable" })
    await rootAgent.wait(1_000)

    await runtime.discardThread(spawned.agentId)
    await expect(
      rootAgent.spawn({
        taskName: "retryable",
        message: "replacement",
        agentType: "general",
        forkTurns: "none",
      }),
    ).resolves.toMatchObject({ path: "/root/retryable" })

    await runtime.close()
    await manager.shutdown()
  })

  it("deduplicates a recovered completion notification after restart", async () => {
    const graph = memoryGraphStore()
    const store = new MemoryThreadStore()
    let firstManager: ThreadManager
    const firstControls = new Map<string, AgentControl>()
    const firstRuntime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => firstManager,
    })
    firstManager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = firstRuntime.registerThread(stored)
        firstControls.set(stored.metadata.id, control)
        return immediateProcessor()
      },
    })
    const root = await firstManager.createThread({
      workingDirectory: "/workspace",
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    const firstControl = firstControls.get(root.id)
    if (firstControl === undefined) throw new Error("missing root control")
    const child = await firstControl.bind(root.id, TARGET).spawn({
      taskName: "completed",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await firstControl.bind(root.id, TARGET).wait(1_000)
    expect(await notificationCount(store, root.id)).toBe(1)
    await firstRuntime.close()
    await firstManager.shutdown()

    let secondManager: ThreadManager
    let secondControl: AgentControl | undefined
    const secondRuntime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => secondManager,
    })
    secondManager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = secondRuntime.registerThread(stored)
        if (stored.metadata.id === root.id) secondControl = control
        return immediateProcessor()
      },
    })
    await secondManager.resumeThread(root.id)
    if (secondControl === undefined) throw new Error("missing restored control")
    await secondControl.bind(root.id, TARGET).list()
    await secondControl.bind(root.id, TARGET).wait(1_000)

    expect(await notificationCount(store, root.id)).toBe(1)
    await expect(secondControl.bind(root.id, TARGET).list()).resolves.toEqual([
      expect.objectContaining({ agentId: child.agentId }),
    ])
    await secondRuntime.close()
    await secondManager.shutdown()
  })

  it("keeps a child provisional until its graph edge commits", async () => {
    const graph = memoryGraphStore()
    const gate = graph.blockNextUpsert()
    graph.failNextUpsert()
    const store = new MemoryThreadStore()
    const controls = new Map<string, AgentControl>()
    let manager: ThreadManager
    const runtime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => manager,
    })
    manager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = runtime.registerThread(stored)
        controls.set(stored.metadata.id, control)
        return immediateProcessor()
      },
    })
    const root = await manager.createThread()
    const control = controls.get(root.id)
    if (control === undefined) throw new Error("missing root control")
    const spawning = control.bind(root.id, TARGET).spawn({
      taskName: "provisional",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    const childId = await gate.entered.promise

    await expect(control.bind(root.id, TARGET).list()).resolves.toEqual([])
    expect(() => control.bind(childId, TARGET)).toThrow("not registered")
    gate.release.resolve()
    await expect(spawning).rejects.toThrow("graph write failed")
    expect(await store.readThread(childId)).toBeUndefined()

    await runtime.close()
    await manager.shutdown()
  })

  it("reconciles a stale edge after graph deletion fails", async () => {
    const graph = memoryGraphStore()
    const store = new MemoryThreadStore()
    const controls = new Map<string, AgentControl>()
    let manager: ThreadManager
    const runtime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => manager,
    })
    manager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = runtime.registerThread(stored)
        controls.set(stored.metadata.id, control)
        return immediateProcessor()
      },
    })
    const root = await manager.createThread()
    const control = controls.get(root.id)
    if (control === undefined) throw new Error("missing root control")
    const child = await control.bind(root.id, TARGET).spawn({
      taskName: "stale",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await control.bind(root.id, TARGET).wait(1_000)
    graph.failNextDelete()

    await expect(runtime.discardThread(child.agentId)).rejects.toThrow(
      "graph delete failed",
    )
    expect(await store.readThread(child.agentId)).toBeUndefined()
    await expect(
      graph.store.listThreadSpawnDescendants(root.id),
    ).resolves.toContain(child.agentId)
    await runtime.discardThread(child.agentId)
    await expect(
      graph.store.listThreadSpawnDescendants(root.id),
    ).resolves.not.toContain(child.agentId)
    await expect(
      control.bind(root.id, TARGET).spawn({
        taskName: "stale",
        message: "replacement",
        agentType: "general",
        forkTurns: "none",
      }),
    ).resolves.toMatchObject({ path: "/root/stale" })

    await runtime.close()
    await manager.shutdown()
  })

  it("keeps a parent reachable when deepest-first subtree deletion fails", async () => {
    const graph = memoryGraphStore()
    const store = new MemoryThreadStore()
    const controls = new Map<string, AgentControl>()
    let manager: ThreadManager
    const runtime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => manager,
    })
    manager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = runtime.registerThread(stored)
        controls.set(stored.metadata.id, control)
        return immediateProcessor()
      },
    })
    const root = await manager.createThread()
    const control = controls.get(root.id)
    if (control === undefined) throw new Error("missing root control")
    const parent = await control.bind(root.id, TARGET).spawn({
      taskName: "parent",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await control.bind(root.id, TARGET).wait(1_000)
    const grandchild = await control.bind(parent.agentId, TARGET).spawn({
      taskName: "grandchild",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await control.bind(parent.agentId, TARGET).wait(1_000)
    store.failNextDeleteThreadId = grandchild.agentId

    await expect(runtime.discardThread(parent.agentId)).rejects.toThrow(
      "thread delete failed",
    )
    expect(await store.readThread(parent.agentId)).toBeDefined()
    expect(await store.readThread(grandchild.agentId)).toBeDefined()
    await expect(
      graph.store.listThreadSpawnDescendants(root.id),
    ).resolves.toEqual([parent.agentId, grandchild.agentId])

    await runtime.discardThread(parent.agentId)
    expect(await store.readThread(parent.agentId)).toBeUndefined()
    expect(await store.readThread(grandchild.agentId)).toBeUndefined()
    await expect(
      graph.store.listThreadSpawnDescendants(root.id),
    ).resolves.toEqual([])

    await runtime.close()
    await manager.shutdown()
  })

  it("reconciles interrupted and pre-graph children after process loss", async () => {
    const graph = memoryGraphStore()
    const store = new MemoryThreadStore()
    let firstManager: ThreadManager
    const firstRuntime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => firstManager,
    })
    firstManager = new ThreadManager({
      store,
      createTurnProcessor: (stored) => {
        firstRuntime.registerThread(stored)
        return immediateProcessor()
      },
    })
    const root = await firstManager.createThread()
    await firstRuntime.close()
    await firstManager.shutdown()

    const interruptedId = await createStoredChild({
      store,
      rootThreadId: root.id,
      taskName: "interrupted",
      path: "/root/interrupted",
      withStartedTurn: true,
    })
    await graph.store.upsertThreadSpawnEdge({
      parentThreadId: root.id,
      childThreadId: interruptedId,
      status: "open",
    })
    const provisionalId = await createStoredChild({
      store,
      rootThreadId: root.id,
      taskName: "provisional",
      path: "/root/provisional",
      withStartedTurn: false,
    })

    let secondManager: ThreadManager
    let control: AgentControl | undefined
    const secondRuntime = createAgentRuntime({
      graphStore: graph.store,
      getThreadManager: () => secondManager,
    })
    secondManager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const registered = secondRuntime.registerThread(stored)
        if (stored.metadata.id === root.id) control = registered
        return immediateProcessor()
      },
    })
    await secondManager.resumeThread(root.id)
    if (control === undefined) throw new Error("missing restored control")
    await expect(control.bind(root.id, TARGET).list()).resolves.toMatchObject([
      { agentId: interruptedId, status: "interrupted" },
      {
        agentId: provisionalId,
        status: {
          errored:
            "Agent spawn was interrupted before its initial task started.",
        },
      },
    ])
    const updates: import("../../src/runtime/agent-control.ts").AgentUpdate[] =
      []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      updates.push(...(await control.bind(root.id, TARGET).wait(250)))
      if (new Set(updates.map((update) => update.agentId)).size === 2) break
    }
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: interruptedId,
          status: "interrupted",
        }),
        expect.objectContaining({
          agentId: provisionalId,
          status: {
            errored:
              "Agent spawn was interrupted before its initial task started.",
          },
        }),
      ]),
    )

    await expect(
      graph.store.listThreadSpawnDescendants(root.id, "open"),
    ).resolves.toEqual([interruptedId, provisionalId].sort())
    const storedRoot = await store.readThread(root.id)
    const notifications =
      storedRoot?.rollout.filter(
        (record) => record.item.type === "agent_message",
      ) ?? []
    const notificationText = notifications
      .flatMap((record) =>
        record.item.type === "agent_message" &&
        record.item.item.item.role === "user"
          ? record.item.item.item.content.map((block) => block.text)
          : [],
      )
      .join("\n")
    expect(notificationText).toContain('status="interrupted"')
    expect(notificationText).toContain(
      "Agent spawn was interrupted before its initial task started.",
    )
    const interruptedNotification = notifications.find(
      (record) =>
        record.item.type === "agent_message" &&
        record.item.item.item.role === "user" &&
        record.item.item.item.content.some((block) =>
          block.text.includes('/root/interrupted"'),
        ),
    )
    expect(
      interruptedNotification?.item.type === "agent_message"
        ? interruptedNotification.item.messageId
        : undefined,
    ).toMatch(/_3$/)

    await secondRuntime.close()
    await secondManager.shutdown()
  })
})

async function createStoredChild(input: {
  readonly store: MemoryThreadStore
  readonly rootThreadId: string
  readonly taskName: string
  readonly path: string
  readonly withStartedTurn: boolean
}): Promise<string> {
  const childId = createSessionId()
  const now = new Date().toISOString()
  await input.store.createThread({
    id: childId,
    conversationId: input.rootThreadId,
    parentThreadId: input.rootThreadId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      agent: {
        version: 1,
        kind: "subagent",
        rootThreadId: input.rootThreadId,
        parentThreadId: input.rootThreadId,
        taskName: input.taskName,
        path: input.path,
        agentType: "general",
        depth: 1,
      },
    },
  })
  if (input.withStartedTurn) {
    await input.store.appendItems(childId, [
      {
        type: "turn_started",
        turnId: "turn_completed_before_loss",
        inputItemId: "input_completed_before_loss",
      },
      {
        type: "turn_completed",
        turnId: "turn_completed_before_loss",
        outcome: "completed",
      },
      {
        type: "turn_started",
        turnId: "turn_interrupted",
        inputItemId: "input_interrupted",
      },
    ])
  }
  await input.store.shutdownThread(childId)
  return childId
}

async function notificationCount(
  store: MemoryThreadStore,
  threadId: string,
): Promise<number> {
  const stored = await store.readThread(threadId)
  return (
    stored?.rollout.filter(
      (record) =>
        record.item.type === "agent_message" &&
        record.item.item.item.role === "user" &&
        record.item.item.item.content.some((block) =>
          block.text.includes("<subagent_notification"),
        ),
    ).length ?? 0
  )
}

function immediateProcessor(): TurnProcessor {
  return {
    prepare(_snapshot, input) {
      return {
        turnId: input.submissionId,
        selection: TARGET,
        configuration: SessionConfiguration.create({
          selection: TARGET,
          workspaceRoot: "/workspace",
          enabledTools: [],
          approvalPolicy: "never",
          promptCacheKey: input.submissionId,
        }).snapshot,
      }
    },
    start() {
      return { completion: Promise.resolve(), abort() {} }
    },
  }
}

function memoryGraphStore(): {
  readonly store: AgentGraphStore
  failNextUpsert(): void
  failNextDelete(): void
  blockNextUpsert(): {
    readonly entered: ReturnType<typeof deferred<string>>
    readonly release: ReturnType<typeof deferred<void>>
  }
} {
  const edges = new Map<string, ThreadSpawnEdge>()
  let shouldFail = false
  let shouldFailDelete = false
  let upsertGate:
    | {
        readonly entered: ReturnType<typeof deferred<string>>
        readonly release: ReturnType<typeof deferred<void>>
      }
    | undefined
  return {
    store: {
      async upsertThreadSpawnEdge(edge) {
        const gate = upsertGate
        upsertGate = undefined
        if (gate !== undefined) {
          gate.entered.resolve(edge.childThreadId)
          await gate.release.promise
        }
        if (shouldFail) {
          shouldFail = false
          throw new Error("graph write failed")
        }
        edges.set(edge.childThreadId, edge)
      },
      async setThreadSpawnEdgeStatus(childThreadId, status) {
        const edge = edges.get(childThreadId)
        if (edge === undefined) return false
        edges.set(childThreadId, { ...edge, status })
        return true
      },
      async deleteThreadEdges(threadId) {
        if (shouldFailDelete) {
          shouldFailDelete = false
          throw new Error("graph delete failed")
        }
        for (const [childThreadId, edge] of edges) {
          if (
            edge.parentThreadId === threadId ||
            edge.childThreadId === threadId
          ) {
            edges.delete(childThreadId)
          }
        }
      },
      async listThreadSpawnChildren(parentThreadId, status) {
        return Array.from(edges.values())
          .filter(
            (edge) =>
              edge.parentThreadId === parentThreadId &&
              (status === undefined || edge.status === status),
          )
          .map((edge) => edge.childThreadId)
          .sort()
      },
      async listThreadSpawnDescendants(rootThreadId, status) {
        const descendants: string[] = []
        let parents = [rootThreadId]
        while (parents.length > 0) {
          const children = Array.from(edges.values())
            .filter(
              (edge) =>
                parents.includes(edge.parentThreadId) &&
                (status === undefined || edge.status === status),
            )
            .map((edge) => edge.childThreadId)
            .sort()
          descendants.push(...children)
          parents = children
        }
        return descendants
      },
    },
    failNextUpsert() {
      shouldFail = true
    },
    failNextDelete() {
      shouldFailDelete = true
    },
    blockNextUpsert() {
      const gate = {
        entered: deferred<string>(),
        release: deferred<void>(),
      }
      upsertGate = gate
      return gate
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}
