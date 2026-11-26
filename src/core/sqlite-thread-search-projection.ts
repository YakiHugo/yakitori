import type { DatabaseSync } from "node:sqlite"
import { answerTextParts } from "../protocol/model-output.ts"
import { parseSessionPlan } from "../protocol/user-interaction.ts"
import type { StoredRolloutItem, ThreadStatusProjection } from "./rollout.ts"
import {
  projectedThreadSummary,
  type ProjectedThreadRow,
  SqliteRolloutProjection,
} from "./sqlite-rollout-projection.ts"
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

type MessageRow = Readonly<{
  seq: number
  item_id: string
  turn_id: string
  text: string
  result_item_id?: string | null
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
  toolActivity?: boolean
}>

export class SqliteThreadSearchProjection extends SqliteRolloutProjection {
  constructor(databasePath: string) {
    super(databasePath, 16, dropSearchTables, createSearchTables)
    this.database.function(
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

  protected applyEntries(
    threadId: string,
    entries: readonly StoredRolloutItem[],
    _locations: unknown,
    previous: ThreadStatusProjection,
  ): void {
    applySearchEntries(this.database, threadId, entries, previous.activeTurnId)
  }

  searchThreads(
    input: ThreadStoreSearchInput &
      Readonly<{
        threadIds?: readonly string[]
        titles?: Readonly<Record<string, string>>
      }>,
  ): ThreadStoreSearchResult {
    const anchor =
      input.cursor === undefined ? undefined : parseThreadCursor(input.cursor)
    const filter =
      input.threadIds === undefined
        ? ""
        : " AND thread_id IN (SELECT value FROM json_each(?))"
    const parameters = [
      JSON.stringify(input.titles ?? {}),
      input.searchTerm,
      input.searchTerm,
      ...(input.threadIds === undefined
        ? []
        : [JSON.stringify(input.threadIds)]),
    ]
    const rows = (
      anchor === undefined
        ? this.database
            .prepare(
              `${matchingThreadsSql(input.toolActivity)}${filter} ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
            )
            .all(...parameters, input.limit + 1)
        : this.database
            .prepare(`${matchingThreadsSql(input.toolActivity)}${filter}
            AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
            ORDER BY updated_at DESC, thread_id DESC
            LIMIT ?
          `)
            .all(
              ...parameters,
              anchor.updatedAt,
              anchor.updatedAt,
              anchor.id,
              input.limit + 1,
            )
    ) as ProjectedThreadRow[]
    const page = rows.slice(0, input.limit)
    const matches = page.map((row) => {
      const summary = projectedThreadSummary(row)
      return {
        summary,
        ...this.#firstMatch(
          row,
          summary.rolloutId,
          input.searchTerm,
          input.toolActivity,
        ),
      }
    })
    const last = page.at(-1)
    return {
      matches,
      ...(rows.length <= input.limit || last === undefined
        ? {}
        : { nextCursor: threadCursor(projectedThreadSummary(last)) }),
    }
  }

  searchThreadOccurrences(
    input: ThreadStoreOccurrenceSearchInput,
  ): ThreadStoreOccurrenceSearchResult | undefined {
    if (
      this.database
        .prepare("SELECT 1 FROM projection_threads WHERE thread_id = ?")
        .get(input.threadId) === undefined
    ) {
      return undefined
    }
    let cursor =
      input.cursor === undefined
        ? undefined
        : parseOccurrenceCursor(
            input.cursor,
            input.threadId,
            input.searchTerm,
            input.toolActivity,
          )
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
              ...(input.toolActivity ? { toolActivity: true } : {}),
            } satisfies OccurrenceCursor),
          }
        }
        occurrences.push({
          turnId: row.turn_id,
          itemId: row.item_id,
          ...(row.result_item_id == null
            ? {}
            : { resultItemId: row.result_item_id }),
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
    const kind = searchedKind(input.toolActivity)
    if (cursor !== undefined) {
      return this.database
        .prepare(`
          SELECT seq, item_id, turn_id, text, result_item_id
          FROM search_messages
          WHERE thread_id = ? AND ${kind} AND literal_match(text, ?) = 1
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
      return this.database
        .prepare(`
          SELECT seq, item_id, turn_id, text, result_item_id
          FROM search_messages
          WHERE thread_id = ? AND ${kind} AND literal_match(text, ?) = 1
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
    return this.database
      .prepare(`
        SELECT seq, item_id, turn_id, text, result_item_id
        FROM search_messages
        WHERE thread_id = ? AND ${kind} AND literal_match(text, ?) = 1
        ORDER BY seq ASC, item_id ASC
        LIMIT 1
      `)
      .get(input.threadId, input.searchTerm) as MessageRow | undefined
  }

  #firstMatch(
    row: ProjectedThreadRow,
    rolloutId: string,
    searchTerm: string,
    toolActivity: boolean | undefined,
  ) {
    const titleMatch = toolActivity
      ? undefined
      : literalMatches(row.title, searchTerm, 1)[0]
    if (titleMatch !== undefined)
      return { snippet: snippetForMatch(row.title, titleMatch).snippet }
    const message = this.database
      .prepare(`
        SELECT seq, item_id, turn_id, text, result_item_id
        FROM search_messages
        WHERE thread_id = ? AND ${searchedKind(toolActivity)} AND literal_match(text, ?) = 1
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
    return {
      snippet: snippetForMatch(message.text, match).snippet,
      location: {
        rolloutId,
        turnId: message.turn_id,
        itemId: message.item_id,
        ...(message.result_item_id == null
          ? {}
          : { resultItemId: message.result_item_id }),
      },
    }
  }
}

function searchedKind(toolActivity: boolean | undefined): string {
  return toolActivity ? "kind = 'tool'" : "kind IN ('user', 'assistant')"
}

function matchingThreadsSql(toolActivity: boolean | undefined): string {
  return `
    WITH presented AS (
      SELECT thread_id, metadata_json, status_json, seq, updated_at,
        COALESCE((SELECT value FROM json_each(?) WHERE key = projection_threads.thread_id), title) AS title
      FROM projection_threads
    )
    SELECT thread_id, metadata_json, status_json, seq, title
    FROM presented AS thread
    WHERE ((${toolActivity ? "0" : "1"} AND literal_match(title, ?) = 1) OR EXISTS (
      SELECT 1
      FROM search_messages AS message
      WHERE message.thread_id = thread.thread_id
        AND ${searchedKind(toolActivity)}
        AND literal_match(message.text, ?) = 1
    ))
  `
}

function applySearchEntries(
  database: DatabaseSync,
  threadId: string,
  entries: readonly StoredRolloutItem[],
  activeTurnId: string | undefined,
): void {
  for (const record of entries) {
    if (record.item.type === "turn_started") activeTurnId = record.item.turnId
    if (
      record.item.type === "turn_completed" &&
      record.item.turnId === activeTurnId
    )
      activeTurnId = undefined
    if (
      record.item.type === "item_completed" &&
      record.item.item.type === "hosted_tool"
    ) {
      const { item, turnId } = record.item
      const { kind, label, detail } = item.tool
      insertMessage(
        database,
        threadId,
        record.seq,
        turnId,
        item.itemId,
        "tool",
        [
          label,
          kind === "web_search" || kind === "web_fetch" ? detail : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      continue
    }
    if (
      record.item.type === "item_completed" &&
      "resultItemId" in record.item.item
    ) {
      const { item, turnId } = record.item
      const plan =
        item.name === "update_plan" &&
        item.error === undefined &&
        "output" in item
          ? parseSessionPlan(item.output)
          : undefined
      const paths =
        item.type === "file_change"
          ? item.request.paths
          : item.type === "file_read" || item.type === "file_search"
            ? [item.path]
            : []
      insertMessage(
        database,
        threadId,
        record.seq,
        turnId,
        item.itemId,
        "tool",
        [
          item.name,
          ...paths,
          item.error?.code,
          plan?.explanation,
          ...(plan?.plan.map(({ step }) => step) ?? []),
        ]
          .filter(Boolean)
          .join("\n"),
        plan === undefined ? item.resultItemId : null,
      )
      continue
    }
    if (record.item.type === "response_item") {
      const envelope = record.item.item
      const message = envelope.item
      if (message.role === "user" && message.context === undefined) {
        insertMessage(
          database,
          threadId,
          record.seq,
          activeTurnId ?? envelope.turnId,
          envelope.id,
          "user",
          // User messages are displayed verbatim; only assistant answers render
          // Markdown. Keep source punctuation, destinations and whitespace.
          message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
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
        const rawText = answerTextParts(
          message.content.filter((block) => block.type === "text"),
        )
          .map((block) => block.text)
          .join("")
        database
          .prepare(`
          INSERT INTO search_answer_items (thread_id, turn_id, item_id, seq, text)
          VALUES (?, ?, ?, ?, ?)
        `)
          .run(threadId, envelope.turnId, envelope.id, record.seq, rawText)
        const text = markdownVisibleText(rawText)
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
    if (record.item.completion?.answerItemIds !== undefined) {
      const turnId = record.item.turnId
      const pieces = record.item.completion.answerItemIds.map((id) => {
        const item = database
          .prepare(`
          SELECT seq, turn_id, item_id, text FROM search_answer_items
          WHERE thread_id = ? AND turn_id = ? AND item_id = ?
        `)
          .get(threadId, turnId, id) as MessageRow | undefined
        if (item === undefined) {
          throw new Error(
            `Turn answer references missing assistant item ${id}.`,
          )
        }
        return item
      })
      const anchor = pieces.at(-1)
      const text = markdownVisibleText(
        pieces.map((piece) => piece.text).join(""),
      )
      if (anchor !== undefined && text !== "") {
        insertMessage(
          database,
          threadId,
          anchor.seq,
          turnId,
          anchor.item_id,
          "assistant",
          text,
        )
      }
      continue
    }
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
  kind: "assistant" | "user" | "tool",
  text: string,
  resultItemId: string | null = null,
): void {
  database
    .prepare(`
      INSERT INTO search_messages (thread_id, seq, turn_id, item_id, kind, text, result_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, item_id)
      DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id,
                    kind = excluded.kind, text = excluded.text, result_item_id = excluded.result_item_id
    `)
    .run(threadId, seq, turnId, itemId, kind, text, resultItemId)
}

function parseOccurrenceCursor(
  cursor: string,
  threadId: string,
  searchTerm: string,
  toolActivity: boolean | undefined,
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
    ("toolActivity" in value && value.toolActivity === true) !==
      Boolean(toolActivity) ||
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

function dropSearchTables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS search_answer_items;
    DROP TABLE IF EXISTS display_records;
    DROP TABLE IF EXISTS transcript_locations;
    DROP TABLE IF EXISTS rollout_checkpoints;
    DROP TABLE IF EXISTS search_messages;
    DROP TABLE IF EXISTS search_turns;
    DROP TABLE IF EXISTS search_threads;
  `)
}

function createSearchTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS search_messages (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool')),
      text TEXT NOT NULL,
      result_item_id TEXT,
      PRIMARY KEY (thread_id, item_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS search_messages_order
    ON search_messages (thread_id, seq, item_id);

    CREATE TABLE IF NOT EXISTS search_answer_items (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS search_turns (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      last_tool_seq INTEGER NOT NULL DEFAULT -1,
      candidate_seq INTEGER,
      candidate_item_id TEXT,
      candidate_text TEXT,
      PRIMARY KEY (thread_id, turn_id)
    ) STRICT;

  `)
}
