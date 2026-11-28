import type { DatabaseSync } from "node:sqlite"
import { closeSqliteDatabase, openSqliteDatabase } from "./sqlite.ts"
import type { RolloutRecordLocation } from "./display-window.ts"
import type {
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadStatusProjection,
  ThreadSummary,
} from "./rollout.ts"
import { advanceThreadStatus } from "./thread-status.ts"

export type RolloutProjectionStamp = Readonly<{
  metadataSize: number
  metadataMtimeMs: number
  rolloutSize: number
  rolloutMtimeMs: number
}>

type StampRow = Readonly<{
  metadata_size: number
  metadata_mtime_ms: number
  rollout_size: number
  rollout_mtime_ms: number
}>

export type ProjectedThreadRow = Readonly<{
  thread_id: string
  metadata_json: string
  seq: number
  title: string
  status_json: string
}>

export class ThreadProjectionChangedError extends Error {
  constructor() {
    super("Thread projection advanced while its rollout was being read.")
  }
}

// Called inside the shared projection transaction: another store instance can
// finish repair/revert while this reader awaits filesystem I/O.
function requireProjectionAppend(
  database: DatabaseSync,
  metadata: ThreadMetadata,
  entries: readonly StoredRolloutItem[],
  checkpoint?: RolloutCheckpoint,
): void {
  const row = database
    .prepare("SELECT metadata_json FROM projection_threads WHERE thread_id = ?")
    .get(metadata.id) as Readonly<{ metadata_json: string }> | undefined
  if (
    row === undefined ||
    (JSON.parse(row.metadata_json) as ThreadMetadata).rolloutId !==
      metadata.rolloutId
  )
    throw new ThreadProjectionChangedError()
  const current = readCheckpoint(
    database,
    metadata.id,
    checkpoint?.rolloutId ?? metadata.rolloutId,
  )
  const first = entries.find(({ item }) => item.type !== "session_meta")
  if (
    current === undefined &&
    checkpoint !== undefined &&
    checkpoint.endByteOffset > 0 &&
    !entries.some(({ item }) => item.type === "session_meta")
  )
    throw new ThreadProjectionChangedError()
  if (
    current !== undefined &&
    ((checkpoint !== undefined &&
      checkpoint.endByteOffset < current.endByteOffset) ||
      (first !== undefined && first.seq !== current.nextSeq))
  )
    throw new ThreadProjectionChangedError()
}

export type RolloutCheckpoint = Readonly<{
  rolloutId: string
  endByteOffset: number
  nextSeq: number
}>

// Each derived database commits its rows and physical checkpoint together.
export abstract class SqliteRolloutProjection {
  protected readonly database: DatabaseSync

