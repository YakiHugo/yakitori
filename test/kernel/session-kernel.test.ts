import { describe, expect, it } from "vitest"
import {
  createInputId,
  createSessionId,
  createSessionKernel,
  EventType,
  InputRole,
  InputState,
  ItemKind,
  ItemStatus,
  PermissionBehavior,
  PermissionState,
  type EventStore,
  type SessionKernel,
  ToolState,
  TurnState,
  YakitoriErrorCode,
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

  it("updates session metadata for an existing session", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession({
        title: "Draft",
        metadata: {
          stage: "bootstrap",
        },
      })

      const updated = await context.kernel.updateSessionMetadata({
        sessionId: session.sessionId,
        title: "Kernel boundary",
        metadata: {
          stage: "kernel",
        },
      })
      const read = await context.kernel.readSession({
        sessionId: session.sessionId,
      })

      expect(updated.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 2,
        type: EventType.SessionMetadataUpdated,
        data: {
          title: "Kernel boundary",
          metadata: {
            stage: "kernel",
          },
        },
      })
      expect(read.session).toMatchObject({
        id: session.sessionId,
        seq: 2,
        title: "Kernel boundary",
        metadata: {
          stage: "kernel",
        },
      })
    })
  })

  it("lists session summaries through the kernel facade", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession({
        title: "Draft",
        workingDirectory: "/tmp/yakitori",
      })
      const updated = await context.kernel.updateSessionMetadata({
        sessionId: session.sessionId,
        title: "Kernel boundary",
        metadata: {
          stage: "kernel",
        },
      })

      expect(await context.kernel.listSessions()).toEqual({
        sessions: [
          {
            sessionId: session.sessionId,
            seq: 2,
            createdAt: session.event.createdAt,
            updatedAt: updated.event.createdAt,
            title: "Kernel boundary",
            workingDirectory: "/tmp/yakitori",
            metadata: {
              stage: "kernel",
            },
          },
        ],
      })
    })
  })

  it("rejects malformed session summaries through the memory store", async () => {
    await withKernel(async (context) => {
      const sessionId = createSessionId()

      await context.store.appendEvent(sessionId, {
        type: EventType.InputAdmitted,
        data: {
          inputId: createInputId(),
          role: InputRole.User,
          content: {
            kind: "text",
            text: "orphan",
          },
        },
      })

      await expect(context.kernel.listSessions()).rejects.toThrow(
        "Session log must start with session.created.",
      )
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

  it("cancels admitted input before promotion", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "queue this input",
        },
      })

      const cancelled = await context.kernel.cancelInput({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
        reason: "superseded",
      })
      const read = await context.kernel.readSession({
        sessionId: session.sessionId,
      })

      expect(cancelled.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 3,
        type: EventType.InputCancelled,
        data: {
          inputId: admitted.inputId,
          reason: "superseded",
        },
      })
      expect(read.session).toMatchObject({
        inputs: [
          {
            inputId: admitted.inputId,
            state: InputState.Cancelled,
            cancelledReason: "superseded",
          },
        ],
      })
      await expect(
        context.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: admitted.inputId,
        }),
      ).rejects.toThrow(`Input ${admitted.inputId} has been cancelled.`)
    })
  })

  it("serializes concurrent input promotion and cancellation", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "race this input",
        },
      })

      const results = await Promise.allSettled([
        context.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: admitted.inputId,
        }),
        context.kernel.cancelInput({
          sessionId: session.sessionId,
          inputId: admitted.inputId,
        }),
      ])
      const replayed = await context.kernel.replaySession({
        sessionId: session.sessionId,
      })

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1)
      expect(replayed.session).toBeDefined()
      expect(replayed.events.map((event) => event.type)).toEqual([
        EventType.SessionCreated,
        EventType.InputAdmitted,
        EventType.InputPromoted,
        EventType.TurnStarted,
      ])

      const secondSession = await context.kernel.createSession()
      const secondInput = await context.kernel.admitInput({
        sessionId: secondSession.sessionId,
        content: {
          kind: "text",
          text: "race cancel first",
        },
      })

      const reversedResults = await Promise.allSettled([
        context.kernel.cancelInput({
          sessionId: secondSession.sessionId,
          inputId: secondInput.inputId,
        }),
        context.kernel.startTurn({
          sessionId: secondSession.sessionId,
          inputId: secondInput.inputId,
        }),
      ])
      const reversedReplay = await context.kernel.replaySession({
        sessionId: secondSession.sessionId,
      })

      expect(
        reversedResults.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1)
      expect(
        reversedResults.filter((result) => result.status === "rejected"),
      ).toHaveLength(1)
      expect(reversedReplay.session).toBeDefined()
      expect(reversedReplay.events.map((event) => event.type)).toEqual([
        EventType.SessionCreated,
        EventType.InputAdmitted,
        EventType.InputCancelled,
      ])
    })
  })

  it("reads and replays a session from durable events", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession({
        title: "Replay me",
      })
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "show the session",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })

      const read = await context.kernel.readSession({
        sessionId: session.sessionId,
      })
      const replayed = await context.kernel.replaySession({
        sessionId: session.sessionId,
      })

      expect(read.session).toMatchObject({
        id: session.sessionId,
        title: "Replay me",
        seq: 4,
        turns: [
          {
            turnId: started.turnId,
            state: TurnState.Started,
          },
        ],
      })
      expect(replayed.events.map((event) => event.type)).toEqual([
        EventType.SessionCreated,
        EventType.InputAdmitted,
        EventType.InputPromoted,
        EventType.TurnStarted,
      ])
      expect(replayed.session).toEqual(read.session)
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

  it("requests and resolves permission in an active turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "run a checked command",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const requested = await context.kernel.requestPermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        action: "shell.exec",
        subject: "pnpm test",
        reason: "verify changes",
      })
      const resolved = await context.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        permissionRequestId: requested.permissionRequestId,
        behavior: PermissionBehavior.Allow,
        reason: {
          kind: "user_allowed",
          message: "ok",
        },
      })

      expect(requested.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 5,
        type: EventType.PermissionRequested,
        data: {
          permissionRequestId: requested.permissionRequestId,
          turnId: started.turnId,
          action: "shell.exec",
          subject: "pnpm test",
          reason: "verify changes",
        },
      })
      expect(resolved.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 6,
        type: EventType.PermissionResolved,
        data: {
          permissionRequestId: requested.permissionRequestId,
          turnId: started.turnId,
          behavior: PermissionBehavior.Allow,
          reason: {
            kind: "user_allowed",
            message: "ok",
          },
        },
      })
    })
  })

  it("records a permission-checked tool lifecycle", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "check the project",
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

      await context.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        permissionRequestId: permission.permissionRequestId,
        behavior: PermissionBehavior.Allow,
      })

      const requested = await context.kernel.requestTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        name: "shell.exec",
        input: {
          command: "pnpm check",
        },
        permissionRequestId: permission.permissionRequestId,
      })
      const toolStarted = await context.kernel.startTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: requested.toolCallId,
      })
      const progress = await context.kernel.recordToolProgress({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: requested.toolCallId,
        message: "running",
      })
      const completed = await context.kernel.completeTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: requested.toolCallId,
        output: {
          exitCode: 0,
        },
      })

      expect(requested.event).toMatchObject({
        sessionId: session.sessionId,
        seq: 7,
        type: EventType.ToolRequested,
        data: {
          toolCallId: requested.toolCallId,
          turnId: started.turnId,
          name: "shell.exec",
          input: {
            command: "pnpm check",
          },
          permissionRequestId: permission.permissionRequestId,
        },
      })
      expect(toolStarted.event.type).toBe(EventType.ToolStarted)
      expect(progress.event).toMatchObject({
        seq: 9,
        type: EventType.ToolProgress,
        data: {
          toolCallId: requested.toolCallId,
          message: "running",
        },
      })
      expect(completed.event).toMatchObject({
        seq: 10,
        type: EventType.ToolCompleted,
        data: {
          toolCallId: requested.toolCallId,
          output: {
            exitCode: 0,
          },
        },
      })
    })
  })

  it("rejects starting a tool when permission was denied", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "try a denied command",
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
        subject: "rm -rf dist",
      })

      await context.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        permissionRequestId: permission.permissionRequestId,
        behavior: PermissionBehavior.Deny,
      })

      const tool = await context.kernel.requestTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        name: "shell.exec",
        input: {
          command: "rm -rf dist",
        },
        permissionRequestId: permission.permissionRequestId,
      })

      const deniedStart = context.kernel.startTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: tool.toolCallId,
      })

      await expect(deniedStart).rejects.toThrow(
        `Permission ${permission.permissionRequestId} resolved with deny.`,
      )
      await expect(deniedStart).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidState,
        details: {
          permissionRequestId: permission.permissionRequestId,
          behavior: PermissionBehavior.Deny,
        },
      })
    })
  })

  it("enforces permissions that are bound to an existing tool call", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "bind permission after tool request",
        },
      })
      const started = await context.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const tool = await context.kernel.requestTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        name: "shell.exec",
        input: {
          command: "pnpm test",
        },
      })
      const permission = await context.kernel.requestPermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        action: "shell.exec",
        subject: "pnpm test",
        toolCallId: tool.toolCallId,
      })

      const pendingStart = context.kernel.startTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        toolCallId: tool.toolCallId,
      })

      await expect(pendingStart).rejects.toThrow(
        `Permission ${permission.permissionRequestId} has not been allowed.`,
      )
      await expect(pendingStart).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidState,
        details: {
          permissionRequestId: permission.permissionRequestId,
          state: PermissionState.Requested,
        },
      })

      await context.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        permissionRequestId: permission.permissionRequestId,
        behavior: PermissionBehavior.Allow,
      })

      await expect(
        context.kernel.startTool({
          sessionId: session.sessionId,
          turnId: started.turnId,
          toolCallId: tool.toolCallId,
        }),
      ).resolves.toMatchObject({
        event: {
          type: EventType.ToolStarted,
          data: {
            toolCallId: tool.toolCallId,
          },
        },
      })
    })
  })

  it("rejects completing a turn while work is still open", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "leave work open",
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
          text: "not done",
        },
      })

      await expect(
        context.kernel.completeTurn({
          sessionId: session.sessionId,
          turnId: started.turnId,
          outputItemId: item.itemId,
        }),
      ).rejects.toThrow(`Item ${item.itemId} is in_progress.`)
    })
  })

  it("cancels open work before cancelling the turn", async () => {
    await withKernel(async (context) => {
      const session = await context.kernel.createSession()
      const admitted = await context.kernel.admitInput({
        sessionId: session.sessionId,
        content: {
          kind: "text",
          text: "cancel everything",
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
          text: "draft",
        },
      })
      const permission = await context.kernel.requestPermission({
        sessionId: session.sessionId,
        turnId: started.turnId,
        action: "shell.exec",
      })
      const tool = await context.kernel.requestTool({
        sessionId: session.sessionId,
        turnId: started.turnId,
        name: "shell.exec",
        input: {
          command: "pnpm test",
        },
      })
      const cancelled = await context.kernel.cancelTurn({
        sessionId: session.sessionId,
        turnId: started.turnId,
        reason: "user stopped",
      })
      const read = await context.kernel.readSession({
        sessionId: session.sessionId,
      })

      expect(cancelled.events.map((event) => event.type)).toEqual([
        EventType.ToolCancelled,
        EventType.PermissionCancelled,
        EventType.ItemCompleted,
        EventType.TurnCancelled,
      ])
      expect(read.session).toMatchObject({
        items: [
          {
            itemId: item.itemId,
            status: ItemStatus.Failed,
          },
        ],
        permissions: [
          {
            permissionRequestId: permission.permissionRequestId,
            state: PermissionState.Cancelled,
          },
        ],
        tools: [
          {
            toolCallId: tool.toolCallId,
            state: ToolState.Cancelled,
          },
        ],
        turns: [
          {
            turnId: started.turnId,
            state: TurnState.Cancelled,
          },
        ],
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
      await context.kernel.completeItem({
        sessionId: session.sessionId,
        turnId: firstTurn.turnId,
        itemId: output.itemId,
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
        seq: 7,
        type: EventType.TurnCompleted,
        data: {
          turnId: firstTurn.turnId,
          outputItemId: output.itemId,
          metadata: {
            status: "done",
          },
        },
      })
      expect(secondTurn.events.map((event) => event.seq)).toEqual([9, 10])
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
