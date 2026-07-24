import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createSessionKernel,
  createSqliteEventStore,
  EventType,
  InputState,
  PermissionBehavior,
  PermissionState,
  ToolState,
  TurnState,
  type EventStore,
  type SessionKernel,
} from "../../src/index.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

for (const implementation of ["memory", "sqlite"] as const) {
  describe(`session witness kernel (${implementation})`, () => {
    it("admits idempotently and folds promotion into turn.started", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession({ title: "Witness" })
        const first = await kernel.admitInput({
          sessionId: session.sessionId,
          requestId: "request:same",
          content: { kind: "text", text: "hello" },
        })
        const retry = await kernel.admitInput({
          sessionId: session.sessionId,
          requestId: "request:same",
          content: { kind: "text", text: "hello" },
        })
        const turn = await kernel.startTurn({
          sessionId: session.sessionId,
          inputId: first.inputId,
        })
        const replay = await kernel.replaySession({
          sessionId: session.sessionId,
        })

        expect(retry).toMatchObject({ inputId: first.inputId, created: false })
        expect(turn.events.map((event) => event.type)).toEqual([
          EventType.TurnStarted,
        ])
        expect(replay.events.map((event) => event.type)).toEqual([
          EventType.SessionCreated,
          EventType.InputAdmitted,
          EventType.TurnStarted,
        ])
        expect(replay.session?.inputs[0]).toMatchObject({
          state: InputState.Promoted,
          turnId: turn.turnId,
        })
      })
    })

    it("keeps at most one active Turn", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const first = await admit(kernel, session.sessionId, "first")
        const second = await admit(kernel, session.sessionId, "second")
        await kernel.startTurn({
          sessionId: session.sessionId,
          inputId: first.inputId,
        })

        await expect(
          kernel.startTurn({
            sessionId: session.sessionId,
            inputId: second.inputId,
          }),
        ).rejects.toThrow("already has active Turn")
      })
    })

    it("cancels an admitted Input once", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const input = await admit(kernel, session.sessionId, "cancel")
        const cancelled = await kernel.cancelInput({
          sessionId: session.sessionId,
          inputId: input.inputId,
          reason: "superseded",
        })

        expect(cancelled.event).toMatchObject({
          type: EventType.InputCancelled,
          data: { inputId: input.inputId, reason: "superseded" },
        })
        await expect(
          kernel.cancelInput({
            sessionId: session.sessionId,
            inputId: input.inputId,
          }),
        ).rejects.toThrow("already cancelled")
        const read = await kernel.readSession({
          sessionId: session.sessionId,
        })
        expect(read.session?.inputs[0]).toMatchObject({
          state: InputState.Cancelled,
          cancelledReason: "superseded",
        })
        expect(read.session?.pendingInputs).toEqual([])
      })
    })

    it("records assistant messages and coarse tool facts", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        const output = await kernel.recordAssistantOutput({
          ...active,
          content: [
            { type: "reasoning", text: "check first" },
            { type: "text", text: "Reading." },
          ],
          toolCalls: [
            {
              id: "tool_read",
              name: "read_file",
              input: { path: "README.md" },
              requiresPermission: false,
            },
          ],
        })
        await kernel.requireToolExecutionAllowed({
          ...active,
          toolCallId: "tool_read",
        })
        await kernel.recordToolResult({
          ...active,
          toolCallId: "tool_read",
          content: { kind: "text", text: "contents" },
          output: { bytes: 8 },
        })
        const read = await kernel.readSession({ sessionId: active.sessionId })

        expect(output.events.map((event) => event.type)).toEqual([
          EventType.AssistantMessage,
          EventType.ToolCall,
        ])
        expect(read.session?.tools[0]).toMatchObject({
          toolCallId: "tool_read",
          state: ToolState.Completed,
          output: { bytes: 8 },
        })
        expect(read.session?.items.map((item) => item.kind)).toEqual([
          "assistant_message",
          "reasoning",
          "tool_call",
          "tool_result",
        ])
      })
    })

    it("binds one permission decision to exactly one tool call", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        await kernel.recordAssistantOutput({
          ...active,
          toolCalls: [
            {
              id: "tool_shell",
              name: "run_command",
              input: { command: "pwd" },
              requiresPermission: true,
            },
            {
              id: "tool_other",
              name: "run_command",
              input: { command: "date" },
              requiresPermission: true,
            },
          ],
        })
        const permission = await kernel.requestPermission({
          ...active,
          toolCallId: "tool_shell",
          action: "run_command",
        })
        await kernel.resolvePermission({
          ...active,
          permissionRequestId: permission.permissionRequestId,
          behavior: PermissionBehavior.Allow,
        })

        await expect(
          kernel.requireToolExecutionAllowed({
            ...active,
            toolCallId: "tool_shell",
          }),
        ).resolves.toBeUndefined()
        await expect(
          kernel.requireToolExecutionAllowed({
            ...active,
            toolCallId: "tool_other",
          }),
        ).rejects.toThrow("has not been allowed")

        const read = await kernel.readSession({ sessionId: active.sessionId })
        expect(read.session?.permissions[0]).toMatchObject({
          toolCallId: "tool_shell",
          state: PermissionState.Resolved,
          behavior: PermissionBehavior.Allow,
        })
      })
    })

    it("never binds a denied permission to its tool call", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        await kernel.recordAssistantOutput({
          ...active,
          toolCalls: [
            {
              id: "tool_denied",
              name: "run_command",
              input: { command: "rm file" },
              requiresPermission: true,
            },
          ],
        })
        const permission = await kernel.requestPermission({
          ...active,
          toolCallId: "tool_denied",
          action: "run_command",
        })
        await kernel.resolvePermission({
          ...active,
          permissionRequestId: permission.permissionRequestId,
          behavior: PermissionBehavior.Deny,
        })

        await expect(
          kernel.requireToolExecutionAllowed({
            ...active,
            toolCallId: "tool_denied",
          }),
        ).rejects.toThrow("has not been allowed")
      })
    })

    it("allows a Turn to finish with open work and accepts one late result", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        await kernel.recordAssistantOutput({
          ...active,
          toolCalls: [
            {
              id: "tool_background",
              name: "background",
              input: {},
              requiresPermission: false,
            },
          ],
        })
        await kernel.completeTurn(active)
        await kernel.recordToolResult({
          ...active,
          toolCallId: "tool_background",
          content: { kind: "text", text: "done later" },
        })

        await expect(
          kernel.recordToolResult({
            ...active,
            toolCallId: "tool_background",
            content: { kind: "text", text: "duplicate" },
          }),
        ).rejects.toThrow("already has a result")
        const read = await kernel.readSession({ sessionId: active.sessionId })
        expect(read.session?.turns[0]?.state).toBe(TurnState.Completed)
        expect(read.session?.tools[0]?.state).toBe(ToolState.Completed)
      })
    })

    it("records interruption once without fabricating closure facts", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        await kernel.recordAssistantOutput({
          ...active,
          toolCalls: [
            {
              id: "tool_stranded",
              name: "run_command",
              input: { command: "sleep 30" },
              requiresPermission: true,
            },
          ],
        })
        const permission = await kernel.requestPermission({
          ...active,
          toolCallId: "tool_stranded",
          action: "run_command",
        })
        const first = await kernel.interruptTurn({
          ...active,
          reason: "restart",
        })
        const retry = await kernel.interruptTurn({
          ...active,
          reason: "restart",
        })
        const replay = await kernel.replaySession({
          sessionId: active.sessionId,
        })

        expect(first.created).toBe(true)
        expect(retry).toEqual({ events: [], created: false })
        expect(replay.events.map((event) => event.type)).toContain(
          EventType.TurnInterrupted,
        )
        expect(replay.events.map((event) => event.type)).not.toContain(
          "permission.cancelled",
        )
        expect(replay.session?.turns[0]).toMatchObject({
          state: TurnState.Interrupted,
          interruptedReason: "restart",
        })
        expect(replay.session?.tools[0]?.state).toBe(ToolState.Requested)
        expect(replay.session?.permissions[0]).toMatchObject({
          permissionRequestId: permission.permissionRequestId,
          state: PermissionState.Pending,
        })
      })
    })

    it("records failed and cancelled Turn commands", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const failedInput = await admit(kernel, session.sessionId, "fail")
        const failedTurn = await kernel.startTurn({
          sessionId: session.sessionId,
          inputId: failedInput.inputId,
        })
        const failed = await kernel.failTurn({
          sessionId: session.sessionId,
          turnId: failedTurn.turnId,
          error: { code: "provider_error", message: "unavailable" },
        })
        const cancelledInput = await admit(
          kernel,
          session.sessionId,
          "cancel-turn",
        )
        const cancelledTurn = await kernel.startTurn({
          sessionId: session.sessionId,
          inputId: cancelledInput.inputId,
        })
        const cancelled = await kernel.cancelTurn({
          sessionId: session.sessionId,
          turnId: cancelledTurn.turnId,
          reason: "user stopped",
        })

        expect(failed.events).toEqual([failed.event])
        expect(failed.event).toMatchObject({
          type: EventType.TurnFailed,
          data: {
            turnId: failedTurn.turnId,
            error: { code: "provider_error", message: "unavailable" },
          },
        })
        expect(cancelled.events).toEqual([cancelled.event])
        expect(cancelled.event).toMatchObject({
          type: EventType.TurnCancelled,
          data: { turnId: cancelledTurn.turnId, reason: "user stopped" },
        })
        const read = await kernel.readSession({ sessionId: session.sessionId })
        expect(read.session?.failedTurns).toEqual([
          expect.objectContaining({
            turnId: failedTurn.turnId,
            state: TurnState.Failed,
            error: { code: "provider_error", message: "unavailable" },
          }),
        ])
        expect(read.session?.cancelledTurns).toEqual([
          expect.objectContaining({
            turnId: cancelledTurn.turnId,
            state: TurnState.Cancelled,
            cancelledReason: "user stopped",
          }),
        ])
        expect(read.session?.activeTurn).toBeUndefined()
      })
    })

    it("keeps rich write-through and replay rebuilt projections equal", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const completed = await activeTurn(kernel)
        await kernel.recordAssistantOutput({
          ...completed,
          content: [{ type: "reasoning", text: "inspect" }],
          toolCalls: [
            {
              id: "tool_allowed",
              name: "run_command",
              input: { command: "pwd" },
              requiresPermission: true,
            },
          ],
        })
        const resolved = await kernel.requestPermission({
          ...completed,
          toolCallId: "tool_allowed",
          action: "run_command",
        })
        await kernel.resolvePermission({
          ...completed,
          permissionRequestId: resolved.permissionRequestId,
          behavior: PermissionBehavior.Allow,
        })
        await kernel.recordToolResult({
          ...completed,
          toolCallId: "tool_allowed",
          content: { kind: "text", text: "/workspace" },
          output: { exitCode: 0 },
        })
        await kernel.completeTurn({
          ...completed,
          usage: { inputTokens: 21, outputTokens: 8 },
        })

        const interruptedInput = await admit(
          kernel,
          completed.sessionId,
          "interrupt",
        )
        const interrupted = await kernel.startTurn({
          sessionId: completed.sessionId,
          inputId: interruptedInput.inputId,
        })
        await kernel.recordAssistantOutput({
          sessionId: completed.sessionId,
          turnId: interrupted.turnId,
          toolCalls: [
            {
              id: "tool_pending",
              name: "run_command",
              input: { command: "sleep 30" },
              requiresPermission: true,
            },
          ],
        })
        await kernel.requestPermission({
          sessionId: completed.sessionId,
          turnId: interrupted.turnId,
          toolCallId: "tool_pending",
          action: "run_command",
        })
        await kernel.interruptTurn({
          sessionId: completed.sessionId,
          turnId: interrupted.turnId,
          reason: "restart",
        })

        const read = await kernel.readSession({
          sessionId: completed.sessionId,
        })
        const replay = await kernel.replaySession({
          sessionId: completed.sessionId,
        })

        expect(read.session).toEqual(replay.session)
        expect(replay.session?.usage).toEqual({
          inputTokens: 21,
          outputTokens: 8,
        })
      })
    })
  })
}

async function activeTurn(kernel: SessionKernel) {
  const session = await kernel.createSession()
  const input = await admit(kernel, session.sessionId, "work")
  const turn = await kernel.startTurn({
    sessionId: session.sessionId,
    inputId: input.inputId,
  })
  return { sessionId: session.sessionId, turnId: turn.turnId }
}

function admit(kernel: SessionKernel, sessionId: string, text: string) {
  return kernel.admitInput({
    sessionId,
    requestId: `request:${text}`,
    content: { kind: "text", text },
  })
}

async function withKernel(
  implementation: "memory" | "sqlite",
  run: (context: { kernel: SessionKernel; store: EventStore }) => Promise<void>,
) {
  if (implementation === "memory") {
    const store = createMemoryEventStore()
    await run({ kernel: createSessionKernel(store), store })
    return
  }
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-witness-"))
  const store = createSqliteEventStore({ rootDir })
  cleanup.push(async () => {
    store.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  await run({ kernel: createSessionKernel(store), store })
}
