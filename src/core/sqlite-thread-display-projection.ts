import type { DatabaseSync } from "node:sqlite"
import {
  type DisplayWindow,
  displayPageBytes,
  displayPageRecords,
  displayRecord,
  isTranscriptRecord,
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
      transcript INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS display_state
      ON display_records (thread_id, kind, seq);
    CREATE INDEX IF NOT EXISTS display_turn
      ON display_records (thread_id, turn_id, kind, seq);
    CREATE INDEX IF NOT EXISTS display_transcript
      ON display_records (thread_id, transcript, seq);
    CREATE INDEX IF NOT EXISTS display_activity
      ON display_records (thread_id, turn_id, seq) WHERE transcript = 0;
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
      (thread_id, seq, kind, turn_id, successful, transcript, record_json, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      isTranscriptRecord(record) ? 1 : 0,
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
  transcript = false,
): DisplayWindow {
  if (transcript) {
    const page = readTranscriptPage(database, threadId, before)
    if (page !== undefined) return page
  }
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

function readTranscriptPage(
  database: DatabaseSync,
  threadId: string,
  before: number,
): DisplayWindow | undefined {
  // A detailed fallback can page from the middle of an unfinished or large
  // turn. Keep reading that range in detail until a turn boundary is reached.
  if (
    before !== Number.MAX_SAFE_INTEGER &&
    database
      .prepare(`
    SELECT 1 FROM display_records
    WHERE thread_id = ? AND seq = ? AND kind = 'turn_completed'
  `)
      .get(threadId, before - 1) === undefined
  )
    return undefined
  // Bound the work for older turns, while always taking the latest turn's
  // complete transcript. Activity rows are never decoded for this read.
  const recentTurns = 5
  const ends = database
    .prepare(`
    SELECT seq FROM display_records
    WHERE thread_id = ? AND kind = 'turn_completed' AND seq < ?
    ORDER BY seq DESC LIMIT ?
  `)
    .all(threadId, before, recentTurns + 1) as { seq: number }[]
  const latestEnd = ends[0]
  if (
    latestEnd === undefined ||
    database
      .prepare(`
    SELECT 1 FROM display_records
    WHERE thread_id = ? AND kind = 'turn_started' AND seq > ? AND seq < ?
    LIMIT 1
  `)
      .get(threadId, latestEnd.seq, before) !== undefined
  )
    return undefined
  const getRows = database.prepare(`
    SELECT record_json, byte_size FROM display_records
    WHERE thread_id = ? AND transcript = 1 AND seq >= ? AND seq < ?
    ORDER BY seq
  `)
  const pages: StoredRolloutItem[][] = []
  let bytes = 0
  let count = 0
  let first = before
  for (let index = 0; index < Math.min(recentTurns, ends.length); index++) {
    const start = (ends[index + 1]?.seq ?? 0) + 1
    const records: StoredRolloutItem[] = []
    let complete = true
    for (const value of getRows.iterate(threadId, start, first)) {
      const row = value as DisplayRow
      if (
        index > 0 &&
        (count >= displayPageRecords ||
          bytes + row.byte_size > displayPageBytes)
      ) {
        complete = false
        break
      }
      bytes += row.byte_size
      count++
      records.push(parseDisplayRow(row))
    }
    if (!complete) break
    pages.push(records)
    first = start
  }
  const hasActivity = database.prepare(`
    SELECT 1 FROM display_records
    WHERE thread_id = ? AND turn_id = ? AND transcript = 0 AND seq < ? LIMIT 1
  `)
  const hasTrailingActivity = database.prepare(`
    SELECT 1 FROM display_records
    WHERE thread_id = ? AND turn_id = ? AND transcript = 0 AND seq > ? AND seq < ?
    LIMIT 1
  `)
  const records = pages.reverse().flatMap((page) => {
    const latestAssistant = page.findLast(
      ({ item }) =>
        item.type === "item_completed" &&
        item.item.type === "agent_message" &&
        item.item.content.some(
          (part) => part.type !== "text" || part.text !== "",
        ),
    )
    return page.map((record) => {
      const { item, seq } = record
      if (
        item.type !== "turn_completed" ||
        item.outcome !== "completed" ||
        item.completion?.answerItemIds !== undefined ||
        latestAssistant === undefined ||
        hasTrailingActivity.get(
          threadId,
          item.turnId,
          latestAssistant.seq,
          seq,
        ) === undefined
      )
        return record
      // Legacy completions infer a final reply from the last visible item.
      // Omitting a later tool must not promote preceding commentary.
      return {
        ...record,
        item: {
          ...item,
          completion: { ...item.completion, answerItemIds: [] },
        },
      }
    })
  })
  const activityTurnIds = records.flatMap(({ item, seq }) =>
    item.type === "turn_completed" &&
    hasActivity.get(threadId, item.turnId, seq)
      ? [item.turnId]
      : [],
  )
  // State may predate all selected turns.
  const lastState = database.prepare(`
    SELECT record_json, byte_size FROM display_records
    WHERE thread_id = ? AND kind = ? AND seq < ? ORDER BY seq DESC LIMIT 1
  `)
  const lookbehind = ["turn_context", "token_count"].flatMap((kind) => {
    const row = lastState.get(threadId, kind, first) as DisplayRow | undefined
    return row ? [parseDisplayRow(row)] : []
  })
  if (
    !records.some(
      ({ item }) =>
        item.type === "turn_completed" && item.outcome === "completed",
    )
  ) {
    const previous = database
      .prepare(`
      SELECT record_json, byte_size FROM display_records
      WHERE thread_id = ? AND kind = 'turn_completed' AND successful = 1 AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `)
      .get(threadId, first) as DisplayRow | undefined
    if (previous !== undefined) {
      const completion = parseDisplayRow(previous)
      lookbehind.push(completion)
      if (completion.item.type === "turn_completed") {
        const context = database
          .prepare(`
          SELECT record_json, byte_size FROM display_records
          WHERE thread_id = ? AND turn_id = ? AND kind = 'turn_context' AND seq < ?
          ORDER BY seq DESC LIMIT 1
        `)
          .get(threadId, completion.item.turnId, completion.seq) as
          | DisplayRow
          | undefined
        if (context !== undefined) lookbehind.push(parseDisplayRow(context))
      }
    }
  }
  return {
    records,
    lookbehind: lookbehind.sort((a, b) => a.seq - b.seq),
    hasEarlier: first > 1,
    transcriptStart: first,
    activityTurnIds,
  }
}

export function readDisplayActivity(
  database: DatabaseSync,
  threadId: string,
  turnId: string,
  before: number,
): { records: readonly StoredRolloutItem[]; nextBefore?: number } {
  const end = database
    .prepare(`
    SELECT seq FROM display_records
    WHERE thread_id = ? AND turn_id = ? AND kind = 'turn_completed'
    ORDER BY seq DESC LIMIT 1
  `)
    .get(threadId, turnId) as { seq: number } | undefined
  if (end === undefined) return { records: [] }
  const rows = database
    .prepare(`
    SELECT record_json, byte_size FROM display_records
    WHERE thread_id = ? AND turn_id = ? AND transcript = 0 AND seq < ?
    ORDER BY seq DESC LIMIT ?
  `)
    .iterate(
      threadId,
      turnId,
      Math.min(before, end.seq),
      displayPageRecords + 1,
    )
  const records = boundedRows(rows)
  const last = records.at(-1)?.seq
  const hasMore =
    last !== undefined &&
    database
      .prepare(`
    SELECT 1 FROM display_records
    WHERE thread_id = ? AND turn_id = ? AND transcript = 0 AND seq < ? LIMIT 1
  `)
      .get(threadId, turnId, last) !== undefined
  return {
    records: records.reverse(),
    ...(hasMore ? { nextBefore: last } : {}),
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
