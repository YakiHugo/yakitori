import {
  createEventEnvelope,
  applySessionFacts,
  type EventEnvelope,
  type EventStore,
  type EventStoreAppendOptions,
  type KernelEvent,
  type SessionProjection,
} from "../../src/index.ts"
import {
  paginateSessionSummaries,
  requireExpectedSequence,
  requireOperationFingerprint,
  summarizeSessionProjection,
} from "../../src/kernel/event-store.ts"

type MemoryOperationRecord = {
  readonly eventCount: number
  readonly fingerprint: string
  readonly firstSeq: number
}

export function createMemoryEventStore(): EventStore {
  const sessions = new Map<string, EventEnvelope[]>()
  const operations = new Map<string, MemoryOperationRecord>()
  const projections = new Map<string, SessionProjection>()

  return {
    async appendEvent(sessionId, event, options) {
      const envelopes = await appendEvents(sessionId, [event], options)
      const envelope = envelopes.at(0)
      if (!envelope) throw new Error("Expected one appended event.")
      return envelope
    },

    appendEvents,

    async readEvents(sessionId, input = {}) {
      return structuredClone(
        (sessions.get(sessionId) ?? []).filter(
          (event) => event.seq > (input.after ?? 0),
        ),
      )
    },

    async readProjection(sessionId) {
      const projection = projections.get(sessionId)
      return projection === undefined ? undefined : structuredClone(projection)
    },

    async rebuildProjection(sessionId) {
      const events = structuredClone(sessions.get(sessionId) ?? [])
      const projection = applySessionFacts(undefined, events)
      if (projection === undefined) {
        projections.delete(sessionId)
        return { events }
      }
      projections.set(sessionId, structuredClone(projection))
      return {
        events,
        projection: structuredClone(projection),
      }
    },

    async listSessions(input = {}) {
      const summaries = Array.from(projections.values()).map(
        summarizeSessionProjection,
      )

      return structuredClone(paginateSessionSummaries(summaries, input))
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
        return structuredClone(
          existingEvents.slice(
            operation.firstSeq - 1,
            operation.firstSeq - 1 + operation.eventCount,
          ),
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
    const storedEnvelopes = structuredClone(envelopes)
    const projection = applySessionFacts(
      projections.get(sessionId),
      storedEnvelopes,
    )
    if (!projection) throw new Error("Expected appended Session projection.")

    sessions.set(sessionId, [...existingEvents, ...storedEnvelopes])
    projections.set(sessionId, structuredClone(projection))
    if (options.operation !== undefined) {
      operations.set(`${sessionId}\u0000${options.operation.id}`, {
        fingerprint: options.operation.fingerprint,
        firstSeq: existingEvents.length + 1,
        eventCount: envelopes.length,
      })
    }
    return structuredClone(storedEnvelopes)
  }
}
