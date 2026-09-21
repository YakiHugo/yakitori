import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { StoredThread } from "./rollout.ts"
import type { ThreadSearchProjectionStamp } from "./sqlite-thread-search-projection.ts"

export type ThreadUsageProjectionStamp = ThreadSearchProjectionStamp

export type UsageTokenTotals = Readonly<{
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
}>

export type ThreadUsageSummary = Readonly<{
  totals: UsageTokenTotals & Readonly<{ turns: number }>
  days: readonly (UsageTokenTotals &
    Readonly<{ date: string; turns: number }>)[]
  threads: readonly (UsageTokenTotals &
    Readonly<{
      threadId: string
      title: string
      updatedAt: string
      turns: number
      totalTokens: number
    }>)[]
}>

type StampRow = Readonly<{
  metadata_size: number
  metadata_mtime_ms: number
  rollout_size: number
  rollout_mtime_ms: number
}>

const schemaVersion = 1

// Disposable SQLite materialization of per-turn token usage. The rollout
// remains authoritative; stamps let readers rebuild only stale projections.
export class SqliteThreadUsageProjection {
  readonly #database: DatabaseSync

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    this.#database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      enableDoubleQuotedStringLiterals: false,
    })
    initializeDatabase(this.#database)
  }

  indexedThreadIds(): readonly string[] {
    const rows = this.#database
      .prepare("SELECT thread_id FROM usage_threads")
      .all() as unknown as ReadonlyArray<Readonly<{ thread_id: string }>>
    return rows.map((row) => row.thread_id)
  }

  isCurrent(threadId: string, stamp: ThreadUsageProjectionStamp): boolean {
    const row = this.#database
      .prepare(`
        SELECT metadata_size, metadata_mtime_ms, rollout_size, rollout_mtime_ms
        FROM usage_threads
        WHERE thread_id = ?
      `)
      .get(threadId) as StampRow | undefined
    return (
      row?.metadata_size === stamp.metadataSize &&
      row?.metadata_mtime_ms === stamp.metadataMtimeMs &&
      row?.rollout_size === stamp.rolloutSize &&
      row?.rollout_mtime_ms === stamp.rolloutMtimeMs
    )
  }

  rebuild(stored: StoredThread, stamp: ThreadUsageProjectionStamp): void {
    this.#database.exec("BEGIN")
    try {
      this.#database
        .prepare("DELETE FROM usage_threads WHERE thread_id = ?")
        .run(stored.metadata.id)
      this.#database
        .prepare(`
          INSERT INTO usage_threads (
            thread_id, title, updated_at,
            metadata_size, metadata_mtime_ms, rollout_size, rollout_mtime_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          stored.metadata.id,
          stored.metadata.title ?? "",
          stored.metadata.updatedAt,
          stamp.metadataSize,
          stamp.metadataMtimeMs,
          stamp.rolloutSize,
          stamp.rolloutMtimeMs,
        )
      const insertTurn = this.#database.prepare(`
        INSERT OR REPLACE INTO usage_turns (
          thread_id, turn_id, occurred_at, provider, model,
          input_tokens, output_tokens,
          cache_read_input_tokens, cache_write_input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const turnModels = new Map<string, { provider: string; model: string }>()
      for (const record of stored.rollout) {
        const item = record.item
        if (item.type === "turn_context") {
          turnModels.set(item.context.turnId, {
            provider: item.context.selection.provider,
            model: item.context.selection.model,
          })
          continue
        }
        if (item.type !== "turn_completed" || item.usage === undefined) continue
        const target = turnModels.get(item.turnId)
        insertTurn.run(
          stored.metadata.id,
          item.turnId,
          record.createdAt,
          target?.provider ?? "",
          target?.model ?? "",
          item.usage.inputTokens,
          item.usage.outputTokens,
          item.usage.cacheReadInputTokens ?? 0,
          item.usage.cacheWriteInputTokens ?? 0,
        )
      }
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  delete(threadId: string): void {
    this.#database
      .prepare("DELETE FROM usage_threads WHERE thread_id = ?")
      .run(threadId)
  }

  readUsage(input?: { days?: number; threads?: number }): ThreadUsageSummary {
    const dayCount = input?.days ?? 30
    const threadCount = input?.threads ?? 20
    const totals = this.#database
      .prepare(`
        SELECT COUNT(*) AS turns,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_input_tokens) AS cache_read_input_tokens,
               SUM(cache_write_input_tokens) AS cache_write_input_tokens
        FROM usage_turns
      `)
      .get() as unknown as TotalsRow
    const days = (
      this.#database
        .prepare(`
          SELECT substr(occurred_at, 1, 10) AS date,
                 COUNT(*) AS turns,
                 SUM(input_tokens) AS input_tokens,
                 SUM(output_tokens) AS output_tokens,
                 SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                 SUM(cache_write_input_tokens) AS cache_write_input_tokens
          FROM usage_turns
          GROUP BY date
          ORDER BY date DESC
          LIMIT ?
        `)
        .all(dayCount) as unknown as DayRow[]
    ).reverse()
    const threads = this.#database
      .prepare(`
        SELECT t.thread_id, t.title, t.updated_at,
               COUNT(*) AS turns,
               SUM(u.input_tokens) AS input_tokens,
               SUM(u.output_tokens) AS output_tokens,
               SUM(u.cache_read_input_tokens) AS cache_read_input_tokens,
               SUM(u.cache_write_input_tokens) AS cache_write_input_tokens,
               SUM(u.input_tokens + u.output_tokens) AS total_tokens
        FROM usage_turns u
        JOIN usage_threads t ON t.thread_id = u.thread_id
        GROUP BY t.thread_id
        ORDER BY total_tokens DESC, t.updated_at DESC
        LIMIT ?
      `)
      .all(threadCount) as unknown as ThreadRow[]
    return {
      totals: totalsFromRow(totals),
      days: days.map((row) => ({
        date: row.date,
        ...totalsFromRow(row),
      })),
      threads: threads.map((row) => ({
        threadId: row.thread_id,
        title: row.title,
        updatedAt: row.updated_at,
        totalTokens: row.total_tokens ?? 0,
        ...totalsFromRow(row),
      })),
    }
  }
}

type TotalsRow = Readonly<{
  turns: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_input_tokens: number | null
  cache_write_input_tokens: number | null
}>

type DayRow = TotalsRow & Readonly<{ date: string }>

type ThreadRow = TotalsRow &
  Readonly<{
    thread_id: string
    title: string
    updated_at: string
    total_tokens: number | null
  }>

function totalsFromRow(row: TotalsRow) {
  return {
    turns: row.turns ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: row.cache_write_input_tokens ?? 0,
  }
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("PRAGMA synchronous = FULL")
  database.exec("PRAGMA foreign_keys = ON")
  const version = database.prepare("PRAGMA user_version").get() as
    | Readonly<{ user_version: number }>
    | undefined
  if ((version?.user_version ?? 0) !== schemaVersion) {
    database.exec(`
      DROP TABLE IF EXISTS usage_turns;
      DROP TABLE IF EXISTS usage_threads;
    `)
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_threads (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_size INTEGER NOT NULL,
      metadata_mtime_ms REAL NOT NULL,
      rollout_size INTEGER NOT NULL,
      rollout_mtime_ms REAL NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS usage_turns (
      thread_id TEXT NOT NULL REFERENCES usage_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS usage_turns_date
    ON usage_turns (occurred_at);

    PRAGMA user_version = ${schemaVersion};
  `)
}
