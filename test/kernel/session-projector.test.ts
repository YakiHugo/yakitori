import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  createInputId,
  createSessionId,
  createSessionKernel,
  createSessionProjector,
  createTurnId,
  EventType,
  InputRole,
  InputState,
  ItemKind,
  ItemStatus,
  PermissionBehavior,
  PermissionState,
  projectSession,
  ToolState,
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
        items: [],
        permissions: [],
        tools: [],
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
            itemIds: [],
            permissionRequestIds: [],
            toolCallIds: [],
          },
        ],
      })
    })
  })

  it("projects item lifecycle inside a turn", async () => {
    await withProjector(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "write an item",
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
        status: ItemStatus.Failed,
        metadata: {
          reason: "example",
        },
      })

      expect(await context.projector.project(session.sessionId)).toMatchObject({
        id: session.sessionId,
        seq: 7,
        updatedAt: completed.event.createdAt,
        items: [
          {
            itemId: appended.itemId,
            turnId: started.turnId,
            kind: ItemKind.AssistantMessage,
            content: {
              kind: "text",
              text: "final",
            },
            status: ItemStatus.Failed,
            appendedAt: appended.event.createdAt,
            updatedAt: completed.event.createdAt,
            providerMetadata: {
              provider: "test",
            },
            metadata: {
              reason: "example",
            },
          },
        ],
        turns: [
          {
            turnId: started.turnId,
            itemIds: [appended.itemId],
          },
        ],
      })
      expect(updated.event.type).toBe(EventType.ItemUpdated)
    })
  })

  it("projects permission and tool lifecycle inside a turn", async () => {
    await withProjector(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "run checks",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const permission = await context.kernel.requestPermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        action: "shell.exec",
        subject: "pnpm check",
      })
      const resolved = await context.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        permissionRequestId: permission.permissionRequestId,
        behavior: PermissionBehavior.Allow,
      })
      const tool = await context.kernel.requestTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        name: "shell.exec",
        input: {
          command: "pnpm check",
        },
        permissionRequestId: permission.permissionRequestId,
      })
      await context.kernel.startTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: tool.toolCallId,
      })
      const progress = await context.kernel.recordToolProgress({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: tool.toolCallId,
        message: "running",
        data: {
          phase: "test",
        },
      })
      const completed = await context.kernel.completeTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: tool.toolCallId,
        output: {
          exitCode: 0,
        },
        metadata: {
          durationMs: 12,
        },
      })

      expect(await context.projector.project(session.sessionId)).toMatchObject({
        id: session.sessionId,
        seq: 10,
        permissions: [
          {
            permissionRequestId: permission.permissionRequestId,
            turnId: started.turnId,
            action: "shell.exec",
            subject: "pnpm check",
            state: PermissionState.Resolved,
            requestedAt: permission.event.createdAt,
            updatedAt: resolved.event.createdAt,
            behavior: PermissionBehavior.Allow,
          },
        ],
        tools: [
          {
            toolCallId: tool.toolCallId,
            turnId: started.turnId,
            name: "shell.exec",
            input: {
              command: "pnpm check",
            },
            state: ToolState.Completed,
            requestedAt: tool.event.createdAt,
            updatedAt: completed.event.createdAt,
            permissionRequestId: permission.permissionRequestId,
            output: {
              exitCode: 0,
            },
            progress: [
              {
                createdAt: progress.event.createdAt,
                message: "running",
                data: {
                  phase: "test",
                },
              },
            ],
            metadata: {
              durationMs: 12,
            },
          },
        ],
        turns: [
          {
            turnId: started.turnId,
            permissionRequestIds: [permission.permissionRequestId],
            toolCallIds: [tool.toolCallId],
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
      const item = await context.kernel.appendItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        kind: ItemKind.AssistantMessage,
        content: {
          kind: "text",
          text: "done",
        },
      })
      await context.kernel.completeItem({
        sessionId: session.sessionId,
        turnId: started.turnId,
        itemId: item.itemId,
      })
      await context.store.appendEvent(session.sessionId, {
        type: EventType.TurnCompleted,
        data: {
          turnId: started.turnId,
          outputItemId: item.itemId,
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
        seq: 8,
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
            outputItemId: item.itemId,
            metadata: {
              status: "done",
            },
            itemIds: [item.itemId],
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
