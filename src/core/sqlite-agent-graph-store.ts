import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isGeneratedSessionId } from "../kernel/ids.ts"
import type { AgentGraphStore, ThreadSpawnEdge } from "./agent-graph-store.ts"

export type SqliteAgentGraphStore = AgentGraphStore &
  Readonly<{ close(): void }>

export type SqliteAgentGraphStoreOptions = Readonly<{
  databasePath?: string
  rootDir?: string
}>

type ChildRow = { readonly child_thread_id: string }

export function createSqliteAgentGraphStore(
  options: SqliteAgentGraphStoreOptions = {},
): SqliteAgentGraphStore {
  const databasePath =
    options.databasePath ??
    join(options.rootDir ?? ".yakitori", "agent-graph.sqlite")
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true })
  }
  const database = new DatabaseSync(databasePath)
  initializeDatabase(database)

  return {
    async upsertThreadSpawnEdge(edge) {
      requireEdge(edge)
      database.exec("BEGIN IMMEDIATE")
      try {
        const createsCycle = database
          .prepare(`
            WITH RECURSIVE descendants(child_thread_id) AS (
              SELECT child_thread_id
              FROM thread_spawn_edges
              WHERE parent_thread_id = ?
              UNION
              SELECT edge.child_thread_id
              FROM thread_spawn_edges AS edge
              JOIN descendants
                ON edge.parent_thread_id = descendants.child_thread_id
            )
            SELECT 1 AS found
            FROM descendants
            WHERE child_thread_id = ?
            LIMIT 1
          `)
          .get(edge.childThreadId, edge.parentThreadId)
        if (createsCycle !== undefined) {
          throw new Error(
            `Thread spawn edge ${edge.parentThreadId} -> ${edge.childThreadId} would create a cycle.`,
          )
        }
        database
          .prepare(`
            INSERT INTO thread_spawn_edges (
              parent_thread_id,
              child_thread_id,
              status
            ) VALUES (?, ?, 'open')
            ON CONFLICT (child_thread_id)
            DO UPDATE SET
              parent_thread_id = excluded.parent_thread_id
          `)
          .run(edge.parentThreadId, edge.childThreadId)
        database.exec("COMMIT")
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    },

    async deleteThreadEdges(threadId) {
      requireThreadId(threadId, "threadId")
      database
        .prepare(`
          DELETE FROM thread_spawn_edges
          WHERE parent_thread_id = ? OR child_thread_id = ?
        `)
        .run(threadId, threadId)
    },

    async listThreadSpawnChildren(parentThreadId) {
      requireThreadId(parentThreadId, "parentThreadId")
      const rows = database
        .prepare(`
          SELECT child_thread_id
          FROM thread_spawn_edges
          WHERE parent_thread_id = ?
          ORDER BY child_thread_id
        `)
        .all(parentThreadId) as ChildRow[]
      return rows.map((row) => row.child_thread_id)
    },

    async listThreadSpawnDescendants(rootThreadId) {
      requireThreadId(rootThreadId, "rootThreadId")
      const rows = database
        .prepare(`
          WITH RECURSIVE descendants(child_thread_id, depth) AS (
            SELECT child_thread_id, 1
            FROM thread_spawn_edges
            WHERE parent_thread_id = ?
            UNION
            SELECT edge.child_thread_id, descendants.depth + 1
            FROM thread_spawn_edges AS edge
            JOIN descendants
              ON edge.parent_thread_id = descendants.child_thread_id
          )
          SELECT child_thread_id
          FROM descendants
          ORDER BY depth, child_thread_id
        `)
        .all(rootThreadId) as ChildRow[]
      return rows.map((row) => row.child_thread_id)
    },

    close() {
      if (database.isOpen) database.close()
    },
  }
}

function initializeDatabase(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = FULL")
    database.exec("PRAGMA busy_timeout = 5000")
    // Existing graph databases require this non-null column without a default.
    // Keep its physical shape and insert a constant; graph ownership is edge
    // existence, with no status transitions or filtering.
    database.exec(`
      CREATE TABLE IF NOT EXISTS thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        PRIMARY KEY (child_thread_id),
        CHECK (parent_thread_id <> child_thread_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS thread_spawn_edges_parent_status
      ON thread_spawn_edges (parent_thread_id, status);
    `)
    const enableDefensive = Reflect.get(database, "enableDefensive")
    if (typeof enableDefensive === "function") {
      Reflect.apply(enableDefensive, database, [true])
    }
  } catch (error) {
    if (database.isOpen) database.close()
    throw error
  }
}

function requireEdge(edge: ThreadSpawnEdge): void {
  requireThreadId(edge.parentThreadId, "parentThreadId")
  requireThreadId(edge.childThreadId, "childThreadId")
  if (edge.parentThreadId === edge.childThreadId) {
    throw new Error("A Thread cannot be its own child.")
  }
}

function requireThreadId(value: string, name: string): void {
  if (!isGeneratedSessionId(value)) {
    throw new Error(`${name} must be a generated Session id.`)
  }
}
