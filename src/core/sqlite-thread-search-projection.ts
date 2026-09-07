import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadSummary,
} from "./rollout.ts"
import {
  literalMatches,
  markdownVisibleText,
  parseThreadCursor,
  snippetForMatch,
  type ThreadSearchOccurrence,
  threadCursor,
} from "./thread-search.ts"
import type {
  ThreadStoreOccurrenceSearchInput,
  ThreadStoreOccurrenceSearchResult,
  ThreadStoreSearchInput,
  ThreadStoreSearchResult,
} from "./thread-store.ts"

export type ThreadSearchProjectionStamp = Readonly<{
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

type ThreadRow = Readonly<{
  thread_id: string
  metadata_json: string
  seq: number
  title: string
}>

type MessageRow = Readonly<{
  seq: number
  item_id: string
  turn_id: string
  text: string
}>

type TurnRow = Readonly<{
  last_tool_seq: number
  candidate_seq: number | null
  candidate_item_id: string | null
  candidate_text: string | null
}>

type OccurrenceCursor = Readonly<{
  threadId: string
  searchTerm: string
  seq: number
  itemId: string
  occurrenceIndex: number
}>

const schemaVersion = 1

// Disposable SQLite materialization of canonical JSONL history. The rollout
// remains authoritative; stamps let startup rebuild only stale projections.
export class SqliteThreadSearchProjection {
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
    this.#database.function(
      "literal_match",
      { deterministic: true },
      (text, searchTerm) =>
        typeof text === "string" &&
        typeof searchTerm === "string" &&
        literalMatches(text, searchTerm, 1).length > 0
          ? 1
          : 0,
    )
  }

  indexedThreadIds(): readonly string[] {
    const rows = this.#database
      .prepare("SELECT thread_id FROM search_threads")
      .all() as unknown as ReadonlyArray<Readonly<{ thread_id: string }>>
    return rows.map((row) => row.thread_id)
  }

  isCurrent(threadId: string, stamp: ThreadSearchProjectionStamp): boolean {
    const row = this.#database
      .prepare(`
        SELECT metadata_size, metadata_mtime_ms, rollout_size, rollout_mtime_ms
        FROM search_threads
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

  rebuild(stored: StoredThread, stamp: ThreadSearchProjectionStamp): void {
    this.#transaction(() => {
      this.#database
        .prepare("DELETE FROM search_threads WHERE thread_id = ?")
        .run(stored.metadata.id)
      insertThread(
        this.#database,
        stored.metadata,
        stored.rollout.filter(({ item }) => item.type !== "session_meta")
          .length,
        stamp,
      )
      applyEntries(this.#database, stored.metadata.id, stored.rollout)
    })
  }

  append(
    metadata: ThreadMetadata,
    entries: readonly StoredRolloutItem[],
    stamp: ThreadSearchProjectionStamp,
  ): void {
    this.#transaction(() => {
      const result = this.#database
        .prepare(`
          UPDATE search_threads
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
        throw new Error(`Thread ${metadata.id} has no search projection.`)
      }
      applyEntries(this.#database, metadata.id, entries)
    })
  }

  delete(threadId: string): void {
    this.#database
      .prepare("DELETE FROM search_threads WHERE thread_id = ?")
      .run(threadId)
  }

  searchThreads(input: ThreadStoreSearchInput): ThreadStoreSearchResult {
    const anchor =
      input.cursor === undefined ? undefined : parseThreadCursor(input.cursor)
    const rows = (
      anchor === undefined
        ? this.#database
            .prepare(
              `${matchingThreadsSql()} ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
            )
            .all(input.searchTerm, input.searchTerm, input.limit + 1)
        : this.#database
            .prepare(`${matchingThreadsSql()}
            AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
            ORDER BY updated_at DESC, thread_id DESC
            LIMIT ?
          `)
            .all(
              input.searchTerm,
              input.searchTerm,
              anchor.updatedAt,
              anchor.updatedAt,
              anchor.id,
              input.limit + 1,
            )
    ) as ThreadRow[]
    const page = rows.slice(0, input.limit)
    const matches = page.map((row) => ({
      summary: summaryFromRow(row),
      snippet: this.#firstSnippet(row, input.searchTerm),
    }))
    const last = page.at(-1)
    return {
      matches,
      ...(rows.length <= input.limit || last === undefined
        ? {}
        : { nextCursor: threadCursor(summaryFromRow(last)) }),
    }
  }

  searchThreadOccurrences(
    input: ThreadStoreOccurrenceSearchInput,
  ): ThreadStoreOccurrenceSearchResult | undefined {
    if (
      this.#database
        .prepare("SELECT 1 FROM search_threads WHERE thread_id = ?")
        .get(input.threadId) === undefined
    ) {
      return undefined
    }
    let cursor =
      input.cursor === undefined
        ? undefined
        : parseOccurrenceCursor(input.cursor, input.threadId, input.searchTerm)
    let after: Readonly<{ seq: number; itemId: string }> | undefined
    const occurrences: ThreadSearchOccurrence[] = []

    for (;;) {
      const row = this.#nextMatchingMessage(input, cursor, after)
      if (row === undefined) return { occurrences }
      const firstOccurrence =
        cursor?.seq === row.seq && cursor.itemId === row.item_id
          ? cursor.occurrenceIndex
          : 0
      const remaining = input.limit + 1 - occurrences.length
      const matches = literalMatches(
        row.text,
        input.searchTerm,
        firstOccurrence + remaining,
      ).slice(firstOccurrence)
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index]
        if (match === undefined) continue
        if (occurrences.length === input.limit) {
          return {
            occurrences,
            nextCursor: JSON.stringify({
              threadId: input.threadId,
              searchTerm: input.searchTerm,
              seq: row.seq,
              itemId: row.item_id,
              occurrenceIndex: firstOccurrence + index,
            } satisfies OccurrenceCursor),
          }
        }
        occurrences.push({
          turnId: row.turn_id,
          itemId: row.item_id,
          ...snippetForMatch(row.text, match),
        })
      }
      after = { seq: row.seq, itemId: row.item_id }
      cursor = undefined
    }
  }

  #nextMatchingMessage(
    input: ThreadStoreOccurrenceSearchInput,
    cursor: OccurrenceCursor | undefined,
    after: Readonly<{ seq: number; itemId: string }> | undefined,
  ): MessageRow | undefined {
    if (cursor !== undefined) {
      return this.#database
        .prepare(`
          SELECT seq, item_id, turn_id, text
          FROM search_messages
          WHERE thread_id = ? AND literal_match(text, ?) = 1
            AND (seq > ? OR (seq = ? AND item_id >= ?))
          ORDER BY seq ASC, item_id ASC
          LIMIT 1
        `)
        .get(
          input.threadId,
          input.searchTerm,
          cursor.seq,
          cursor.seq,
          cursor.itemId,
        ) as MessageRow | undefined
    }
    if (after !== undefined) {
      return this.#database
        .prepare(`
          SELECT seq, item_id, turn_id, text
          FROM search_messages
          WHERE thread_id = ? AND literal_match(text, ?) = 1
            AND (seq > ? OR (seq = ? AND item_id > ?))
          ORDER BY seq ASC, item_id ASC
          LIMIT 1
        `)
        .get(
          input.threadId,
          input.searchTerm,
          after.seq,
          after.seq,
          after.itemId,
        ) as MessageRow | undefined
    }
    return this.#database
      .prepare(`
        SELECT seq, item_id, turn_id, text
        FROM search_messages
        WHERE thread_id = ? AND literal_match(text, ?) = 1
        ORDER BY seq ASC, item_id ASC
        LIMIT 1
      `)
      .get(input.threadId, input.searchTerm) as MessageRow | undefined
  }

  #firstSnippet(row: ThreadRow, searchTerm: string): string {
    const titleMatch = literalMatches(row.title, searchTerm, 1)[0]
    if (titleMatch !== undefined)
      return snippetForMatch(row.title, titleMatch).snippet
    const message = this.#database
      .prepare(`
        SELECT seq, item_id, turn_id, text
        FROM search_messages
        WHERE thread_id = ? AND literal_match(text, ?) = 1
        ORDER BY seq ASC, item_id ASC
        LIMIT 1
      `)
      .get(row.thread_id, searchTerm) as MessageRow | undefined
    if (message === undefined) {
      throw new Error(`Thread ${row.thread_id} lost its search match.`)
    }
    const match = literalMatches(message.text, searchTerm, 1)[0]
    if (match === undefined) {
      throw new Error(`Thread ${row.thread_id} has an invalid search match.`)
    }
    return snippetForMatch(message.text, match).snippet
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      operation()
      this.#database.exec("COMMIT")
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK")
      throw error
    }
  }
}

function matchingThreadsSql(): string {
  return `
    SELECT thread_id, metadata_json, seq, title
    FROM search_threads AS thread
    WHERE (literal_match(title, ?) = 1 OR EXISTS (
      SELECT 1
      FROM search_messages AS message
      WHERE message.thread_id = thread.thread_id
        AND literal_match(message.text, ?) = 1
    ))
  `
}

function insertThread(
  database: DatabaseSync,
  metadata: ThreadMetadata,
  seq: number,
  stamp: ThreadSearchProjectionStamp,
): void {
  database
    .prepare(`
      INSERT INTO search_threads (
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

function applyEntries(
  database: DatabaseSync,
  threadId: string,
  entries: readonly StoredRolloutItem[],
): void {
  for (const record of entries) {
    if (record.item.type === "response_item") {
      const envelope = record.item.item
      const message = envelope.item
      if (message.role === "user" && message.context === undefined) {
        insertMessage(
          database,
          threadId,
          record.seq,
          envelope.turnId,
          envelope.id,
          "user",
          markdownVisibleText(
            message.content.map((block) => block.text).join("\n"),
          ),
        )
      } else if (message.role === "tool") {
        database
          .prepare(`
            INSERT INTO search_turns (thread_id, turn_id, last_tool_seq)
            VALUES (?, ?, ?)
            ON CONFLICT (thread_id, turn_id)
            DO UPDATE SET last_tool_seq = excluded.last_tool_seq
          `)
          .run(threadId, envelope.turnId, record.seq)
      } else if (message.role === "assistant") {
        const text = markdownVisibleText(
          message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        )
        database
          .prepare(`
            INSERT INTO search_turns (
              thread_id, turn_id, candidate_seq, candidate_item_id, candidate_text
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (thread_id, turn_id)
            DO UPDATE SET
              candidate_seq = excluded.candidate_seq,
              candidate_item_id = excluded.candidate_item_id,
              candidate_text = excluded.candidate_text
          `)
          .run(
            threadId,
            envelope.turnId,
            text === "" ? null : record.seq,
            text === "" ? null : envelope.id,
            text === "" ? null : text,
          )
      }
      continue
    }
    if (record.item.type !== "turn_completed") continue
    database
      .prepare(
        "DELETE FROM search_messages WHERE thread_id = ? AND turn_id = ? AND kind = 'assistant'",
      )
      .run(threadId, record.item.turnId)
    if (record.item.outcome !== "completed") continue
    const turn = database
      .prepare(`
        SELECT last_tool_seq, candidate_seq, candidate_item_id, candidate_text
        FROM search_turns
        WHERE thread_id = ? AND turn_id = ?
      `)
      .get(threadId, record.item.turnId) as TurnRow | undefined
    if (
      turn?.candidate_seq === null ||
      turn?.candidate_seq === undefined ||
      turn.candidate_item_id === null ||
      turn.candidate_text === null ||
      turn.candidate_seq <= turn.last_tool_seq
    ) {
      continue
    }
    insertMessage(
      database,
      threadId,
      turn.candidate_seq,
      record.item.turnId,
      turn.candidate_item_id,
      "assistant",
      turn.candidate_text,
    )
  }
}

function insertMessage(
  database: DatabaseSync,
  threadId: string,
  seq: number,
  turnId: string,
  itemId: string,
  kind: "assistant" | "user",
  text: string,
): void {
  database
    .prepare(`
      INSERT INTO search_messages (thread_id, seq, turn_id, item_id, kind, text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, item_id)
      DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id,
                    kind = excluded.kind, text = excluded.text
    `)
    .run(threadId, seq, turnId, itemId, kind, text)
}

function summaryFromRow(row: ThreadRow): ThreadSummary {
  const value: unknown = JSON.parse(row.metadata_json)
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    value.id !== row.thread_id
  ) {
    throw new Error(`Thread ${row.thread_id} has invalid search metadata.`)
  }
  return { ...(value as ThreadMetadata), seq: row.seq }
}

function parseOccurrenceCursor(
  cursor: string,
  threadId: string,
  searchTerm: string,
): OccurrenceCursor {
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch (cause) {
    throw new Error("Thread occurrence cursor is invalid.", { cause })
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("threadId" in value) ||
    value.threadId !== threadId ||
    !("searchTerm" in value) ||
    value.searchTerm !== searchTerm ||
    !("seq" in value) ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    !("itemId" in value) ||
    typeof value.itemId !== "string" ||
    !("occurrenceIndex" in value) ||
    typeof value.occurrenceIndex !== "number" ||
    !Number.isSafeInteger(value.occurrenceIndex) ||
    value.occurrenceIndex < 0
  ) {
    throw new Error("Thread occurrence cursor is invalid.")
  }
  return {
    threadId,
    searchTerm,
    seq: value.seq,
    itemId: value.itemId,
    occurrenceIndex: value.occurrenceIndex,
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
      DROP TABLE IF EXISTS search_messages;
      DROP TABLE IF EXISTS search_turns;
      DROP TABLE IF EXISTS search_threads;
    `)
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS search_threads (
      thread_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      metadata_size INTEGER NOT NULL,
      metadata_mtime_ms REAL NOT NULL,
      rollout_size INTEGER NOT NULL,
      rollout_mtime_ms REAL NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS search_messages (
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant')),
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS search_messages_order
    ON search_messages (thread_id, seq, item_id);

    CREATE TABLE IF NOT EXISTS search_turns (
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      last_tool_seq INTEGER NOT NULL DEFAULT -1,
      candidate_seq INTEGER,
      candidate_item_id TEXT,
      candidate_text TEXT,
      PRIMARY KEY (thread_id, turn_id)
    ) STRICT;

    PRAGMA user_version = ${schemaVersion};
  `)
}