  constructor(
    databasePath: string,
    schemaVersion: number,
    dropDerivedTables: (database: DatabaseSync) => void,
    createDerivedTables: (database: DatabaseSync) => void,
  ) {
    this.database = openSqliteDatabase(databasePath, { profile: "projection" })
    try {
      this.#transaction(() => {
        const { user_version: version } = this.database
          .prepare("PRAGMA user_version")
          .get() as { user_version: number }
        if (version !== schemaVersion) {
          dropDerivedTables(this.database)
          this.database.exec(`
          DROP TABLE IF EXISTS rollout_checkpoints;
          DROP TABLE IF EXISTS projection_threads;
        `)
        }
        this.database.exec(`
    CREATE TABLE IF NOT EXISTS projection_threads (
      thread_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      status_json TEXT NOT NULL DEFAULT '{}',
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      metadata_size INTEGER NOT NULL,
      metadata_mtime_ms REAL NOT NULL,
      rollout_size INTEGER NOT NULL,
      rollout_mtime_ms REAL NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rollout_checkpoints (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      rollout_id TEXT NOT NULL,
      end_byte_offset INTEGER NOT NULL,
      next_seq INTEGER NOT NULL,
      PRIMARY KEY (thread_id, rollout_id)
    ) STRICT;
        PRAGMA user_version = ${schemaVersion};
      `)
        createDerivedTables(this.database)
      })
    } catch (error) {
      closeSqliteDatabase(this.database)
      throw error
    }
  }

  close(): void {
    closeSqliteDatabase(this.database)
  }

  protected abstract applyEntries(
    threadId: string,
    entries: readonly StoredRolloutItem[],
    locations: ReadonlyMap<number, RolloutRecordLocation> | undefined,
    previous: ThreadStatusProjection,
  ): void

  #apply(
    threadId: string,
    entries: readonly StoredRolloutItem[],
    locations?: ReadonlyMap<number, RolloutRecordLocation>,
  ): void {
    if (entries.length === 0) return
    const row = this.database
      .prepare("SELECT status_json FROM projection_threads WHERE thread_id = ?")
      .get(threadId) as { status_json: string }
    const status = JSON.parse(row.status_json) as ThreadStatusProjection
    this.database
      .prepare(
        "UPDATE projection_threads SET status_json = ? WHERE thread_id = ?",
      )
      .run(JSON.stringify(advanceThreadStatus(status, entries)), threadId)
    this.applyEntries(threadId, entries, locations, status)
  }

  indexedThreadIds(): readonly string[] {
    const rows = this.database
      .prepare("SELECT thread_id FROM projection_threads")
      .all() as unknown as ReadonlyArray<Readonly<{ thread_id: string }>>
    return rows.map((row) => row.thread_id)
  }

  isCurrent(threadId: string, stamp: RolloutProjectionStamp): boolean {
    const row = this.database
      .prepare(`
        SELECT metadata_size, metadata_mtime_ms, rollout_size, rollout_mtime_ms
        FROM projection_threads
        WHERE thread_id = ?
      `)
      .get(threadId) as StampRow | undefined
    return (
      row?.metadata_size === stamp.metadataSize &&
      row.metadata_mtime_ms === stamp.metadataMtimeMs &&
      row.rollout_size === stamp.rolloutSize &&
      row.rollout_mtime_ms === stamp.rolloutMtimeMs
    )
  }

  hasSameSizeRewrite(threadId: string, stamp: RolloutProjectionStamp): boolean {
    const row = this.database
      .prepare(`
        SELECT rollout_size, rollout_mtime_ms FROM projection_threads
        WHERE thread_id = ?
      `)
      .get(threadId) as
      | Pick<StampRow, "rollout_size" | "rollout_mtime_ms">
      | undefined
    // Append checkpoints cannot validate a file rewritten in place. This
    // also catches changed fork headers that occupy the same byte range.
    return (
      row?.rollout_size === stamp.rolloutSize &&
      row.rollout_mtime_ms !== stamp.rolloutMtimeMs
    )
  }

  readSummary(threadId: string): ThreadSummary | undefined {
    const row = this.database
      .prepare(
        "SELECT thread_id, metadata_json, seq, title, status_json FROM projection_threads WHERE thread_id = ?",
      )
      .get(threadId) as ProjectedThreadRow | undefined
    return row === undefined ? undefined : projectedThreadSummary(row)
  }

  checkpoint(
    threadId: string,
    rolloutId: string,
  ): RolloutCheckpoint | undefined {
    return readCheckpoint(this.database, threadId, rolloutId)
  }

  begin(metadata: ThreadMetadata): void {
    this.#transaction(() => {
      this.database
        .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
        .run(metadata.id)
      insertThread(this.database, metadata, 0, {
        metadataSize: -1,
        metadataMtimeMs: -1,
        rolloutSize: -1,
        rolloutMtimeMs: -1,
      })
    })
  }

  rebuild(
    stored: StoredThread,
    stamp: RolloutProjectionStamp,
    locations?: ReadonlyMap<number, RolloutRecordLocation>,
  ): void {
    this.#transaction(() => {
      this.database
        .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
        .run(stored.metadata.id)
      insertThread(
        this.database,
        stored.metadata,
        stored.rollout.filter(({ item }) => item.type !== "session_meta")
          .length,
        stamp,
      )
      this.#apply(stored.metadata.id, stored.rollout, locations)
      writeCheckpoint(this.database, stored.metadata.id, {
        rolloutId: stored.metadata.rolloutId,
        endByteOffset: stamp.rolloutSize,
        nextSeq: (stored.rollout.at(-1)?.seq ?? 0) + 1,
      })
    })
  }

  append(
    metadata: ThreadMetadata,
    entries: readonly StoredRolloutItem[],
    stamp: RolloutProjectionStamp,
    checkpoint?: RolloutCheckpoint,
    locations?: ReadonlyMap<number, RolloutRecordLocation>,
  ): void {
    this.#transaction(() => {
      requireProjectionAppend(this.database, metadata, entries, checkpoint)
      const result = this.database
        .prepare(`
          UPDATE projection_threads
          SET metadata_json = ?,
              title = ?,
              updated_at = ?,
              seq = seq + ?,
              metadata_size = ?,
              metadata_mtime_ms = ?,
              rollout_size = ?,
              rollout_mtime_ms = ?
          WHERE thread_id = ?
        `)
        .run(
          JSON.stringify(metadata),
          metadata.title ?? "",
          metadata.updatedAt,
          entries.filter(({ item }) => item.type !== "session_meta").length,
          stamp.metadataSize,
          stamp.metadataMtimeMs,
          stamp.rolloutSize,
          stamp.rolloutMtimeMs,
          metadata.id,
        )
      if (result.changes !== 1) {
        throw new Error(`Thread ${metadata.id} has no rollout projection.`)
      }
      this.#apply(metadata.id, entries, locations)
      writeCheckpoint(
        this.database,
        metadata.id,
        checkpoint ?? {
          rolloutId: metadata.rolloutId,
          endByteOffset: stamp.rolloutSize,
          nextSeq:
            (entries.at(-1)?.seq ?? this.readSummary(metadata.id)?.seq ?? 0) +
            1,
        },
      )
    })
  }

  delete(threadId: string): void {
    this.database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(threadId)
  }

  #transaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      operation()
      this.database.exec("COMMIT")
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK")
      throw error
    }
  }
}

