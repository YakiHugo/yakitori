import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  assertEventStoreSessionId,
  assertStoredEventRange,
  assertStoredSessionEvents,
  type EventStore,
  type EventStoreAppendOptions,
  paginateSessionSummaries,
  parseStoredEventEnvelope,
  requireExpectedSequence,
  requireOperationFingerprint,
  summarizeStoredSession,
} from "./event-store.ts"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  createEventEnvelope,
  type EventEnvelope,
  type KernelEvent,
} from "./events.ts"

export type SqliteEventStore = EventStore & {
  close(): void
}

export type SqliteEventStoreOptions = {
  readonly databasePath?: string
  readonly rootDir?: string
}

type EventRow = {
  readonly envelope_json: string
}

type OperationRow = {
  readonly event_count: number
  readonly fingerprint: string
  readonly first_seq: number
}

type SequenceRow = {
  readonly seq: number
}

type SessionRow = {
  readonly session_id: string
}

export function createSqliteEventStore(
  options: SqliteEventStoreOptions = {},
): SqliteEventStore {
  const databasePath =
    options.databasePath ??
    join(options.rootDir ?? ".yakitori", "events.sqlite")
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  const database = new DatabaseSync(databasePath)
  initializeDatabase(database)

  return {
    async appendEvent(sessionId, event, appendOptions) {
      const envelopes = appendEvents(
        database,
        sessionId,
        [event],
        appendOptions,
      )
      const envelope = envelopes.at(0)
      if (envelope) return envelope
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Expected one appended event.",
        details: { sessionId },
      })
    },

    async appendEvents(sessionId, events, appendOptions) {
      return appendEvents(database, sessionId, events, appendOptions)
    },

    async readEvents(sessionId) {
      assertEventStoreSessionId(sessionId)
      return readEvents(database, sessionId)
    },

    async listSessions(input = {}) {
      const summaries = (
        database
          .prepare("SELECT DISTINCT session_id FROM events")
          .all() as SessionRow[]
      )
        .map((row) =>
          summarizeStoredSession(
            row.session_id,
            readEvents(database, row.session_id),
          ),
        )
        .filter((summary) => summary !== undefined)
        .sort((left, right) => {
          const updatedAt = right.updatedAt.localeCompare(left.updatedAt)
          if (updatedAt !== 0) return updatedAt
          return left.sessionId.localeCompare(right.sessionId)
        })

      return paginateSessionSummaries(summaries, input)
    },

    close() {
      if (database.isOpen) database.close()
    },
  }
}

function initializeDatabase(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = FULL")
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operations (
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seq INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        PRIMARY KEY (session_id, operation_id)
      ) STRICT;
    `)

    // This API arrived after node:sqlite, so keep the declared Node 24 floor.
    const enableDefensive = Reflect.get(database, "enableDefensive")
    if (typeof enableDefensive === "function") {
      Reflect.apply(enableDefensive, database, [true])
    }
  } catch (error) {
    if (database.isOpen) database.close()
    throw error
  }
}

function appendEvents(
  database: DatabaseSync,
  sessionId: string,
  events: readonly KernelEvent[],
  options: EventStoreAppendOptions = {},
): EventEnvelope[] {
  assertEventStoreSessionId(sessionId)
  if (events.length === 0) return []

  database.exec("BEGIN IMMEDIATE")
  try {
    if (options.operation !== undefined) {
      const stored = readOperation(database, sessionId, options.operation.id)
      if (stored !== undefined) {
        requireOperationFingerprint(
          sessionId,
          options.operation,
          stored.fingerprint,
        )
        const replayed = readEventRange(
          database,
          sessionId,
          stored.first_seq,
          stored.event_count,
        )
        database.exec("COMMIT")
        return replayed
      }
    }

    const actualSeq = readSequence(database, sessionId)
    requireExpectedSequence(sessionId, options.expectedSeq, actualSeq)
    const envelopes = events.map((event, index) =>
      createEventEnvelope({
        sessionId,
        seq: actualSeq + index + 1,
        event,
      }),
    )
    const insertEvent = database.prepare(`
      INSERT INTO events (session_id, seq, event_id, envelope_json)
      VALUES (?, ?, ?, ?)
    `)
    for (const envelope of envelopes) {
      insertEvent.run(
        envelope.sessionId,
        envelope.seq,
        envelope.id,
        JSON.stringify(envelope),
      )
    }

    if (options.operation !== undefined) {
      database
        .prepare(`
          INSERT INTO operations (
            session_id,
            operation_id,
            fingerprint,
            first_seq,
            event_count
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          sessionId,
          options.operation.id,
          options.operation.fingerprint,
          actualSeq + 1,
          envelopes.length,
        )
    }

    database.exec("COMMIT")
    return envelopes
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw error
  }
}

function readEvents(
  database: DatabaseSync,
  sessionId: string,
): EventEnvelope[] {
  const events = (
    database
      .prepare(
        "SELECT envelope_json FROM events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as EventRow[]
  ).map((row, index) => parseStoredEventEnvelope(row.envelope_json, index + 1))
  assertStoredSessionEvents(sessionId, events)
  return events
}

function readEventRange(
  database: DatabaseSync,
  sessionId: string,
  firstSeq: number,
  eventCount: number,
): EventEnvelope[] {
  const events = (
    database
      .prepare(`
        SELECT envelope_json
        FROM events
        WHERE session_id = ? AND seq >= ? AND seq < ?
        ORDER BY seq
      `)
      .all(sessionId, firstSeq, firstSeq + eventCount) as EventRow[]
  ).map((row, index) =>
    parseStoredEventEnvelope(row.envelope_json, firstSeq + index),
  )
  if (events.length !== eventCount) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidEventLog,
      message: `Operation receipt for ${sessionId} references missing events.`,
      details: {
        sessionId,
        firstSeq,
        eventCount,
        actualCount: events.length,
      },
    })
  }
  assertStoredEventRange(sessionId, events, firstSeq)
  return events
}

function readOperation(
  database: DatabaseSync,
  sessionId: string,
  operationId: string,
): OperationRow | undefined {
  return database
    .prepare(`
      SELECT fingerprint, first_seq, event_count
      FROM operations
      WHERE session_id = ? AND operation_id = ?
    `)
    .get(sessionId, operationId) as OperationRow | undefined
}

function readSequence(database: DatabaseSync, sessionId: string): number {
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?",
    )
    .get(sessionId) as SequenceRow
  return row.seq
}
