import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  createEventEnvelope,
  type EventEnvelope,
  type EventMetadata,
  EventType,
  type ForkReason,
  isJsonObject,
  isKernelEvent,
  type KernelEvent,
  type SessionCreatedEvent,
  type StoredEventEnvelope,
} from "./events.ts"
import type { SessionProjection } from "./session-projector.ts"

export type EventStore = {
  createSession(
    sessionId: string,
    created: SessionCreatedEvent,
  ): Promise<EventEnvelope>
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
  forkSession(
    input: EventStoreForkSessionInput,
  ): Promise<EventStoreForkSessionResult>
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
  deleteSession(sessionId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
}

export type EventStoreAppendOptions = {
  readonly expectedSeq?: number
  readonly admission?: {
    readonly requestId: string
    readonly fingerprint: string
  }
}

export type EventStoreForkSessionInput = {
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly atInputId: string
  readonly expectedSourceSeq: number
  readonly created: SessionCreatedEvent
  readonly initialEvents?: readonly KernelEvent[]
}

export type EventStoreForkSessionResult = {
  readonly historyEndSeqExclusive: number
  readonly events: readonly StoredEventEnvelope[]
  readonly localEvents: readonly StoredEventEnvelope[]
  readonly projection: SessionProjection
}

export type EventStoreReadEventsInput = {
  readonly after?: number
  readonly through?: number
  readonly limit?: number
}

export type EventStoreRebuildProjectionResult = {
  readonly events: readonly StoredEventEnvelope[]
  readonly projection?: SessionProjection
}

export type EventStoreListSessionsInput = {
  readonly limit?: number
  readonly cursor?: string
  readonly order?: "recent" | "created"
  readonly workingDirectory?: string
}

export type EventStoreListSessionsResult = {
  readonly sessions: readonly EventStoreSessionSummary[]
  readonly nextCursor?: string
}

export type EventStoreSessionSummary = {
  readonly sessionId: string
  readonly conversationId: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly forkedFromInputId?: string
  readonly forkReason?: ForkReason
  readonly metadata?: EventMetadata
}

export function requireAdmissionFingerprint(
  sessionId: string,
  admission: NonNullable<EventStoreAppendOptions["admission"]>,
  storedFingerprint: string,
): void {
  if (admission.fingerprint === storedFingerprint) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: `Request ${admission.requestId} was already admitted with different input.`,
    details: { sessionId, requestId: admission.requestId },
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

// An input admitted mid-turn sits between turn.started and its terminal
// event, so a fork cutting before that input can leave a turn permanently
// Started in the target Session — which would block its run lane forever.
// Close such turns with a synthetic turn.interrupted, the same shape Codex
// uses when a fork snapshot ends mid-turn.
export function appendForkCutTurnClosures(
  sessionId: string,
  events: StoredEventEnvelope[],
): void {
  const open = new Set<string>()
  for (const event of events) {
    if (!isKernelEvent(event)) continue
    if (event.type === EventType.TurnStarted) {
      open.add(event.data.turnId)
      continue
    }
    if (
      event.type === EventType.TurnCompleted ||
      event.type === EventType.TurnFailed ||
      event.type === EventType.TurnCancelled ||
      event.type === EventType.TurnInterrupted
    ) {
      open.delete(event.data.turnId)
    }
  }
  for (const turnId of open) {
    events.push(
      createEventEnvelope({
        sessionId,
        seq: events.length + 1,
        event: {
          type: EventType.TurnInterrupted,
          data: {
            turnId,
            reason: "The Session was forked before this Turn finished.",
          },
        },
      }),
    )
  }
}

export function summarizeSessionProjection(
  projection: SessionProjection,
): EventStoreSessionSummary {
  return {
    sessionId: projection.id,
    conversationId: projection.conversationId,
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
    ...(projection.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: projection.forkedFromInputId }),
    ...(projection.forkReason === undefined
      ? {}
      : { forkReason: projection.forkReason }),
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
  const filtered =
    input.workingDirectory === undefined
      ? summaries
      : summaries.filter(
          (summary) => summary.workingDirectory === input.workingDirectory,
        )
  const ordered = [...filtered].sort((left, right) => {
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

export function collapseSessionConversations(
  summaries: readonly EventStoreSessionSummary[],
): EventStoreSessionSummary[] {
  const groups = new Map<string, EventStoreSessionSummary[]>()
  for (const summary of summaries) {
    const group = groups.get(summary.conversationId)
    if (group === undefined) groups.set(summary.conversationId, [summary])
    else group.push(summary)
  }
  return [...groups.values()].flatMap((group) => {
    const continued = new Set(
      group.flatMap((summary) =>
        summary.parentSessionId === undefined ||
        summary.forkReason === undefined
          ? []
          : [summary.parentSessionId],
      ),
    )
    const leaves = group.filter((summary) => !continued.has(summary.sessionId))
    const candidates = leaves.length === 0 ? group : leaves
    const latest = candidates.reduce((current, summary) => {
      if (
        summary.updatedAt > current.updatedAt ||
        (summary.updatedAt === current.updatedAt &&
          summary.sessionId > current.sessionId)
      ) {
        return summary
      }
      return current
    })
    return [latest]
  })
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
