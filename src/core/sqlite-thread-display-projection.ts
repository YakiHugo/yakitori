import type { DatabaseSync } from "node:sqlite"
import {
  type DisplayWindow,
  displayPageBytes,
  displayPageRecords,
  displayRecord,
  isTranscriptRecord,
  selectDisplayWindow,
} from "./display-window.ts"
import type { SessionTurnOutline } from "../protocol/session-turns.ts"
import type { StoredRolloutItem } from "./rollout.ts"
import type { CompletedTurnsQuery, CompletedTurnsRead } from "./thread-store.ts"

type DisplayRow = Readonly<{ record_json: string; byte_size: number }>
type CompletedTurnRow = Readonly<{
  end_seq: number
  turn_id: string
  activity_count: number
  suppress_legacy_answer: number
}>

export function createDisplayTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_items (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      turn_id TEXT,
      item_id TEXT,
      request_id TEXT,
      assistant_with_text INTEGER NOT NULL,
      successful INTEGER NOT NULL,
      transcript INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS display_state
      ON thread_items (thread_id, kind, seq);
    CREATE INDEX IF NOT EXISTS display_turn
      ON thread_items (thread_id, turn_id, kind, seq);
    CREATE INDEX IF NOT EXISTS display_turn_sequence
      ON thread_items (thread_id, turn_id, seq);
    CREATE INDEX IF NOT EXISTS display_transcript
      ON thread_items (thread_id, transcript, seq);
    CREATE INDEX IF NOT EXISTS display_activity
      ON thread_items (thread_id, turn_id, seq) WHERE transcript = 0;
    CREATE INDEX IF NOT EXISTS display_summary_items
      ON thread_items (thread_id, turn_id, seq) WHERE transcript = 1;
    CREATE INDEX IF NOT EXISTS display_location
      ON thread_items (thread_id, turn_id, item_id) WHERE item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS display_request
      ON thread_items (thread_id, request_id, seq) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS display_assistant
      ON thread_items (thread_id, turn_id, seq) WHERE assistant_with_text = 1;
    CREATE TABLE IF NOT EXISTS thread_turns (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      end_seq INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'interrupted')),
      started_at TEXT,
      input_id TEXT,
      activity_count INTEGER NOT NULL,
      suppress_legacy_answer INTEGER NOT NULL,
      PRIMARY KEY (thread_id, end_seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS thread_turns_by_id
      ON thread_turns (thread_id, turn_id, end_seq);
  `)
}

export function applyDisplayEntries(
  database: DatabaseSync,
  threadId: string,
  entries: readonly StoredRolloutItem[],
  activeTurnId: string | undefined,
): void {
  const insert = database.prepare(`
    INSERT INTO thread_items
      (thread_id, seq, kind, turn_id, item_id, request_id, assistant_with_text, successful, transcript, record_json, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const completeTurn = database.prepare(`
    INSERT INTO thread_turns (
      thread_id, turn_id, end_seq, completed_at, outcome,
      started_at, input_id, activity_count, suppress_legacy_answer
    )
    WITH started AS (
      SELECT record_json FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND kind = 'turn_started' AND seq < ?
      ORDER BY seq DESC LIMIT 1
    )
    SELECT ?, ?, ?, ?, ?,
      (SELECT json_extract(record_json, '$.createdAt') FROM started),
      (SELECT json_extract(record_json, '$.item.inputItemId') FROM started),
      COUNT(*),
      COALESCE(? AND MAX(seq) > (
        SELECT MAX(seq) FROM thread_items
        WHERE thread_id = ? AND turn_id = ? AND seq < ?
          AND assistant_with_text = 1
      ), 0)
    FROM thread_items
    WHERE thread_id = ? AND turn_id = ? AND seq < ? AND transcript = 0
  `)
  for (const entry of entries) {
    const record = displayRecord(entry)
    if (record === undefined) continue
    const { item } = record
    if (item.type === "turn_started") activeTurnId = item.turnId
    const turnId =
      item.type === "response_item"
        ? (activeTurnId ?? item.item.turnId)
        : item.type === "turn_context"
          ? (activeTurnId ?? item.context.turnId)
          : "turnId" in item
            ? item.turnId
            : null
    const json = JSON.stringify(record)
    const assistantWithText =
      item.type === "item_completed" &&
      item.item.type === "agent_message" &&
      item.item.content.some((part) => part.text !== "")
    insert.run(
      threadId,
      record.seq,
      item.type,
      turnId,
      item.type === "item_completed"
        ? item.item.itemId
        : item.type === "response_item"
          ? item.item.id
          : null,
      item.type === "response_item" ? item.item.turnId : null,
      assistantWithText ? 1 : 0,
      item.type === "turn_completed" && item.outcome === "completed" ? 1 : 0,
      isTranscriptRecord(record) ? 1 : 0,
      json,
      Buffer.byteLength(json),
    )
    if (item.type === "turn_completed") {
      if (activeTurnId === item.turnId) activeTurnId = undefined
      // Older completions inferred the final answer from entry order.
      // Remember when hidden activity would change that inference.
      completeTurn.run(
        threadId,
        item.turnId,
        record.seq,
        threadId,
        item.turnId,
        record.seq,
        record.createdAt,
        item.outcome,
        item.outcome === "completed" &&
          item.completion?.answerItemIds === undefined
          ? 1
          : 0,
        threadId,
        item.turnId,
        record.seq,
        threadId,
        item.turnId,
        record.seq,
      )
    }
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
      SELECT record_json, byte_size FROM thread_items
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
        SELECT record_json, byte_size FROM thread_items
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
        SELECT record_json, byte_size FROM thread_items
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
      SELECT record_json, byte_size FROM thread_items
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
          "SELECT 1 FROM thread_items WHERE thread_id = ? AND seq < ? LIMIT 1",
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
    SELECT 1 FROM thread_turns WHERE thread_id = ? AND end_seq = ?
  `)
      .get(threadId, before - 1) === undefined
  )
    return undefined
  // Bound the work for older turns, while always taking the latest turn's
  // complete transcript. Activity rows are never decoded for this read.
  const recentTurns = 5
  const ends = database
    .prepare(`
    SELECT end_seq, turn_id, activity_count, suppress_legacy_answer FROM thread_turns
    WHERE thread_id = ? AND end_seq < ?
    ORDER BY end_seq DESC LIMIT ?
  `)
    .all(threadId, before, recentTurns + 1) as CompletedTurnRow[]
  const latestEnd = ends[0]
  if (
    latestEnd === undefined ||
    database
      .prepare(`
    SELECT 1 FROM thread_items
    WHERE thread_id = ? AND kind = 'turn_started' AND seq > ? AND seq < ?
    LIMIT 1
  `)
      .get(threadId, latestEnd.end_seq, before) !== undefined
  )
    return undefined
  const getRows = database.prepare(`
    SELECT record_json, byte_size FROM thread_items
    WHERE thread_id = ? AND transcript = 1 AND seq >= ? AND seq < ?
    ORDER BY seq
  `)
  const pages: StoredRolloutItem[][] = []
  const activityTurnIds: string[] = []
  let bytes = 0
  let count = 0
  let first = before
  for (let index = 0; index < Math.min(recentTurns, ends.length); index++) {
    const end = ends[index]
    if (end === undefined) break
    const start = (ends[index + 1]?.end_seq ?? 0) + 1
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
    if (end.activity_count > 0) activityTurnIds.unshift(end.turn_id)
    if (end.suppress_legacy_answer) {
      const completionIndex = records.findIndex(
        ({ seq }) => seq === end.end_seq,
      )
      const completion = records[completionIndex]
      if (completion !== undefined)
        records[completionIndex] = hideLegacyAnswer(completion)
    }
    pages.push(records)
    first = start
  }
  const records = pages.reverse().flat()
  // State may predate all selected turns.
  const lastState = database.prepare(`
    SELECT record_json, byte_size FROM thread_items
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
      SELECT record_json, byte_size FROM thread_items
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
          SELECT record_json, byte_size FROM thread_items
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

type TurnListRow = CompletedTurnRow &
  Readonly<{
    completed_at: string
    outcome: SessionTurnOutline["outcome"]
    started_at: string | null
    input_id: string | null
  }>

export function readCompletedTurns(
  database: DatabaseSync,
  threadId: string,
  query: CompletedTurnsQuery,
): Pick<CompletedTurnsRead, "turns" | "nextBefore" | "nextAfter"> | undefined {
  const through =
    query.through === undefined ? Number.MAX_SAFE_INTEGER : query.through - 1
  let before =
    query.before === undefined ? Number.MAX_SAFE_INTEGER : query.before - 1
  // An unmatched durable start has no task after a restart. Include it in
  // history as interrupted unless the live cut identifies it as resident.
  const interrupted = database
    .prepare(`
      WITH latest_start AS (
        SELECT turn_id, seq, record_json FROM thread_items
        WHERE thread_id = ? AND kind = 'turn_started' AND seq <= ?
        ORDER BY seq DESC LIMIT 1
      )
      SELECT ? AS end_seq, start.turn_id, 'interrupted' AS outcome,
        json_extract(start.record_json, '$.createdAt') AS started_at,
        json_extract(start.record_json, '$.item.inputItemId') AS input_id,
        json_extract(start.record_json, '$.createdAt') AS completed_at,
        (SELECT COUNT(*) FROM thread_items
          WHERE thread_id = ? AND turn_id = start.turn_id AND transcript = 0 AND seq <= ?
        ) AS activity_count, 0 AS suppress_legacy_answer
      FROM latest_start AS start
      WHERE start.turn_id IS NOT ?
        AND NOT EXISTS (
          SELECT 1 FROM thread_turns
          WHERE thread_id = ? AND turn_id = start.turn_id AND end_seq BETWEEN start.seq AND ?
        )
    `)
    .get(
      threadId,
      through,
      through,
      threadId,
      through,
      query.activeTurnId ?? null,
      threadId,
      through,
    ) as TurnListRow | undefined
  if (query.aroundTurnId !== undefined) {
    const anchor = database
      .prepare(`
      SELECT end_seq FROM thread_turns WHERE thread_id = ? AND turn_id = ? AND end_seq <= ?
      ORDER BY end_seq DESC LIMIT 1
    `)
      .get(threadId, query.aroundTurnId, through) as
      | { end_seq: number }
      | undefined
    const end =
      anchor?.end_seq ??
      (interrupted?.turn_id === query.aroundTurnId
        ? interrupted.end_seq
        : undefined)
    if (end === undefined) return undefined
    before = end + 1
  }
  const forward = query.after !== undefined
  const rows = database
    .prepare(`
    SELECT end_seq, turn_id, completed_at, started_at, input_id, outcome,
      activity_count, suppress_legacy_answer
    FROM thread_turns WHERE thread_id = ? AND end_seq <= ? AND end_seq ${forward ? ">" : "<"} ?
    ORDER BY end_seq ${forward ? "ASC" : "DESC"} LIMIT ?
  `)
    .all(
      threadId,
      through,
      query.after === undefined ? before : query.after - 1,
      query.limit,
    ) as TurnListRow[]
  if (
    interrupted !== undefined &&
    (forward
      ? interrupted.end_seq > (query.after ?? 0) - 1
      : interrupted.end_seq < before)
  ) {
    if (forward) rows.push(interrupted)
    else rows.unshift(interrupted)
    if (rows.length > query.limit) rows.pop()
  }
  const summaryItems =
    query.view === "summary"
      ? database.prepare(`
      SELECT record_json, byte_size FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND transcript = 1 AND seq > ? AND seq <= ?
        AND kind NOT IN ('turn_context', 'token_count')
      ORDER BY seq
    `)
      : undefined
  const previousEnd =
    summaryItems === undefined
      ? undefined
      : database.prepare(`
    SELECT end_seq FROM thread_turns WHERE thread_id = ? AND end_seq < ?
    ORDER BY end_seq DESC LIMIT 1
  `)
  const turns = []
  let bytes = 0
  let count = 0
  for (const [index, row] of rows.entries()) {
    const records: StoredRolloutItem[] = []
    let complete = true
    const previous = previousEnd?.get(threadId, row.end_seq) as
      | { end_seq: number }
      | undefined
    for (const value of summaryItems?.iterate(
      threadId,
      row.turn_id,
      previous?.end_seq ?? 0,
      row.end_seq,
    ) ?? []) {
      const item = value as DisplayRow
      // Keep each Turn together. An oversized first Turn can still be read,
      // while additional Turns have to fit the display budget.
      if (
        index > 0 &&
        (count >= displayPageRecords ||
          bytes + item.byte_size > displayPageBytes)
      ) {
        complete = false
        break
      }
      const record = parseDisplayRow(item)
      records.push(
        row.suppress_legacy_answer ? hideLegacyAnswer(record) : record,
      )
      bytes += item.byte_size
      count++
    }
    if (!complete) break
    turns.push({
      turnId: row.turn_id,
      completionSeq: row.end_seq + 1,
      completedAt: row.completed_at,
      outcome: row.outcome,
      activityCount: row.activity_count,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.input_id === null ? {} : { inputId: row.input_id }),
      ...(summaryItems === undefined ? {} : { records }),
    })
  }
  if (forward) turns.reverse()
  const newest = turns[0]
  const oldest = turns.at(-1)
  if (newest === undefined || oldest === undefined) return { turns }
  const earlier = database
    .prepare(`
    SELECT 1 FROM thread_turns WHERE thread_id = ? AND end_seq < ? LIMIT 1
  `)
    .get(threadId, oldest.completionSeq - 1)
  const later = database
    .prepare(`
    SELECT 1 FROM thread_turns WHERE thread_id = ? AND end_seq > ? AND end_seq <= ? LIMIT 1
  `)
    .get(threadId, newest.completionSeq - 1, through)
  return {
    turns,
    ...(earlier === undefined ? {} : { nextBefore: oldest.completionSeq }),
    ...(later !== undefined ||
    (interrupted !== undefined && interrupted.end_seq >= newest.completionSeq)
      ? { nextAfter: newest.completionSeq }
      : {}),
  }
}

function hideLegacyAnswer(record: StoredRolloutItem): StoredRolloutItem {
  return record.item.type === "turn_completed"
    ? {
        ...record,
        item: {
          ...record.item,
          completion: { ...record.item.completion, answerItemIds: [] },
        },
      }
    : record
}

export function readDisplayActivity(
  database: DatabaseSync,
  threadId: string,
  turnId: string,
  before: number,
): { records: readonly StoredRolloutItem[]; nextBefore?: number } {
  const end = database
    .prepare(`
    SELECT end_seq FROM thread_turns
    WHERE thread_id = ? AND turn_id = ? ORDER BY end_seq DESC LIMIT 1
  `)
    .get(threadId, turnId) as { end_seq: number } | undefined
  const rows = database
    .prepare(`
    SELECT record_json, byte_size FROM thread_items
    WHERE thread_id = ? AND turn_id = ? AND transcript = 0 AND seq < ?
    ORDER BY seq DESC LIMIT ?
  `)
    .iterate(
      threadId,
      turnId,
      Math.min(before, end?.end_seq ?? before),
      displayPageRecords + 1,
    )
  const records = boundedRows(rows)
  const last = records.at(-1)?.seq
  const hasMore =
    last !== undefined &&
    database
      .prepare(`
    SELECT 1 FROM thread_items
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
      SELECT record_json, byte_size FROM thread_items
      WHERE thread_id = ? AND seq > ? AND seq <= ? AND kind <> 'turn_context'
      ORDER BY seq LIMIT ?
    `)
    .iterate(threadId, after, through, Math.min(limit, displayPageRecords) + 1)
  const records = boundedRows(rows, Math.min(limit, displayPageRecords))
  const last = records.at(-1)?.seq ?? after
  const hasMore =
    database
      .prepare(`
        SELECT 1 FROM thread_items
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
    SELECT record_json, byte_size FROM thread_items
    WHERE thread_id = ? AND request_id IN (SELECT value FROM json_each(?))
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
