import type { DatabaseSync } from "node:sqlite"
import type { HistoryLocation } from "../protocol/application.ts"
import type { DisplayWindow, RolloutRecordLocation } from "./display-window.ts"
import type {
  StoredRolloutItem,
  ThreadMetadata,
  ThreadSummary,
  ThreadStatusProjection,
} from "./rollout.ts"
import { sessionCacheExpiry } from "./session-cache-expiry.ts"
import {
  type ProjectedThreadRow,
  projectedThreadSummary,
  SqliteRolloutProjection,
} from "./sqlite-rollout-projection.ts"
import {
  applyDisplayEntries,
  createDisplayTables,
  readCompletedTurns,
  readDisplayActivity,
  readDisplayEvents,
  readDisplayPage,
  readInputAdmissions,
} from "./sqlite-thread-display-projection.ts"
import {
  createTranscriptLocationTable,
  findTranscriptLocation,
  indexTranscriptLocations,
} from "./sqlite-transcript-locations.ts"
import {
  advanceThreadModelRouting,
  type ThreadModelRouting,
} from "./thread-model-routing.ts"
import type {
  ThreadDisplayActivity,
  CompletedTurnsQuery,
  CompletedTurnsRead,
} from "./thread-store.ts"

export class SqliteThreadHistoryProjection extends SqliteRolloutProjection {
  constructor(databasePath: string) {
    super(databasePath, 4, dropHistoryTables, createHistoryTables)
  }

  protected applyEntries(
    threadId: string,
    entries: readonly StoredRolloutItem[],
    locations: ReadonlyMap<number, RolloutRecordLocation> | undefined,
    previousStatus: ThreadStatusProjection,
  ): void {
    applyDisplayEntries(
      this.database,
      threadId,
      entries,
      previousStatus.activeTurnId,
    )
    if (locations !== undefined)
      indexTranscriptLocations(this.database, threadId, entries, locations)
    const previous = this.readModelRouting(threadId) ?? {}
    const current = advanceThreadModelRouting(previous, entries)
    if (current !== previous)
      this.database
        .prepare(`
          INSERT INTO history_routing (thread_id, routing_json) VALUES (?, ?)
          ON CONFLICT (thread_id) DO UPDATE SET routing_json = excluded.routing_json
        `)
        .run(threadId, JSON.stringify(current))
  }

  readModelRouting(threadId: string): ThreadModelRouting | undefined {
    const row = this.database
      .prepare("SELECT routing_json FROM history_routing WHERE thread_id = ?")
      .get(threadId) as { routing_json: string } | undefined
    return row === undefined
      ? undefined
      : (JSON.parse(row.routing_json) as ThreadModelRouting)
  }

  readCurrentSummary(
    metadata: ThreadMetadata,
    rollout: Readonly<{ size: number; mtimeMs: number }>,
  ): ThreadSummary | undefined {
    const row = this.database
      .prepare(`
        SELECT thread.thread_id, thread.metadata_json, thread.seq, thread.title,
               thread.status_json
        FROM projection_threads AS thread JOIN rollout_checkpoints AS checkpoint
          ON checkpoint.thread_id = thread.thread_id
        WHERE thread.thread_id = ? AND checkpoint.rollout_id = ?
          AND checkpoint.end_byte_offset = ? AND thread.rollout_mtime_ms = ?
          AND json_extract(thread.metadata_json, '$.rolloutId') = checkpoint.rollout_id
      `)
      .get(metadata.id, metadata.rolloutId, rollout.size, rollout.mtimeMs) as
      | ProjectedThreadRow
      | undefined
    return row === undefined
      ? undefined
      : { ...projectedThreadSummary(row), ...metadata }
  }

  readDisplayWindow(
    threadId: string,
    before = Number.MAX_SAFE_INTEGER,
    transcript = false,
  ): DisplayWindow {
    return readDisplayPage(this.database, threadId, before, transcript)
  }

  readCompletedTurns(
    threadId: string,
    query: CompletedTurnsQuery,
  ): CompletedTurnsRead | undefined {
    const summary = this.readSummary(threadId)
    if (
      summary === undefined ||
      (query.rolloutId !== undefined && query.rolloutId !== summary.rolloutId)
    )
      return undefined
    const seq = Math.min(
      summary.seq + 1,
      query.through ?? Number.MAX_SAFE_INTEGER,
    )
    const page = readCompletedTurns(this.database, threadId, {
      ...query,
      through: seq,
    })
    if (page === undefined) return undefined
    const latestRecord = this.database.prepare(`
      SELECT record_json FROM thread_items WHERE thread_id = ? AND kind = ? AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `)
    const parse = (row: unknown): StoredRolloutItem | undefined =>
      row === undefined
        ? undefined
        : (JSON.parse(
            (row as { record_json: string }).record_json,
          ) as StoredRolloutItem)
    const context = parse(latestRecord.get(threadId, "turn_context", seq))?.item
    const tokens = parse(latestRecord.get(threadId, "token_count", seq))?.item
    const completion = parse(
      this.database
        .prepare(`
      SELECT record_json FROM thread_items
      WHERE thread_id = ? AND kind = 'turn_completed' AND successful = 1 AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `)
        .get(threadId, seq),
    )
    const cacheContext =
      completion?.item.type !== "turn_completed"
        ? undefined
        : (this.database
            .prepare(`
        SELECT record_json FROM thread_items
        WHERE thread_id = ? AND kind = 'turn_context' AND turn_id = ? AND seq < ?
        ORDER BY seq DESC LIMIT 1
      `)
            .get(threadId, completion.item.turnId, completion.seq) as
            | { record_json: string }
            | undefined)
    const cacheExpiry =
      completion === undefined || cacheContext === undefined
        ? undefined
        : sessionCacheExpiry([
            JSON.parse(cacheContext.record_json) as StoredRolloutItem,
            completion,
          ])
    return {
      ...page,
      rolloutId: summary.rolloutId,
      seq,
      ...(completion === undefined
        ? {}
        : {
            latestCompletionSeq: completion.seq + 1,
          }),
      ...(context?.type !== "turn_context"
        ? {}
        : {
            currentModel:
              context.context.configuration.modelChoice ??
              context.context.selection,
          }),
      ...(tokens?.type !== "token_count"
        ? {}
        : {
            contextTokens: {
              activeContextTokens: tokens.activeContextTokens,
              ...(tokens.capacityTokens === undefined
                ? {}
                : { capacityTokens: tokens.capacityTokens }),
              ...(tokens.provider === undefined
                ? {}
                : { provider: tokens.provider }),
              ...(tokens.model === undefined ? {} : { model: tokens.model }),
            },
          }),
      ...(cacheExpiry === undefined ? {} : { cacheExpiry }),
    }
  }

