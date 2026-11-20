import type { DatabaseSync } from "node:sqlite"
import type { RolloutRecordLocation } from "./display-window.ts"
import type { StoredRolloutItem } from "./rollout.ts"

type IndexedLocation = RolloutRecordLocation &
  Readonly<{ rolloutId: string; seq: number }>

export function createTranscriptLocationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS transcript_locations (
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      rollout_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      start INTEGER NOT NULL,
      length INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS transcript_locations_by_item
      ON transcript_locations (thread_id, item_id, seq);
  `)
}

export function indexTranscriptLocations(
  database: DatabaseSync,
  threadId: string,
  records: readonly StoredRolloutItem[],
  locations: ReadonlyMap<number, RolloutRecordLocation>,
): void {
  const insert = database.prepare(`
    INSERT INTO transcript_locations (thread_id, seq, rollout_id, item_id, start, length)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const { item, rolloutId, seq } of records) {
    if (item.type !== "response_item" && item.type !== "agent_message") continue
    const location = locations.get(seq)
    if (location === undefined)
      throw new Error("Missing transcript record position.")
    insert.run(
      threadId,
      seq,
      rolloutId,
      item.item.id,
      location.start,
      location.length,
    )
  }
}

export function findTranscriptLocation(
  database: DatabaseSync,
  threadId: string,
  itemId: string,
  requestedThrough: number | undefined,
) {
  const { itemCount } = database
    .prepare(`
    SELECT COUNT(*) AS itemCount FROM transcript_locations WHERE thread_id = ?
  `)
    .get(threadId) as { itemCount: number }
  const through = requestedThrough ?? itemCount
  if (through < 1 || through > itemCount) return undefined
  const anchor = database
    .prepare(`
    SELECT rollout_id AS rolloutId, seq FROM transcript_locations
    WHERE thread_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
  `)
    .get(threadId, itemCount - through) as
    | Pick<IndexedLocation, "rolloutId" | "seq">
    | undefined
  if (anchor === undefined) return undefined
  const matches = database
    .prepare(`
    SELECT rollout_id AS rolloutId, seq, start, length FROM transcript_locations
    WHERE thread_id = ? AND item_id = ? AND seq <= ? LIMIT 2
  `)
    .all(threadId, itemId, anchor.seq) as IndexedLocation[]
  const location = matches.length === 1 ? matches[0] : undefined
  return location === undefined ? undefined : { location, itemCount, anchor }
}
