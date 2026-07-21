import {
  createEventEnvelope,
  type EventEnvelope,
  type EventStore,
  type EventStoreAppendOptions,
  type KernelEvent,
} from "../../src/index.ts"
import {
  paginateSessionSummaries,
  requireExpectedSequence,
  requireOperationFingerprint,
  summarizeStoredSession,
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
        .map(([sessionId, events]) => summarizeStoredSession(sessionId, events))
        .filter((summary) => summary !== undefined)
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
