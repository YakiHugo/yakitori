import {
  createEventEnvelope,
  type EventEnvelope,
  type EventStore,
  type KernelEvent,
} from "../../src/index.ts"

export function createMemoryEventStore(): EventStore {
  const sessions = new Map<string, EventEnvelope[]>()

  return {
    async appendEvent(sessionId, event) {
      const envelopes = await appendEvents(sessionId, [event])
      const envelope = envelopes.at(0)
      if (!envelope) throw new Error("Expected one appended event.")
      return envelope
    },

    appendEvents,

    async readEvents(sessionId) {
      return [...(sessions.get(sessionId) ?? [])]
    },
  }

  async function appendEvents(
    sessionId: string,
    events: readonly KernelEvent[],
  ): Promise<EventEnvelope[]> {
    const existingEvents = sessions.get(sessionId) ?? []
    const envelopes = events.map((event, index) =>
      createEventEnvelope({
        sessionId,
        seq: existingEvents.length + index + 1,
        event,
      }),
    )

    sessions.set(sessionId, [...existingEvents, ...envelopes])
    return envelopes
  }
}
