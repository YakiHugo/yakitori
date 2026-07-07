import { describe, expect, it } from "vitest"
import {
  createInputId,
  createSessionId,
  createSessionKernel,
  EventType,
  InputRole,
  ItemKind,
  ItemStatus,
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

  it("appends, updates, and completes an item in an active turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "write a response",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const appended = await context.kernel.appendItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        kind: ItemKind.AssistantMessage,
        content: {
          kind: "text",
          text: "draft",
        },
        providerMetadata: {
          provider: "test",
        },
      })
      const updated = await context.kernel.updateItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        itemId: appended.itemId,
        content: {
          kind: "text",
          text: "final",
        },
      })
      const completed = await context.kernel.completeItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        itemId: appended.itemId,
        metadata: {
          visible: true,
        },
      })

      expect(appended.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 5,
        type: EventType.ItemAppended,
        data: {
          itemId: appended.itemId,
          turnId: started.turnId,
          kind: ItemKind.AssistantMessage,
          content: {
            kind: "text",
            text: "draft",
          },
          providerMetadata: {
            provider: "test",
          },
        },
      })
      expect(updated.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 6,
        type: EventType.ItemUpdated,
        data: {
          itemId: appended.itemId,
          turnId: started.turnId,
          content: {
            kind: "text",
            text: "final",
          },
        },
      })
      expect(completed.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 7,
        type: EventType.ItemCompleted,
        data: {
          itemId: appended.itemId,
          turnId: started.turnId,
          status: ItemStatus.Completed,
          metadata: {
            visible: true,
          },
        },
      })
    })
  })

  it("completes an active turn and allows the next turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const firstInput = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "first input",
        },
      })
      const firstTurn = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: firstInput.inputId,
      })
      const output = await context.kernel.appendItem({
        sessionId: session.sessionId,
        turnId: firstTurn.turnId,
        kind: ItemKind.AssistantMessage,
        content: {
          kind: "text",
          text: "first output",
        },
      })
      const completed = await context.kernel.completeTurn({
        sessionId: session.sessionId,
        turnId: firstTurn.turnId,
        outputItemId: output.itemId,
        metadata: {
          status: "done",
        },
      })
      const secondInput = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "second input",
        },
      })
      const secondTurn = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: secondInput.inputId,
      })

      expect(completed.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 6,
        type: EventType.TurnCompleted,
        data: {
          turnId: firstTurn.turnId,
          outputItemId: output.itemId,
          metadata: {
            status: "done",
          },
        },
      })
      expect(secondTurn.events.map((event) => event.seq)).toEqual([8, 9])
    })
  })

  it("fails an active turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "fail this turn",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })

      const failed = await context.kernel.failTurn({
        sessionId: session.sessionId,
        turnId: started.turnId,
        error: {
          message: "model failed",
          code: "model_error",
        },
      })

      expect(failed.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 5,
        type: EventType.TurnFailed,
        data: {
          turnId: started.turnId,
          error: {
            message: "model failed",
            code: "model_error",
          },
        },
      })
    })
  })

  it("cancels an active turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "cancel this turn",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })

      const cancelled = await context.kernel.cancelTurn({
        sessionId: session.sessionId,
        turnId: started.turnId,
        reason: "user interrupted",
      })

      expect(cancelled.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 5,
        type: EventType.TurnCancelled,
        data: {
          turnId: started.turnId,
          reason: "user interrupted",
        },
      })
    })
  })

  it("rejects ending a turn twice", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "complete once",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })

      await context.kernel.completeTurn({
        sessionId: session.sessionId,
        turnId: started.turnId,
      })

      await expect(
        context.kernel.cancelTurn({
          sessionId: session.sessionId,
          turnId: started.turnId,
        }),
      ).rejects.toThrow(`Turn ${started.turnId} is already completed.`)
    })
  })

  it("rejects updating a completed item", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "item closes once",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const item = await context.kernel.appendItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        kind: ItemKind.AssistantMessage,
        content: {
          kind: "text",
          text: "closed",
        },
      })

      await context.kernel.completeItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        itemId: item.itemId,
      })

      await expect(
        context.kernel.updateItem({
          sessionId: session.sessionId,
          turnId: started.turnId,
          itemId: item.itemId,
          content: {
            kind: "text",
            text: "too late",
          },
        }),
      ).rejects.toThrow(`Item ${item.itemId} is already completed.`)
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

  it("rejects starting another turn while one is active", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const firstInput = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "first turn",
        },
      })
      const secondInput = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "second turn",
        },
      })

      const firstTurn = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: firstInput.inputId,
      })

      await expect(
        context.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: secondInput.inputId,
        }),
      ).rejects.toThrow(
        `Session ${session.sessionId} already has active turn ${firstTurn.turnId}.`,
      )
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
