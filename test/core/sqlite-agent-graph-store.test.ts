import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteAgentGraphStore } from "../../src/core/index.ts"
import { createSessionId } from "../../src/kernel/ids.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe("SqliteAgentGraphStore", () => {
  it("persists descendants in depth and ID order across store instances", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "agent-graph.sqlite")
    const parent = threadId(0)
    const child = threadId(9)
    const sibling = threadId(2)
    const grandchild = threadId(1)
    const first = createSqliteAgentGraphStore({ databasePath })

    await first.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
    })
    await first.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
    })
    await first.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: sibling,
    })
    first.close()

    const resumed = createSqliteAgentGraphStore({ databasePath })
    await expect(resumed.listThreadSpawnDescendants(parent)).resolves.toEqual([
      sibling,
      child,
      grandchild,
    ])
    resumed.close()
  })

  it("preserves existing graph data while appending descendants", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "agent-graph.sqlite")
    const parent = threadId(0)
    const child = threadId(1)
    const grandchild = threadId(2)
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
      ) STRICT;
    `)
    database
      .prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')")
      .run(parent, child)
    database.close()

    const store = createSqliteAgentGraphStore({ databasePath })
    await store.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
    })
    store.close()

    const reopened = createSqliteAgentGraphStore({ databasePath })
    await expect(reopened.listThreadSpawnDescendants(parent)).resolves.toEqual([
      child,
      grandchild,
    ])
    reopened.close()
  })

  it("upserts an existing edge without duplicating it", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
    })

    await expect(store.listThreadSpawnChildren(parent)).resolves.toEqual([
      child,
    ])
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
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: secondParent,
      childThreadId: child,
    })

    await expect(store.listThreadSpawnChildren(firstParent)).resolves.toEqual(
      [],
    )
    await expect(store.listThreadSpawnChildren(secondParent)).resolves.toEqual([
      child,
    ])
    store.close()
  })

  it("rejects reparenting that would create a cycle", async () => {
    const store = createSqliteAgentGraphStore({ databasePath: ":memory:" })
    const parent = createSessionId()
    const child = createSessionId()
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent,
      childThreadId: child,
    })

    await expect(
      store.upsertThreadSpawnEdge({
        parentThreadId: child,
        childThreadId: parent,
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
    })
    await store.upsertThreadSpawnEdge({
      parentThreadId: child,
      childThreadId: grandchild,
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
