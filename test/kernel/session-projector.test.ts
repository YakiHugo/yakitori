import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  createInputId,
  createItemId,
  createSessionId,
  createSessionKernel,
  createSessionProjector,
  createTurnId,
  EventType,
  InputRole,
  InputState,
  projectSession,
  TurnState,
  type EventEnvelope,
  type EventStore,
  type SessionKernel,
  type SessionProjector,
} from "../../src/index.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

describe("session projector", () => {
  it("returns no projection for an empty event log", () => {
    expect(projectSession([])).toBeUndefined()
  })

  it("projects session, input, and turn lifecycle from stored events", async () => {
    await withProjector(async (context) => {
      const session = await context.kernel.createSession({
        title: "Yakitori",
        workingDirectory: "/tmp/yakitori",
        metadata: {
          source: "test",
        },
      })
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "start the kernel",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
        metadata: {
          reason: "mvp",
        },
      })
      const promotedEvent = requireEvent(started.events, 0)
      const turnStartedEvent = requireEvent(started.events, 1)

      expect(await context.projector.project(session.sessionId)).toEqual({
        id: session.sessionId,
        seq: 4,
        createdAt: session.event.createdAt,
        updatedAt: turnStartedEvent.createdAt,
        title: "Yakitori",
        workingDirectory: "/tmp/yakitori",
        metadata: {
          source: "test",
        },
        inputs: [
          {
            inputId: admitted.inputId,
            role: InputRole.User,
            content: {
              kind: "text",
              text: "start the kernel",
            },
            state: InputState.Promoted,
            admittedAt: admitted.event.createdAt,
            updatedAt: promotedEvent.createdAt,
            turnId: started.turnId,
          },
        ],
        turns: [
          {
            turnId: started.turnId,
            inputId: admitted.inputId,
            state: TurnState.Started,
            startedAt: turnStartedEvent.createdAt,
            updatedAt: turnStartedEvent.createdAt,
            metadata: {
              reason: "mvp",
            },
          },
        ],
      })
    })
  })

  it("applies session metadata updates and turn completion", async () => {
    await withProjector(async (context) => {
      const session = await context.kernel.createSession({
        title: "Draft",
      })
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "finish the turn",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const itemId = createItemId()
      await context.store.appendEvent(session.sessionId, {
        type: EventType.TurnCompleted,
        data: {
          turnId: started.turnId,
          outputItemId: itemId,
          metadata: {
            status: "done",
          },
        },
      })
      const updated = await context.store.appendEvent(session.sessionId, {
        type: EventType.SessionMetadataUpdated,
        data: {
          title: "Done",
          metadata: {
            archived: false,
          },
        },
      })

      expect(await context.projector.project(session.sessionId)).toMatchObject({
        id: session.sessionId,
        seq: 6,
        updatedAt: updated.createdAt,
        title: "Done",
        metadata: {
          archived: false,
        },
        turns: [
          {
            turnId: started.turnId,
            inputId: admitted.inputId,
            state: TurnState.Completed,
            outputItemId: itemId,
            metadata: {
              status: "done",
            },
          },
        ],
      })
    })
  })

  it("returns no projection for a missing stored session", async () => {
    await withProjector(async (context) => {
      expect(await context.projector.project(createSessionId())).toBeUndefined()
    })
  })

  it("rejects event logs that skip sequences", () => {
    const sessionId = createSessionId()

    expect(() =>
      projectSession([
        createEventEnvelope({
          sessionId,
          seq: 1,
          event: {
            type: EventType.SessionCreated,
            data: {},
          },
        }),
        createEventEnvelope({
          sessionId,
          seq: 3,
          event: {
            type: EventType.InputAdmitted,
            data: {
              inputId: createInputId(),
              role: InputRole.User,
              content: {
                kind: "text",
                text: "gap",
              },
            },
          },
        }),
      ]),
    ).toThrow("Session projection expected sequence 2, got 3.")
  })

  it("rejects turn events that reference unknown input", () => {
    const sessionId = createSessionId()

    expect(() =>
      projectSession([
        createEventEnvelope({
          sessionId,
          seq: 1,
          event: {
            type: EventType.SessionCreated,
            data: {},
          },
        }),
        createEventEnvelope({
          sessionId,
          seq: 2,
          event: {
            type: EventType.TurnStarted,
            data: {
              turnId: createTurnId(),
              inputId: createInputId(),
            },
          },
        }),
      ]),
    ).toThrow("has not been admitted")
  })
})

async function withProjector(
  run: (context: {
    readonly kernel: SessionKernel
    readonly projector: SessionProjector
    readonly store: EventStore
  }) => Promise<void>,
): Promise<void> {
  const store = createMemoryEventStore()
  await run({
    kernel: createSessionKernel(store),
    projector: createSessionProjector(store),
    store,
  })
}

function requireEvent(
  events: readonly EventEnvelope[],
  index: number,
): EventEnvelope {
  const event = events.at(index)
  if (event) return event
  throw new Error(`Missing event at index ${index}.`)
}
