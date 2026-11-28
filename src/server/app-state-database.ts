import { statSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import {
  closeSqliteDatabase,
  openReadOnlySqliteDatabase,
  openSqliteDatabase,
} from "../core/sqlite.ts"
import { initializeAgentGraphTables } from "../core/sqlite-agent-graph-store.ts"
import { initializeGoalTables } from "../core/sqlite-goal-store.ts"
import { initializeMateTables } from "../mates/sqlite-mate-store.ts"
import { initializeExternalSessionTables } from "./external-session-service.ts"
import {
  initializeInputQueueTables,
  initializeInputQueueRevisions,
} from "./input-queue.ts"
import { initializeProjectTables } from "./sqlite-project-store.ts"

type LegacyStorePaths = Readonly<{
  rootDir: string
  sessionStoreRoot: string
  mateDatabasePath?: string | undefined
  projectDatabasePath?: string | undefined
}>

// The caller holds the session runtime lock across import and startup. The
// version and copied rows commit together, even if a later source is unreadable.
export function openAppStateDatabase(paths: LegacyStorePaths): DatabaseSync {
  const database = openSqliteDatabase(
    join(paths.sessionStoreRoot, "app-state.sqlite"),
    { profile: "durable" },
  )
  try {
    database.exec("BEGIN IMMEDIATE")
    const version = database.prepare("PRAGMA user_version").get()?.user_version
    if (version === 0) {
      initializeMateTables(database)
      initializeProjectTables(database)
      initializeAgentGraphTables(database)
      initializeGoalTables(database)
      initializeInputQueueTables(database)
      initializeExternalSessionTables(database)

      importLegacyStore(
        database,
        paths.mateDatabasePath ?? join(paths.rootDir, "mates.sqlite"),
        ["mate_events", "mate_summaries"],
      )
      importLegacyStore(
        database,
        paths.projectDatabasePath ?? join(paths.rootDir, "projects.sqlite"),
        ["projects", "project_roots", "project_idempotency_keys"],
      )
      importLegacyStore(
        database,
        join(paths.sessionStoreRoot, "agent-graph.sqlite"),
        ["thread_spawn_edges"],
      )
      importLegacyStore(
        database,
        join(paths.sessionStoreRoot, "thread-goals.sqlite"),
        ["thread_goals", "goal_usage_receipts", "goal_continuation_deferrals"],
      )
      importLegacyStore(
        database,
        join(paths.sessionStoreRoot, "input-queue.sqlite"),
        ["input_queue", "input_queue_revisions"],
      )
      importLegacyStore(
        database,
        join(paths.rootDir, "external-sessions.sqlite"),
        ["external_sessions", "external_events", "external_requests"],
      )
      // Queue mutations normally advance per-session revisions. Install those
      // triggers after restoring the exact saved revisions and pending inputs.
      initializeInputQueueRevisions(database)
      database.exec("PRAGMA user_version = 1")
    } else if (version !== 1) {
      throw new Error(`Unsupported app-state.sqlite schema version: ${version}`)
    }
    database.exec("COMMIT")
    return database
  } catch (error) {
    // Closing also rolls back the entire pending import.
    closeSqliteDatabase(database)
    throw error
  }
}

function importLegacyStore(
  database: DatabaseSync,
  path: string,
  tables: string[],
): void {
  if (
    path === ":memory:" ||
    statSync(path, { throwIfNoEntry: false }) === undefined
  )
    return
  const source = openReadOnlySqliteDatabase(path)
  try {
    // A single snapshot includes WAL commits and keeps receipts/children in
    // step with their parents. Stream rows without materializing whole stores.
    source.exec("BEGIN")
    for (const table of tables) {
      const read = source.prepare(`SELECT * FROM ${table}`)
      read.setReadBigInts(true)
      const columns = read
        .columns()
        .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
      const insert = database.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      for (const row of read.iterate()) insert.run(...Object.values(row))
      if (table === "input_queue_revisions") {
        const sequence = source.prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = ?",
        )
        sequence.setReadBigInts(true)
        const highWaterMark = sequence.get(table)?.seq
        if (highWaterMark !== undefined) {
          database
            .prepare("DELETE FROM sqlite_sequence WHERE name = ?")
            .run(table)
          database
            .prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)")
            .run(table, highWaterMark)
        }
      }
    }
  } catch (cause) {
    throw new Error(`Failed to import legacy state from ${path}`, { cause })
  } finally {
    closeSqliteDatabase(source)
  }
}
