import type { DatabaseSync } from "node:sqlite"
import { connectStateStore } from "./sqlite.ts"
import { isGeneratedSessionId } from "../kernel/ids.ts"
import type { AgentGraphStore, ThreadSpawnEdge } from "./agent-graph-store.ts"

export type SqliteAgentGraphStore = AgentGraphStore &
  Readonly<{ close(): void }>

type ChildRow = { readonly child_thread_id: string }

export function createSqliteAgentGraphStore(
  source: string | DatabaseSync,
): SqliteAgentGraphStore {
  const { database, close } = connectStateStore(
    source,
    initializeAgentGraphTables,
  )

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

    close,
  }
}

export function initializeAgentGraphTables(database: DatabaseSync): void {
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
