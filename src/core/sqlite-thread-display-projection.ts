import type { DatabaseSync } from "node:sqlite"
import {
  type DisplayWindow,
  displayPageBytes,
  displayPageRecords,
  displayRecord,
  selectDisplayWindow,
} from "./display-window.ts"
import type { StoredRolloutItem, ThreadMetadata } from "./rollout.ts"

export class ThreadProjectionChangedError extends Error {
  constructor() {
    super("Thread projection advanced while its rollout was being read.")
  }
}

// Called inside the shared projection transaction: another store instance can
// finish repair/revert while this reader awaits filesystem I/O.
export function requireProjectionAppend(
  database: DatabaseSync,
  metadata: ThreadMetadata,
  entries: readonly StoredRolloutItem[],
  checkpoint?: RolloutCheckpoint,
): void {
  const row = database
    .prepare("SELECT metadata_json FROM search_threads WHERE thread_id = ?")
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

type DisplayRow = Readonly<{ record_json: string; byte_size: number }>

export function createDisplayTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS display_records (
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      turn_id TEXT,
      successful INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS display_state
      ON display_records (thread_id, kind, seq);
    CREATE INDEX IF NOT EXISTS display_turn
      ON display_records (thread_id, turn_id, kind, seq);
    CREATE TABLE IF NOT EXISTS rollout_checkpoints (
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      rollout_id TEXT NOT NULL,
      end_byte_offset INTEGER NOT NULL,
      next_seq INTEGER NOT NULL,
      PRIMARY KEY (thread_id, rollout_id)
    ) STRICT;
  `)
}

export function applyDisplayEntries(
  database: DatabaseSync,
  threadId: string,
  entries: readonly StoredRolloutItem[],
): void {
  const insert = database.prepare(`
    INSERT INTO display_records
      (thread_id, seq, kind, turn_id, successful, record_json, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const entry of entries) {
    const record = displayRecord(entry)
    if (record === undefined) continue
    const { item } = record
    const turnId =
      item.type === "response_item"
        ? item.item.turnId
        : item.type === "turn_context"
          ? item.context.turnId
          : "turnId" in item
            ? item.turnId
            : null
    const json = JSON.stringify(record)
    insert.run(
      threadId,
      record.seq,
      item.type,
      turnId,
      item.type === "turn_completed" && item.outcome === "completed" ? 1 : 0,
      json,
      Buffer.byteLength(json),
    )
  }
}

export function writeCheckpoint(
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

export function readCheckpoint(
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

export function readDisplayPage(
  database: DatabaseSync,
  threadId: string,
  before: number,
): DisplayWindow {
  const candidates = database
    .prepare(`
      SELECT record_json, byte_size FROM display_records
      WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
    `)
    .iterate(threadId, before, displayPageRecords + 1)
  const records = boundedRows(candidates).reverse()
  const window = selectDisplayWindow(records)
  const first = window.records[0]?.seq ?? before
  const supplemental = new Map(
    window.lookbehind.map((record) => [record.seq, record]),
  )
  const add = (row: DisplayRow | undefined) => {
    if (row === undefined) return
    const record = parseDisplayRow(row)
    if (record.seq < first) supplemental.set(record.seq, record)
  }
  const lastState = (kind: string) =>
    database
      .prepare(`
        SELECT record_json, byte_size FROM display_records
        WHERE thread_id = ? AND kind = ? AND seq < ?
        ORDER BY seq DESC LIMIT 1
      `)
      .get(threadId, kind, before) as DisplayRow | undefined
  // State is evaluated at the page's upper boundary, matching full-history
  // selection, and remains separate from contiguous page coverage.
  add(lastState("token_count"))
  add(lastState("turn_context"))
  const owner = window.records[0]?.item
  const turnId =
    owner?.type === "response_item"
      ? owner.item.turnId
      : owner?.type === "turn_context"
        ? owner.context.turnId
        : owner !== undefined && "turnId" in owner
          ? owner.turnId
          : undefined
  const turnState = (kind: string, ownerTurnId: string, beforeSeq: number) =>
    database
      .prepare(`
        SELECT record_json, byte_size FROM display_records
        WHERE thread_id = ? AND turn_id = ? AND kind = ? AND seq < ?
        ORDER BY seq DESC LIMIT 1
      `)
      .get(threadId, ownerTurnId, kind, beforeSeq) as DisplayRow | undefined
  if (turnId !== undefined) {
    add(turnState("turn_started", turnId, before))
    add(turnState("turn_context", turnId, before))
  }
  const cacheRow = database
    .prepare(`
      SELECT record_json, byte_size FROM display_records
      WHERE thread_id = ? AND kind = 'turn_completed'
        AND successful = 1 AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `)
    .get(threadId, before) as DisplayRow | undefined
  if (cacheRow !== undefined) {
    const cache = parseDisplayRow(cacheRow)
    add(cacheRow)
    if (cache.item.type === "turn_completed")
      add(turnState("turn_context", cache.item.turnId, cache.seq))
  }
  return {
    records: window.records,
    lookbehind: [...supplemental.values()].sort((a, b) => a.seq - b.seq),
    hasEarlier:
      database
        .prepare(
          "SELECT 1 FROM display_records WHERE thread_id = ? AND seq < ? LIMIT 1",
        )
        .get(threadId, first) !== undefined,
  }
}

export function readDisplayEvents(
  database: DatabaseSync,
  threadId: string,
  after: number,
  through: number,
  limit: number,
): { records: StoredRolloutItem[]; nextAfter: number; hasMore: boolean } {
  const rows = database
    .prepare(`
      SELECT record_json, byte_size FROM display_records
      WHERE thread_id = ? AND seq > ? AND seq <= ? AND kind <> 'turn_context'
      ORDER BY seq LIMIT ?
    `)
    .iterate(threadId, after, through, Math.min(limit, displayPageRecords) + 1)
  const records = boundedRows(rows, Math.min(limit, displayPageRecords))
  const last = records.at(-1)?.seq ?? after
  const hasMore =
    database
      .prepare(`
        SELECT 1 FROM display_records
        WHERE thread_id = ? AND seq > ? AND seq <= ? AND kind <> 'turn_context' LIMIT 1
      `)
      .get(threadId, last, through) !== undefined
  return { records, nextAfter: hasMore ? last : through, hasMore }
}

export function readInputAdmissions(
  database: DatabaseSync,
  threadId: string,
  requestIds: readonly string[],
): StoredRolloutItem[] {
  const rows = database
    .prepare(`
    SELECT record_json, byte_size FROM display_records
    WHERE thread_id = ? AND kind = 'response_item'
      AND turn_id IN (SELECT value FROM json_each(?))
    ORDER BY seq
  `)
    .all(threadId, JSON.stringify(requestIds)) as unknown as DisplayRow[]
  return rows.map(parseDisplayRow)
}

function boundedRows(
  rows: Iterable<unknown>,
  limit = displayPageRecords,
): StoredRolloutItem[] {
  const records: StoredRolloutItem[] = []
  let bytes = 0
  for (const value of rows) {
    const row = value as DisplayRow
    if (
      records.length > 0 &&
      (records.length === limit || bytes + row.byte_size > displayPageBytes)
    )
      break
    bytes += row.byte_size
    records.push(parseDisplayRow(row))
  }
  return records
}

function parseDisplayRow(row: DisplayRow): StoredRolloutItem {
  return JSON.parse(row.record_json) as StoredRolloutItem
}
