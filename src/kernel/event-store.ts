import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  isJsonObject,
  type EventEnvelope,
  type EventMetadata,
  type KernelEvent,
  type StoredEventEnvelope,
} from "./events.ts"
import type { SessionProjection } from "./session-projector.ts"

export type EventStore = {
  appendEvent(
    sessionId: string,
    event: KernelEvent,
    options?: EventStoreAppendOptions,
  ): Promise<EventEnvelope>
  appendEvents(
    sessionId: string,
    events: readonly KernelEvent[],
    options?: EventStoreAppendOptions,
  ): Promise<EventEnvelope[]>
  readEvents(
    sessionId: string,
    input?: EventStoreReadEventsInput,
  ): Promise<StoredEventEnvelope[]>
  readProjection(sessionId: string): Promise<SessionProjection | undefined>
  rebuildProjection(
    sessionId: string,
  ): Promise<EventStoreRebuildProjectionResult>
  listSessions(
    input?: EventStoreListSessionsInput,
  ): Promise<EventStoreListSessionsResult>
}

export type EventStoreAppendOptions = {
  readonly expectedSeq?: number
  readonly operation?: {
    readonly id: string
    readonly fingerprint: string
  }
}

export type EventStoreReadEventsInput = {
  readonly after?: number
}

export type EventStoreRebuildProjectionResult = {
  readonly events: readonly StoredEventEnvelope[]
  readonly projection?: SessionProjection
}

export type EventStoreListSessionsInput = {
  readonly limit?: number
  readonly cursor?: string
  readonly order?: "recent" | "created"
}

export type EventStoreListSessionsResult = {
  readonly sessions: readonly EventStoreSessionSummary[]
  readonly nextCursor?: string
}

export type EventStoreSessionSummary = {
  readonly sessionId: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export function requireOperationFingerprint(
  sessionId: string,
  operation: NonNullable<EventStoreAppendOptions["operation"]>,
  storedFingerprint: string,
): void {
  if (operation.fingerprint === storedFingerprint) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: `Operation ${operation.id} was already used with different input.`,
    details: { sessionId, operationId: operation.id },
  })
}

export function requireExpectedSequence(
  sessionId: string,
  expectedSeq: number | undefined,
  actualSeq: number,
): void {
  if (expectedSeq === undefined || expectedSeq === actualSeq) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: `Session ${sessionId} changed before the operation could commit.`,
    details: { sessionId, expectedSeq, actualSeq },
  })
}

export function summarizeSessionProjection(
  projection: SessionProjection,
): EventStoreSessionSummary {
  return {
    sessionId: projection.id,
    seq: projection.seq,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    ...(projection.title === undefined ? {} : { title: projection.title }),
    ...(projection.workingDirectory === undefined
      ? {}
      : { workingDirectory: projection.workingDirectory }),
    ...(projection.mateId === undefined ? {} : { mateId: projection.mateId }),
    ...(projection.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: projection.mateRevisionId }),
    ...(projection.parentSessionId === undefined
      ? {}
      : { parentSessionId: projection.parentSessionId }),
    ...(projection.metadata === undefined
      ? {}
      : { metadata: projection.metadata }),
  }
}

export function paginateSessionSummaries(
  summaries: readonly EventStoreSessionSummary[],
  input: EventStoreListSessionsInput = {},
): EventStoreListSessionsResult {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidArgument,
      message: "Session list limit must be an integer from 1 to 100.",
    })
  }
  const order = input.order ?? "recent"
  const ordered = [...summaries].sort((left, right) => {
    const timestamp =
      order === "created"
        ? left.createdAt.localeCompare(right.createdAt)
        : right.updatedAt.localeCompare(left.updatedAt)
    if (timestamp !== 0) return timestamp
    return left.sessionId.localeCompare(right.sessionId)
  })
  const start =
    input.cursor === undefined
      ? 0
      : ordered.findIndex(
          (summary) => sessionSummaryCursor(summary, order) === input.cursor,
        ) + 1
  if (input.cursor !== undefined && start === 0) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidArgument,
      message: "Invalid Session list cursor.",
      details: { cursor: input.cursor },
    })
  }
  const sessions = ordered.slice(start, start + limit)
  const last = sessions.at(-1)
  return {
    sessions,
    ...(last !== undefined && start + limit < ordered.length
      ? { nextCursor: sessionSummaryCursor(last, order) }
      : {}),
  }
}

export function parseStoredEventEnvelope(
  serialized: string,
  recordNumber: number,
): StoredEventEnvelope {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (cause) {
    throw invalidEventLog(
      `Invalid event JSON at record ${recordNumber}.`,
      {
        recordNumber,
      },
      cause,
    )
  }
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    !isPositiveInteger(value.seq) ||
    !isPositiveInteger(value.version) ||
    typeof value.createdAt !== "string" ||
    typeof value.type !== "string" ||
    !isJsonObject(value.data)
  ) {
    throw invalidEventLog(`Invalid event envelope at record ${recordNumber}.`, {
      recordNumber,
    })
  }
  return value as StoredEventEnvelope
}

export function assertEventStoreSessionId(sessionId: string): void {
  if (
    /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      sessionId,
    )
  )
    return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: `Invalid session id ${sessionId}.`,
    details: { sessionId },
  })
}

function sessionSummaryCursor(
  summary: EventStoreSessionSummary,
  order: "recent" | "created",
): string {
  return `${order}\t${order === "created" ? summary.createdAt : summary.updatedAt}\t${summary.sessionId}`
}

function invalidEventLog(
  message: string,
  details: EventMetadata,
  cause?: unknown,
): Error {
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
