import { randomUUID } from "node:crypto"
import {
  type FileHandle,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  type EventStoreSessionSummary,
  parseStoredEventEnvelope,
} from "./event-store.ts"
import { isJsonObject, type StoredEventEnvelope } from "./events.ts"

export const journalRecordVersion = 1
export const summaryVersion = 1

export type JournalOperation = {
  readonly id: string
  readonly fingerprint: string
}

export type JournalCommitRecord = {
  readonly record: "commit"
  readonly version: typeof journalRecordVersion
  readonly sessionId: string
  readonly firstSeq: number
  readonly operation?: JournalOperation
  readonly events: readonly StoredEventEnvelope[]
}

export type JournalLine = JournalCommitRecord | StoredEventEnvelope

export type SessionSummaryCache = EventStoreSessionSummary & {
  readonly version: typeof summaryVersion
  readonly journalBytes: number
}

export function parseCommitRecord(
  serialized: string,
  recordNumber: number,
): JournalCommitRecord {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (cause) {
    throw invalidEventLog(
      `Invalid Session journal JSON at record ${recordNumber}.`,
      { recordNumber },
      cause,
    )
  }
  if (
    !isRecord(value) ||
    value.record !== "commit" ||
    value.version !== journalRecordVersion ||
    typeof value.sessionId !== "string" ||
    !isPositiveInteger(value.firstSeq) ||
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    !isOptionalJournalOperation(value.operation)
  ) {
    throw invalidEventLog(`Invalid Session journal record ${recordNumber}.`, {
      recordNumber,
    })
  }
  return value as JournalCommitRecord
}

export function serializeFactLine(envelope: StoredEventEnvelope): string {
  return `${JSON.stringify(envelope)}\n`
}

export function parseJournalLine(
  serialized: string,
  recordNumber: number,
): JournalLine {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (cause) {
    throw invalidEventLog(
      `Invalid Session journal JSON at record ${recordNumber}.`,
      { recordNumber },
      cause,
    )
  }
  if (isRecord(value) && Object.hasOwn(value, "record")) {
    return parseCommitRecord(serialized, recordNumber)
  }
  if (!isFactEnvelopeRecord(value)) {
    throw invalidEventLog(`Invalid Session fact at record ${recordNumber}.`, {
      recordNumber,
    })
  }
  return parseStoredEventEnvelope(serialized, recordNumber)
}

export async function readSummaryCache(
  path: string,
): Promise<SessionSummaryCache | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined
    throw error
  }
  if (
    !isRecord(value) ||
    value.version !== summaryVersion ||
    !Number.isSafeInteger(value.journalBytes) ||
    (value.journalBytes as number) < 0 ||
    typeof value.sessionId !== "string" ||
    !isPositiveInteger(value.seq) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !optionalString(value.title) ||
    !optionalString(value.workingDirectory) ||
    !optionalString(value.mateId) ||
    !optionalString(value.mateRevisionId) ||
    !optionalString(value.parentSessionId) ||
    (value.metadata !== undefined && !isJsonObject(value.metadata))
  ) {
    return undefined
  }
  return value as SessionSummaryCache
}

export function summaryWithoutCacheFields(
  cached: SessionSummaryCache,
): EventStoreSessionSummary {
  return {
    sessionId: cached.sessionId,
    seq: cached.seq,
    createdAt: cached.createdAt,
    updatedAt: cached.updatedAt,
    ...(cached.title === undefined ? {} : { title: cached.title }),
    ...(cached.workingDirectory === undefined
      ? {}
      : { workingDirectory: cached.workingDirectory }),
    ...(cached.mateId === undefined ? {} : { mateId: cached.mateId }),
    ...(cached.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: cached.mateRevisionId }),
    ...(cached.parentSessionId === undefined
      ? {}
      : { parentSessionId: cached.parentSessionId }),
    ...(cached.metadata === undefined ? {} : { metadata: cached.metadata }),
  }
}

export async function writeSummaryCache(
  target: string,
  directory: string,
  summary: SessionSummaryCache,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    try {
      await writeAll(handle, Buffer.from(`${JSON.stringify(summary)}\n`))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    await syncDirectory(directory)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw cause
  }
}

export async function writeAll(
  handle: FileHandle,
  bytes: Buffer,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (result.bytesWritten === 0) {
      throw new Error("Session journal write made no progress.")
    }
    offset += result.bytesWritten
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

export function invalidEventLog(
  message: string,
  details: Record<string, string | number>,
  cause?: unknown,
): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidEventLog,
    message,
    details,
    ...(cause === undefined ? {} : { cause }),
  })
}

export function isJournalOperation(value: unknown): value is JournalOperation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.fingerprint === "string" &&
    value.fingerprint.length > 0
  )
}

function isOptionalJournalOperation(value: unknown): boolean {
  return value === undefined || isJournalOperation(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFactEnvelopeRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === factEnvelopeKeys.size &&
    keys.every((key) => factEnvelopeKeys.has(key))
  )
}

const factEnvelopeKeys = new Set([
  "id",
  "sessionId",
  "seq",
  "version",
  "createdAt",
  "type",
  "data",
])
