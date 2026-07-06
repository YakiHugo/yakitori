import { describe, expect, it } from "vitest"
import {
  createInputId,
  createSessionId,
  createSessionKernel,
  EventType,
  InputRole,
  type EventStore,
  type SessionKernel,
} from "../../src/index.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

describe("session kernel", () => {
  it("creates a session event log", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession({
        title: "Yakitori",
        workingDirectory: "/tmp/yakitori",
        metadata: {
          source: "test",
        },
      })

      expect(session.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 1,
        type: EventType.SessionCreated,
        data: {
          title: "Yakitori",
          workingDirectory: "/tmp/yakitori",
          metadata: {
            source: "test",
          },
        },
      })
      expect(await context.store.readEvents(session.sessionId)).toEqual([
        session.event,
      ])
    })
  })

  it("admits user input for an existing session", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "start the kernel",
        },
      })

      expect(admitted.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 2,
        type: EventType.InputAdmitted,
        data: {
          inputId: admitted.inputId,
          role: InputRole.User,
          content: {
            kind: "text",
            text: "start the kernel",
          },
        },
      })
    })
  })

  it("starts a turn by promoting admitted input", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "write the first module",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
        metadata: {
          reason: "mvp",
        },
      })

      expect(started.events).toMatchObject([
        {
          sessionId: session.sessionId,
          seq: 3,
          type: EventType.InputPromoted,
          data: {
            inputId: admitted.inputId,
            turnId: started.turnId,
          },
        },
        {
          sessionId: session.sessionId,
          seq: 4,
          type: EventType.TurnStarted,
          data: {
            inputId: admitted.inputId,
            turnId: started.turnId,
            metadata: {
              reason: "mvp",
            },
          },
        },
      ])
      expect(
        (await context.store.readEvents(session.sessionId)).map(
          (event) => event.type,
        ),
      ).toEqual([
        EventType.SessionCreated,
        EventType.InputAdmitted,
        EventType.InputPromoted,
        EventType.TurnStarted,
      ])
    })
  })

  it("rejects input admission before session creation", async () => {
    await withKernel(async (context) => {
      await expect(
        context.kernel.admitInput({
          sessionId: createSessionId(),
          content: {
            kind: "text",
            text: "orphan input",
          },
        }),
      ).rejects.toThrow("has not been created")
    })
  })

  it("rejects starting a turn twice for the same input", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "run once",
        },
      })

      await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })

      await expect(
        context.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: admitted.inputId,
        }),
      ).rejects.toThrow("has already been promoted")
    })
  })

  it("rejects starting a turn for unknown input", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()

      await expect(
        context.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: createInputId(),
        }),
      ).rejects.toThrow("has not been admitted")
    })
  })
})

async function withKernel(
  run: (context: {
    readonly kernel: SessionKernel
    readonly store: EventStore
  }) => Promise<void>,
): Promise<void> {
  const store = createMemoryEventStore()
  await run({
    kernel: createSessionKernel(store),
    store,
  })
}
