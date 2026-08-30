import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createSqliteAgentGraphStore,
  ThreadSpawnEdgeStatus,
} from "../../src/core/index.ts"
import { createSessionId } from "../../src/kernel/ids.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("SqliteAgentGraphStore", () => {
  it("persists open descendants across store instances", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "agent-graph.sqlite")
    const parent = threadId(0)
    const child = threadId(9)
    const grandchild = threadId(1)
    const first = createSqliteAgentGraphStore({ databasePath })

    await first.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })
    await first.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
      status: ThreadSpawnEdgeStatus.Open,
    })
    first.close()

    const resumed = createSqliteAgentGraphStore({ databasePath })
    await expect(
      resumed.listThreadSpawnDescendants(
        parent,
        ThreadSpawnEdgeStatus.Open,
      ),
    ).resolves.toEqual([child, grandchild])
    resumed.close()
  })

  it("excludes a closed branch from open descendant traversal", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    const grandchild = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
      status: ThreadSpawnEdgeStatus.Open,
    })

    await expect(
      store.setThreadSpawnEdgeStatus(
        child,
        ThreadSpawnEdgeStatus.Closed,
      ),
    ).resolves.toBe(true)
    await expect(
      store.listThreadSpawnDescendants(
        parent,
        ThreadSpawnEdgeStatus.Open,
      ),
    ).resolves.toEqual([])
    await expect(store.listThreadSpawnDescendants(parent)).resolves.toEqual(
      [child, grandchild],
    )
    store.close()
  })

  it("upserts an existing edge without duplicating it", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Closed,
    })

    await expect(store.listThreadSpawnChildren(parent)).resolves.toEqual([
      child,
    ])
    await expect(
      store.listThreadSpawnChildren(parent, ThreadSpawnEdgeStatus.Open),
    ).resolves.toEqual([])
    store.close()
  })

  it("moves a child to its single new parent on upsert", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const firstParent = createSessionId()
    const secondParent = createSessionId()
    const child = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: firstParent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: secondParent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })

    await expect(store.listThreadSpawnChildren(firstParent)).resolves.toEqual(
      [],
    )
    await expect(store.listThreadSpawnChildren(secondParent)).resolves.toEqual(
      [child],
    )
    store.close()
  })

  it("rejects reparenting that would create a cycle", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })

    await expect(
      store.upsertThreadSpawnEdge({
        parentThreadId: child,
        childThreadId: parent,
        status: ThreadSpawnEdgeStatus.Open,
      }),
    ).rejects.toThrow("would create a cycle")
    await expect(store.listThreadSpawnChildren(parent)).resolves.toEqual([
      child,
    ])
    await expect(store.listThreadSpawnChildren(child)).resolves.toEqual([])
    store.close()
  })

  it("deletes incoming and outgoing edges for a removed Thread", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    const grandchild = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
      status: ThreadSpawnEdgeStatus.Open,
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
      status: ThreadSpawnEdgeStatus.Open,
    })

    await store.deleteThreadEdges(child)

    await expect(store.listThreadSpawnChildren(parent)).resolves.toEqual([])
    await expect(store.listThreadSpawnChildren(child)).resolves.toEqual([])
    store.close()
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-agent-graph-"))
  roots.push(root)
  return root
}

function threadId(suffix: number): string {
  return `session_00000000-0000-0000-0000-${suffix.toString().padStart(12, "0")}`
}
