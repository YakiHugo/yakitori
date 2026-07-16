import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import {
  createMateEventEnvelope,
  isMateProfile,
  MateLifecycle,
  requireMateEvent,
  type MateEvent,
  type MateEventEnvelope,
} from "./events.ts"
import { isMateEventId, isMateId, isMateRevisionId } from "./ids.ts"
import {
  projectMate,
  summarizeMate,
  type MateSummary,
} from "./mate-projector.ts"
import type {
  MateStore,
  MateStoreAppendOptions,
  MateStoreListInput,
  MateStoreListResult,
} from "./mate-store.ts"

export type SqliteMateStore = MateStore & {
  close(): void
}

export type SqliteMateStoreOptions = {
  readonly databasePath?: string
  readonly rootDir?: string
}

type EventRow = { readonly envelope_json: string }
type MateIdRow = { readonly mate_id: string }
type SequenceRow = { readonly seq: number }
type SummaryRow = {
  readonly mate_id: string
  readonly summary_json: string
}

export function createSqliteMateStore(
  options: SqliteMateStoreOptions = {},
): SqliteMateStore {
  const databasePath =
    options.databasePath ??
    join(options.rootDir ?? ".yakitori", "events.sqlite")
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  const database = new DatabaseSync(databasePath)
  initializeDatabase(database)

  return {
    async appendEvent(mateId, event, options = {}) {
      requireMateId(mateId)
      database.exec("BEGIN IMMEDIATE")
      try {
        const actualSeq = readSequence(database, mateId)
        requireExpectedSequence(mateId, options, actualSeq)
        const envelope = createMateEventEnvelope({
          event,
          mateId,
          seq: actualSeq + 1,
        })
        database
          .prepare(`
            INSERT INTO mate_events (mate_id, seq, event_id, envelope_json)
            VALUES (?, ?, ?, ?)
          `)
          .run(mateId, envelope.seq, envelope.id, JSON.stringify(envelope))
        updateMateSummary(database, mateId)
        database.exec("COMMIT")
        return envelope
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    },

    async listMates(input = {}) {
      return listMates(database, input)
    },

    async readEvents(mateId) {
      requireMateId(mateId)
      return readEvents(database, mateId)
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
      CREATE TABLE IF NOT EXISTS mate_events (
        mate_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        PRIMARY KEY (mate_id, seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mate_summaries (
        mate_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL
      ) STRICT;
    `)
    const enableDefensive = Reflect.get(database, "enableDefensive")
    if (typeof enableDefensive === "function") {
      Reflect.apply(enableDefensive, database, [true])
    }
  } catch (error) {
    if (database.isOpen) database.close()
    throw error
  }
}

function listMates(
  database: DatabaseSync,
  input: MateStoreListInput,
): MateStoreListResult {
  const limit = requireListLimit(input.limit)
  if (input.cursor !== undefined) requireStoredMateId(database, input.cursor)
  const rows = database
    .prepare(`
      SELECT mate_id, summary_json
      FROM mate_summaries
      WHERE mate_id > ?
      ORDER BY mate_id
      LIMIT ?
    `)
    .all(input.cursor ?? "", limit + 1) as SummaryRow[]
  const page = rows.slice(0, limit)
  return {
    mates: page.map((row) => parseMateSummary(row.summary_json, row.mate_id)),
    ...(rows.length <= limit || page.length === 0
      ? {}
      : { nextCursor: requireLastMateId(page.map((row) => row.mate_id)) }),
  }
}

function updateMateSummary(database: DatabaseSync, mateId: string): void {
  const mate = projectMate(readEvents(database, mateId))
  if (!mate) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: `Mate ${mateId} did not produce a summary.`,
      details: { mateId },
    })
  }
  database
    .prepare(`
      INSERT INTO mate_summaries (mate_id, summary_json)
      VALUES (?, ?)
      ON CONFLICT (mate_id) DO UPDATE SET summary_json = excluded.summary_json
    `)
    .run(mateId, JSON.stringify(summarizeMate(mate)))
}

function readEvents(
  database: DatabaseSync,
  mateId: string,
): MateEventEnvelope[] {
  const events = (
    database
      .prepare(`
        SELECT envelope_json
        FROM mate_events
        WHERE mate_id = ?
        ORDER BY seq
      `)
      .all(mateId) as EventRow[]
  ).map((row, index) => parseMateEventEnvelope(row.envelope_json, index + 1))
  requireStoredEventRange(mateId, events)
  return events
}

function parseMateSummary(serialized: string, mateId: string): MateSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw invalidEventLog("Invalid mate summary JSON.", { mateId }, error)
  }
  const currentRevision =
    isRecord(parsed) && isStoredMateRevision(parsed.currentRevision)
      ? copyStoredMateRevision(parsed.currentRevision)
      : undefined
  if (
    !isRecord(parsed) ||
    parsed.id !== mateId ||
    !isMateId(mateId) ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.updatedAt !== "string" ||
    !isPositiveInteger(parsed.seq) ||
    !Object.values(MateLifecycle).includes(parsed.lifecycle as MateLifecycle) ||
    !currentRevision
  ) {
    throw invalidEventLog("Invalid mate summary.", { mateId })
  }
  return {
    createdAt: parsed.createdAt,
    currentRevision,
    id: mateId,
    lifecycle: parsed.lifecycle as MateLifecycle,
    seq: parsed.seq,
    updatedAt: parsed.updatedAt,
  }
}

function copyStoredMateRevision(
  value: Record<string, unknown>,
): MateSummary["currentRevision"] {
  return {
    createdAt: value.createdAt as string,
    id: value.id as string,
    instructions: value.instructions as string,
    name: value.name as string,
    revision: value.revision as number,
    role: value.role as string,
  }
}

function isStoredMateRevision(
  value: unknown,
): value is MateSummary["currentRevision"] {
  if (!isRecord(value)) return false
  return (
    typeof value.createdAt === "string" &&
    typeof value.id === "string" &&
    isMateRevisionId(value.id) &&
    isPositiveInteger(value.revision) &&
    isMateProfile({
      instructions: value.instructions,
      name: value.name,
      role: value.role,
    })
  )
}

function requireLastMateId(mateIds: readonly string[]): string {
  const mateId = mateIds.at(-1)
  if (mateId) return mateId
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: "Expected a mate list cursor.",
  })
}

function parseMateEventEnvelope(
  serialized: string,
  recordNumber: number,
): MateEventEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw invalidEventLog(
      `Invalid mate event JSON at record ${recordNumber}.`,
      { recordNumber },
      error,
    )
  }
  if (!isRecord(parsed)) {
    throw invalidEventLog(`Invalid mate event at record ${recordNumber}.`, {
      recordNumber,
    })
  }
  if (
    typeof parsed.id !== "string" ||
    !isMateEventId(parsed.id) ||
    typeof parsed.mateId !== "string" ||
    !isMateId(parsed.mateId) ||
    !isPositiveInteger(parsed.seq) ||
    !isPositiveInteger(parsed.version) ||
    typeof parsed.createdAt !== "string" ||
    !isRecord(parsed.data)
  ) {
    throw invalidEventLog(
      `Invalid mate event envelope at record ${recordNumber}.`,
      { recordNumber },
    )
  }
  const event = requireStoredMateEvent(parsed.type, parsed.data, recordNumber)
  return {
    createdAt: parsed.createdAt,
    id: parsed.id,
    mateId: parsed.mateId,
    seq: parsed.seq,
    version: parsed.version,
    ...event,
  }
}

function requireStoredMateEvent(
  type: unknown,
  data: Record<string, unknown>,
  recordNumber: number,
): MateEvent {
  try {
    return requireMateEvent({ type, data })
  } catch (error) {
    throw invalidEventLog(
      `Invalid mate event data at record ${recordNumber}.`,
      { recordNumber },
      error,
    )
  }
}

function requireStoredEventRange(
  mateId: string,
  events: readonly MateEventEnvelope[],
): void {
  for (const [index, event] of events.entries()) {
    if (event.mateId === mateId && event.seq === index + 1) continue
    throw invalidEventLog(
      "Stored mate events must be gap-free and match their mate.",
      {
        actualMateId: event.mateId,
        actualSeq: event.seq,
        expectedMateId: mateId,
        expectedSeq: index + 1,
      },
    )
  }
}

function requireExpectedSequence(
  mateId: string,
  options: MateStoreAppendOptions,
  actualSeq: number,
): void {
  if (options.expectedSeq === undefined || options.expectedSeq === actualSeq) {
    return
  }
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: `Mate ${mateId} changed before the operation could commit.`,
    details: { actualSeq, expectedSeq: options.expectedSeq, mateId },
  })
}

function requireListLimit(value: number | undefined): number {
  if (value === undefined) return 50
  if (Number.isInteger(value) && value > 0 && value <= 100) return value
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate list limit must be an integer from 1 to 100.",
    details: { limit: value },
  })
}

function requireStoredMateId(database: DatabaseSync, mateId: string): void {
  requireMateId(mateId)
  const row = database
    .prepare("SELECT mate_id FROM mate_summaries WHERE mate_id = ? LIMIT 1")
    .get(mateId) as MateIdRow | undefined
  if (row) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate list cursor is invalid.",
    details: { cursor: mateId },
  })
}

function requireMateId(mateId: string): void {
  if (isMateId(mateId)) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate id is invalid.",
    details: { mateId },
  })
}

function readSequence(database: DatabaseSync, mateId: string): number {
  return (
    database
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM mate_events WHERE mate_id = ?",
      )
      .get(mateId) as SequenceRow
  ).seq
}

function invalidEventLog(
  message: string,
  details: Record<string, string | number>,
  cause?: unknown,
) {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidEventLog,
    message,
    details,
    ...(cause === undefined ? {} : { cause }),
  })
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
