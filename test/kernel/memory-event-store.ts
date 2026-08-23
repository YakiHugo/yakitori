import {
  appendForkCutTurnClosures,
  collapseSessionConversations,
  type EventStore,
  type EventStoreAppendOptions,
  paginateSessionSummaries,
  requireAdmissionFingerprint,
  requireExpectedSequence,
} from "../../src/kernel/event-store.ts"
import {
  createEventEnvelope,
  type EventEnvelope,
  EventType,
  type KernelFact,
} from "../../src/kernel/events.ts"
import { fingerprintInputAdmission } from "../../src/kernel/operation.ts"
import {
  applySessionFacts,
  type SessionProjection,
  summarizeSessionProjection,
} from "../../src/kernel/session-projector.ts"

type MemoryAdmissionRecord = {
  readonly event: EventEnvelope
  readonly fingerprint: string
}

export function createMemoryEventStore(): EventStore {
  const sessions = new Map<string, EventEnvelope[]>()
  const admissions = new Map<string, MemoryAdmissionRecord>()
  const projections = new Map<string, SessionProjection>()

  return {
    async createSession(sessionId, created) {
      if (sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists.`)
      }
      if (
        created.data.historyBase !== undefined ||
        created.data.forkedFromInputId !== undefined ||
        created.data.forkReason !== undefined
      ) {
        throw new Error("A root Session cannot carry fork history metadata.")
      }
      const event = createEventEnvelope({
        sessionId,
        seq: 1,
        event: {
          ...structuredClone(created),
          data: {
            ...structuredClone(created.data),
            conversationId: created.data.conversationId ?? sessionId,
          },
        },
      })
      const projection = applySessionFacts(undefined, [event])
      if (projection === undefined) throw new Error("Expected projection.")
      sessions.set(sessionId, [event])
      projections.set(sessionId, projection)
      return structuredClone(event)
    },

    async appendEvent(sessionId, event, options) {
      const envelopes = await appendEvents(sessionId, [event], options)
      const envelope = envelopes.at(0)
      if (!envelope) throw new Error("Expected one appended event.")
      return envelope
    },

    appendEvents,

    async forkSession(input) {
      const sourceEvents = sessions.get(input.sourceSessionId) ?? []
      requireExpectedSequence(
        input.sourceSessionId,
        input.expectedSourceSeq,
        sourceEvents.length,
      )
      if (sessions.has(input.targetSessionId)) {
        throw new Error(`Session ${input.targetSessionId} already exists.`)
      }
      const cutIndex = sourceEvents.findIndex(
        (event) =>
          event.type === EventType.InputAdmitted &&
          event.data.inputId === input.atInputId,
      )
      if (cutIndex === -1) {
        throw new Error(`Input ${input.atInputId} was not found.`)
      }
      const created = createEventEnvelope({
        sessionId: input.targetSessionId,
        seq: 1,
        event: input.created,
      })
      const events = [
        created,
        ...sourceEvents.slice(1, cutIndex).map((event) => ({
          ...structuredClone(event),
          sessionId: input.targetSessionId,
        })),
      ]
      appendForkCutTurnClosures(input.targetSessionId, events)
      const inheritedProjection = applySessionFacts(undefined, events)
      if (inheritedProjection === undefined) {
        throw new Error("Expected forked Session projection.")
      }
      for (const pending of inheritedProjection.pendingInputs) {
        events.push(
          createEventEnvelope({
            sessionId: input.targetSessionId,
            seq: events.length + 1,
            event: {
              type: EventType.InputCancelled,
              data: {
                inputId: pending.inputId,
                reason: "conversation_fork",
              },
            },
          }),
        )
      }
      for (const event of input.initialEvents ?? []) {
        if (event.type === EventType.SessionCreated) {
          throw new Error("Fork initial events cannot contain session.created.")
        }
        events.push(
          createEventEnvelope({
            sessionId: input.targetSessionId,
            seq: events.length + 1,
            event,
          }),
        )
      }
      const projection = applySessionFacts(undefined, events)
      if (projection === undefined) {
        throw new Error("Expected forked Session projection.")
      }

      sessions.set(input.targetSessionId, structuredClone(events))
      projections.set(input.targetSessionId, structuredClone(projection))
      for (const event of events) {
        if (event.type !== EventType.InputAdmitted) continue
        admissions.set(
          `${input.targetSessionId}\u0000${event.data.requestId}`,
          {
            event: structuredClone(event),
            fingerprint: fingerprintInputAdmission(event.data),
          },
        )
      }
      return structuredClone({
        historyEndSeqExclusive: sourceEvents[cutIndex]?.seq ?? 1,
        events,
        localEvents: [created, ...events.slice(cutIndex)],
        projection,
      })
    },

    async readEvents(sessionId, input = {}) {
      const events = sessions.get(sessionId) ?? []
      const after = input.after ?? 0
      const start = Math.min(Math.max(after, 0), events.length)
      const replayEnd = Math.min(input.through ?? events.length, events.length)
      const end = Math.min(
        replayEnd,
        input.limit === undefined ? replayEnd : start + input.limit,
      )
      return structuredClone(end <= start ? [] : events.slice(start, end))
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

      return structuredClone(
        paginateSessionSummaries(
          collapseSessionConversations(summaries),
          input,
        ),
      )
    },

    async deleteSession(sessionId) {
      sessions.delete(sessionId)
      projections.delete(sessionId)
      for (const key of admissions.keys()) {
        if (key.startsWith(`${sessionId}\u0000`)) admissions.delete(key)
      }
    },

    async deleteConversation(conversationId) {
      const conversation = Array.from(projections.entries()).filter(
        ([, projection]) => projection.conversationId === conversationId,
      )
      for (const [sessionId, projection] of conversation) {
        if (projection.activeTurn !== undefined) {
          throw new Error(
            `Conversation ${conversationId} contains an active Session ${sessionId}.`,
          )
        }
        if (projection.pendingInputs.length > 0) {
          throw new Error(
            `Conversation ${conversationId} contains queued input in Session ${sessionId}.`,
          )
        }
      }
      for (const [sessionId] of conversation) {
        sessions.delete(sessionId)
        projections.delete(sessionId)
        for (const key of admissions.keys()) {
          if (key.startsWith(`${sessionId}\u0000`)) admissions.delete(key)
        }
      }
    },
  }

  async function appendEvents(
    sessionId: string,
    events: readonly KernelFact[],
    options: EventStoreAppendOptions = {},
  ): Promise<EventEnvelope[]> {
    if (events.some((event) => event.type === EventType.SessionCreated)) {
      throw new Error("session.created can only be written by createSession.")
    }
    const existingEvents = sessions.get(sessionId)
    if (existingEvents === undefined) {
      throw new Error(`Session ${sessionId} has not been created.`)
    }
    if (options.admission !== undefined) {
      const event = events[0]
      if (
        events.length !== 1 ||
        event?.type !== EventType.InputAdmitted ||
        event.data.requestId !== options.admission.requestId ||
        fingerprintInputAdmission(event.data) !== options.admission.fingerprint
      ) {
        throw new Error(
          "Admission reconciliation must match one input.admitted fact.",
        )
      }
      const admission = admissions.get(
        `${sessionId}\u0000${options.admission.requestId}`,
      )
      if (admission !== undefined) {
        requireAdmissionFingerprint(
          sessionId,
          options.admission,
          admission.fingerprint,
        )
        return [structuredClone(admission.event)]
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
    const pendingAdmissionKeys = new Set<string>()
    const newAdmissions = storedEnvelopes.flatMap((event) => {
      if (event.type !== EventType.InputAdmitted) return []
      const key = `${sessionId}\u0000${event.data.requestId}`
      if (admissions.has(key) || pendingAdmissionKeys.has(key)) {
        throw new Error(`Request ${event.data.requestId} was already admitted.`)
      }
      pendingAdmissionKeys.add(key)
      return [
        {
          key,
          record: {
            event,
            fingerprint: fingerprintInputAdmission(event.data),
          },
        },
      ]
    })
    const projection = applySessionFacts(
      projections.get(sessionId),
      storedEnvelopes,
    )
    if (!projection) throw new Error("Expected appended Session projection.")

    sessions.set(sessionId, [...existingEvents, ...storedEnvelopes])
    projections.set(sessionId, structuredClone(projection))
    for (const admission of newAdmissions) {
      admissions.set(admission.key, admission.record)
    }
    return structuredClone(storedEnvelopes)
  }
}