  readDisplayLocation(
    threadId: string,
    location: HistoryLocation,
    page: Readonly<{ before?: number; after?: number }>,
  ) {
    const summary = this.readSummary(threadId)
    if (summary?.rolloutId !== location.rolloutId) return undefined
    const match = this.database
      .prepare(`
      SELECT seq, 'message' AS kind FROM transcript_locations
      WHERE thread_id = ? AND turn_id = ? AND item_id = ?
      UNION ALL
      SELECT seq, 'tool' AS kind FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_id = ? AND kind = 'item_completed'
      ORDER BY seq LIMIT 1
    `)
      .get(
        threadId,
        location.turnId,
        location.itemId,
        threadId,
        location.turnId,
        location.itemId,
      ) as { seq: number; kind: string } | undefined
    if (match === undefined) return undefined
    let before = page.before
    if (page.after !== undefined) {
      // Use the next finished turn as the end of the page. The transcript
      // byte budget can trim preceding turns, so jumping several ends here
      // could skip a turn in between.
      const next = this.database
        .prepare(`
        SELECT end_seq FROM thread_turns
        WHERE thread_id = ? AND end_seq >= ? ORDER BY end_seq LIMIT 1
      `)
        .get(threadId, page.after) as { end_seq: number } | undefined
      before = (next?.end_seq ?? summary.seq) + 1
    }
    const opensTool = before === undefined && match.kind === "tool"
    if (opensTool) before = match.seq + 1
    if (before === undefined) {
      const turnEnd = this.database
        .prepare(`
        SELECT end_seq FROM thread_turns
        WHERE thread_id = ? AND turn_id = ? AND end_seq >= ?
        ORDER BY end_seq DESC LIMIT 1
      `)
        .get(threadId, location.turnId, match.seq) as
        | { end_seq: number }
        | undefined
      before = (turnEnd?.end_seq ?? match.seq) + 1
    }
    return {
      ...this.readDisplayWindow(threadId, before, !opensTool),
      endSeq: summary.seq,
      ...(before <= summary.seq ? { historyAfter: before } : {}),
    }
  }

  readDisplayActivity(
    threadId: string,
    turnId: string,
    page: number | Readonly<{ aroundItemId: string }>,
  ): ThreadDisplayActivity | undefined {
    if (typeof page === "number")
      return readDisplayActivity(this.database, threadId, turnId, page)
    const row = this.database
      .prepare(`
      SELECT record_json FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_id = ?
        AND kind IN ('item_completed', 'response_item')
      ORDER BY seq DESC LIMIT 1
    `)
      .get(threadId, turnId, page.aroundItemId) as
      | { record_json: string }
      | undefined
    return row === undefined
      ? undefined
      : { records: [JSON.parse(row.record_json) as StoredRolloutItem] }
  }

  readThreadEvents(
    threadId: string,
    input: { after: number; through: number; limit: number },
  ) {
    return readDisplayEvents(
      this.database,
      threadId,
      input.after,
      input.through,
      input.limit,
    )
  }

  readInputAdmissions(
    threadId: string,
    requestIds: readonly string[],
  ): StoredRolloutItem[] {
    return readInputAdmissions(this.database, threadId, requestIds)
  }

  findTranscriptItem(threadId: string, itemId: string, through?: number) {
    return findTranscriptLocation(this.database, threadId, itemId, through)
  }
}

function dropHistoryTables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS thread_turns;
    DROP TABLE IF EXISTS display_records;
    DROP TABLE IF EXISTS thread_items;
    DROP TABLE IF EXISTS transcript_locations;
    DROP TABLE IF EXISTS history_routing;
  `)
}

function createHistoryTables(database: DatabaseSync): void {
  createDisplayTables(database)
  createTranscriptLocationTable(database)
  database.exec(`
    CREATE TABLE IF NOT EXISTS history_routing (
      thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      routing_json TEXT NOT NULL
    ) STRICT;
  `)
}
