import {
  createEventEnvelope,
  createYakitoriError,
  EventType,
  type EventEnvelope,
  type EventStore,
  type EventStoreAppendOptions,
  type EventStoreListSessionsInput,
  type EventStoreListSessionsResult,
  type EventStoreSessionSummary,
  type EventMetadata,
  type KernelEvent,
  YakitoriErrorCode,
} from "../../src/index.ts"
import {
  requireExpectedSequence,
  requireOperationFingerprint,
} from "../../src/kernel/event-store.ts"

type MemoryOperationRecord = {
  readonly eventCount: number
  readonly fingerprint: string
  readonly firstSeq: number
}

export function createMemoryEventStore(): EventStore {
  const sessions = new Map<string, EventEnvelope[]>()
  const operations = new Map<string, MemoryOperationRecord>()

  return {
    async appendEvent(sessionId, event, options) {
      const envelopes = await appendEvents(sessionId, [event], options)
      const envelope = envelopes.at(0)
      if (!envelope) throw new Error("Expected one appended event.")
      return envelope
    },

    appendEvents,

    async readEvents(sessionId) {
      return [...(sessions.get(sessionId) ?? [])]
    },

    async listSessions(input = {}) {
      const summaries = Array.from(sessions.entries())
        .map(([sessionId, events]) => createSessionSummary(sessionId, events))
        .filter((summary): summary is EventStoreSessionSummary => {
          return summary !== undefined
        })
        .sort((left, right) => {
          const updatedAt = right.updatedAt.localeCompare(left.updatedAt)
          if (updatedAt !== 0) return updatedAt
          return left.sessionId.localeCompare(right.sessionId)
        })

      return paginateSessionSummaries(summaries, input)
    },
  }

  async function appendEvents(
    sessionId: string,
    events: readonly KernelEvent[],
    options: EventStoreAppendOptions = {},
  ): Promise<EventEnvelope[]> {
    const existingEvents = sessions.get(sessionId) ?? []
    if (options.operation !== undefined) {
      const operation = operations.get(
        `${sessionId}\u0000${options.operation.id}`,
      )
      if (operation !== undefined) {
        requireOperationFingerprint(
          sessionId,
          options.operation,
          operation.fingerprint,
        )
        return existingEvents.slice(
          operation.firstSeq - 1,
          operation.firstSeq - 1 + operation.eventCount,
        )
      }
    }
    requireExpectedSequence(
      sessionId,
      options.expectedSeq,
      existingEvents.length,
    )
    const envelopes = events.map((event, index) =>
      createEventEnvelope({
        sessionId,
        seq: existingEvents.length + index + 1,
        event,
      }),
    )

    sessions.set(sessionId, [...existingEvents, ...envelopes])
    if (options.operation !== undefined) {
      operations.set(`${sessionId}\u0000${options.operation.id}`, {
        fingerprint: options.operation.fingerprint,
        firstSeq: existingEvents.length + 1,
        eventCount: envelopes.length,
      })
    }
    return envelopes
  }
}

function createSessionSummary(
  sessionId: string,
  events: readonly EventEnvelope[],
): EventStoreSessionSummary | undefined {
  const firstEvent = events.at(0)
  if (!firstEvent) return undefined
  if (firstEvent.type !== EventType.SessionCreated) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidEventLog,
      message: "Session log must start with session.created.",
      details: {
        sessionId,
        actualType: firstEvent.type,
      },
    })
  }

  const lastEvent = events.at(-1) ?? firstEvent
  const summary: {
    sessionId: string
    seq: number
    createdAt: string
    updatedAt: string
    title?: string
    workingDirectory?: string
    parentSessionId?: string
    metadata?: EventMetadata
  } = {
    sessionId,
    seq: lastEvent.seq,
    createdAt: firstEvent.createdAt,
    updatedAt: lastEvent.createdAt,
  }

  if (firstEvent.data.title !== undefined) summary.title = firstEvent.data.title
  if (firstEvent.data.workingDirectory !== undefined) {
    summary.workingDirectory = firstEvent.data.workingDirectory
  }
  if (firstEvent.data.parentSessionId !== undefined) {
    summary.parentSessionId = firstEvent.data.parentSessionId
  }
  if (firstEvent.data.metadata !== undefined) {
    summary.metadata = firstEvent.data.metadata
  }

  for (const event of events.slice(1)) {
    if (event.type !== EventType.SessionMetadataUpdated) continue
    if (event.data.title !== undefined) summary.title = event.data.title
    if (event.data.metadata !== undefined)
      summary.metadata = event.data.metadata
  }

  return summary
}

function paginateSessionSummaries(
  summaries: readonly EventStoreSessionSummary[],
  input: EventStoreListSessionsInput = {},
): EventStoreListSessionsResult {
  const limit = requireSessionListLimit(input.limit)
  const startIndex =
    input.cursor === undefined
      ? 0
      : requireSessionCursorIndex(summaries, input.cursor) + 1
  const sessions = summaries.slice(startIndex, startIndex + limit)
  const nextCursor =
    startIndex + limit < summaries.length
      ? sessionSummaryCursor(requireLastSummary(sessions))
      : undefined

  return {
    sessions,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

function requireSessionListLimit(limit: number | undefined): number {
  if (limit === undefined) return 50
  if (Number.isInteger(limit) && limit > 0 && limit <= 100) return limit
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Session list limit must be an integer from 1 to 100.",
    details: {
      limit,
    },
  })
}

function requireSessionCursorIndex(
  summaries: readonly EventStoreSessionSummary[],
  cursor: string,
): number {
  const index = summaries.findIndex(
    (summary) => sessionSummaryCursor(summary) === cursor,
  )
  if (index >= 0) return index
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Session list cursor is invalid.",
    details: {
      cursor,
    },
  })
}

function sessionSummaryCursor(summary: EventStoreSessionSummary): string {
  return `${summary.updatedAt}\t${summary.sessionId}`
}

function requireLastSummary(
  summaries: readonly EventStoreSessionSummary[],
): EventStoreSessionSummary {
  const summary = summaries.at(-1)
  if (summary) return summary
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: "Expected at least one session summary.",
  })
}