function writeCheckpoint(
  database: DatabaseSync,
  threadId: string,
  checkpoint: RolloutCheckpoint,
): void {
  database
    .prepare(`
      INSERT INTO rollout_checkpoints
        (thread_id, rollout_id, end_byte_offset, next_seq)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (thread_id, rollout_id) DO UPDATE SET
        end_byte_offset = excluded.end_byte_offset,
        next_seq = excluded.next_seq
    `)
    .run(
      threadId,
      checkpoint.rolloutId,
      checkpoint.endByteOffset,
      checkpoint.nextSeq,
    )
}

function readCheckpoint(
  database: DatabaseSync,
  threadId: string,
  rolloutId: string,
): RolloutCheckpoint | undefined {
  const row = database
    .prepare(`
      SELECT end_byte_offset, next_seq FROM rollout_checkpoints
      WHERE thread_id = ? AND rollout_id = ?
    `)
    .get(threadId, rolloutId) as
    | Readonly<{ end_byte_offset: number; next_seq: number }>
    | undefined
  return row === undefined
    ? undefined
    : {
        rolloutId,
        endByteOffset: row.end_byte_offset,
        nextSeq: row.next_seq,
      }
}

function insertThread(
  database: DatabaseSync,
  metadata: ThreadMetadata,
  seq: number,
  stamp: RolloutProjectionStamp,
): void {
  database
    .prepare(`
      INSERT INTO projection_threads (
        thread_id, metadata_json, title, updated_at, seq,
        metadata_size, metadata_mtime_ms, rollout_size, rollout_mtime_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      metadata.id,
      JSON.stringify(metadata),
      metadata.title ?? "",
      metadata.updatedAt,
      seq,
      stamp.metadataSize,
      stamp.metadataMtimeMs,
      stamp.rolloutSize,
      stamp.rolloutMtimeMs,
    )
}

export function projectedThreadSummary(row: ProjectedThreadRow): ThreadSummary {
  const value: unknown = JSON.parse(row.metadata_json)
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    value.id !== row.thread_id
  ) {
    throw new Error(`Thread ${row.thread_id} has invalid projected metadata.`)
  }
  return {
    ...(value as ThreadMetadata),
    ...(JSON.parse(row.status_json) as ThreadStatusProjection),
    seq: row.seq,
  }
}
