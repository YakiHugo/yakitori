import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createJsonlEventStore,
  createSessionId,
  createSessionKernel,
  type EventStore,
  EventType,
  InputState,
  PermissionBehavior,
  PermissionState,
  SessionConfiguration,
  type SessionKernel,
  ToolState,
  TurnState,
  YakitoriErrorCode,
} from "../../src/index.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

for (const implementation of ["memory", "jsonl"] as const) {
  describe(`session witness kernel (${implementation})`, () => {
    it("seeds inherited model context before conversation history", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const seeded = await kernel.seedContextWindow({
          sessionId: session.sessionId,
          sourceSessionId: "session_parent",
          history: [
            {
              role: "user",
              content: [{ type: "text", text: "inherited task" }],
            },
          ],
          worldStateBaseline: { environment: { cwd: "/workspace" } },
        })
        const replayed = await kernel.replaySession({
          sessionId: session.sessionId,
        })

        expect(seeded.windowId.startsWith("context_window_")).toBe(true)
        expect(replayed.session?.inheritedContext).toMatchObject({
          windowId: seeded.windowId,
          sourceSessionId: "session_parent",
          history: [
            {
              role: "user",
              content: [{ type: "text", text: "inherited task" }],
            },
          ],
        })
        expect(replayed.session?.worldState?.state).toEqual({
          environment: { cwd: "/workspace" },
        })
        await expect(
          kernel.seedContextWindow({
            sessionId: session.sessionId,
            sourceSessionId: "session_other",
            history: [],
          }),
        ).rejects.toThrow("already has model-visible history")
      })
    })

    it("persists session configuration once and returns the winning snapshot", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const first = SessionConfiguration.create({
          selection: { provider: "codex", model: "gpt-5.6-sol" },
          workspaceRoot: "/workspace/first",
          enabledTools: ["read_file"],
          approvalPolicy: "never",
        }).snapshot
        const competing = { ...first, workspaceRoot: "/workspace/second" }

        const created = await kernel.configureSession({
          sessionId: session.sessionId,
          configuration: first,
        })
        const retry = await kernel.configureSession({
          sessionId: session.sessionId,
          configuration: competing,
        })
        const read = await kernel.readSession({ sessionId: session.sessionId })

        expect(created).toMatchObject({ created: true, configuration: first })
        expect(retry).toEqual({ created: false, configuration: first })
        expect(read.session?.configuration).toEqual(first)
      })
    })

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
        await expect(
          kernel.admitInput({
            sessionId: session.sessionId,
            requestId: "request:same",
            content: { kind: "text", text: "different" },
          }),
        ).rejects.toThrow("already admitted with different input")
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

    it("pages durable events with a sequence cursor", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const input = await admit(kernel, session.sessionId, "page")
        await kernel.cancelInput({
          sessionId: session.sessionId,
          inputId: input.inputId,
        })

        const first = await kernel.readEvents({
          sessionId: session.sessionId,
          limit: 2,
        })
        expect(first.events.map((event) => event.seq)).toEqual([1, 2])
        expect(first.nextAfter).toBe(2)
        if (first.nextAfter === undefined) throw new Error("Missing cursor.")
        const second = await kernel.readEvents({
          sessionId: session.sessionId,
          after: first.nextAfter,
          limit: 2,
        })
        expect(second.events.map((event) => event.seq)).toEqual([3])
        expect(second.nextAfter).toBeUndefined()
      })
    })

    it("rejects deleting unknown or busy sessions", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        await expect(
          kernel.deleteSession({ sessionId: createSessionId() }),
        ).rejects.toThrow("has not been created")

        const queued = await kernel.createSession()
        await admit(kernel, queued.sessionId, "queued")
        await expect(
          kernel.deleteSession({ sessionId: queued.sessionId }),
        ).rejects.toThrow("cancel its queued inputs")

        const busy = await kernel.createSession()
        const input = await admit(kernel, busy.sessionId, "busy")
        await kernel.startTurn({
          sessionId: busy.sessionId,
          inputId: input.inputId,
        })
        await expect(
          kernel.deleteSession({ sessionId: busy.sessionId }),
        ).rejects.toThrow("has an active turn")
      })
    })

    it("deletes an idle session", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const kept = await kernel.createSession({ title: "Kept" })
        const doomed = await kernel.createSession({ title: "Doomed" })
        const input = await admit(kernel, doomed.sessionId, "done")
        await kernel.cancelInput({
          sessionId: doomed.sessionId,
          inputId: input.inputId,
        })

        const deleted = await kernel.deleteSession({
          sessionId: doomed.sessionId,
        })

        expect(deleted).toEqual({ sessionId: doomed.sessionId })
        expect(
          (await kernel.readSession({ sessionId: doomed.sessionId })).session,
        ).toBeUndefined()
        expect(
          (await kernel.readEvents({ sessionId: doomed.sessionId })).events,
        ).toEqual([])
        const listed = await kernel.listSessions()
        expect(listed.sessions.map((summary) => summary.sessionId)).toEqual([
          kept.sessionId,
        ])
      })
    })

    it("lists and deletes a fork chain as one conversation", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const source = await kernel.createSession({ title: "Conversation" })
        const input = await admit(kernel, source.sessionId, "fork-me")
        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: input.inputId,
          reason: "undo",
        })

        expect((await kernel.listSessions()).sessions).toMatchObject([
          {
            sessionId: forked.sessionId,
            conversationId: source.sessionId,
          },
        ])

        await kernel.deleteSession({ sessionId: forked.sessionId })

        expect(
          (await kernel.readSession({ sessionId: source.sessionId })).session,
        ).toBeUndefined()
        expect(
          (await kernel.readSession({ sessionId: forked.sessionId })).session,
        ).toBeUndefined()
        expect((await kernel.listSessions()).sessions).toEqual([])
      })
    })

    it("does not delete an active sibling through an idle continuation", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const source = await kernel.createSession({ title: "Conversation" })
        const cut = await admit(kernel, source.sessionId, "fork-me")
        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: cut.inputId,
          reason: "undo",
        })
        const activeInput = await admit(
          kernel,
          source.sessionId,
          "still-running",
        )
        await kernel.startTurn({
          sessionId: source.sessionId,
          inputId: activeInput.inputId,
        })

        await expect(
          kernel.deleteSession({ sessionId: forked.sessionId }),
        ).rejects.toThrow("contains an active Session")
        expect(
          (await kernel.readSession({ sessionId: source.sessionId })).session,
        ).toBeDefined()
        expect(
          (await kernel.readSession({ sessionId: forked.sessionId })).session,
        ).toBeDefined()
      })
    })

    it("publishes an edit replacement in the fork's initial commit", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const source = await kernel.createSession()
        const cut = await admit(kernel, source.sessionId, "replace-me")

        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: cut.inputId,
          reason: "edit",
          content: { kind: "text", text: "replacement" },
          modelSelection: { provider: "faux", model: "atomic-edit" },
        })

        expect(forked.localEvents.at(-1)).toMatchObject({
          type: EventType.InputAdmitted,
          data: {
            parentInputId: cut.inputId,
            content: { kind: "text", text: "replacement" },
            modelSelection: { provider: "faux", model: "atomic-edit" },
          },
        })
        expect(forked.session.pendingInputs).toMatchObject([
          { content: { text: "replacement" } },
        ])
      })
    })

    it("persists the inherited execution contract after the history cut", async () => {
      await withKernel(implementation, async ({ kernel, store }) => {
        const source = await kernel.createSession()
        const cut = await admit(kernel, source.sessionId, "first")
        const configuration = SessionConfiguration.create({
          selection: { provider: "codex", model: "gpt-5.6-sol" },
          workspaceRoot: "/workspace/fork-contract",
          enabledTools: ["read_file", "apply_patch"],
          approvalPolicy: "never",
        }).snapshot
        await kernel.configureSession({
          sessionId: source.sessionId,
          configuration,
        })

        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: cut.inputId,
          reason: "edit",
        })

        expect(forked.localEvents).toEqual([
          expect.objectContaining({
            seq: 1,
            type: EventType.SessionCreated,
          }),
          expect.objectContaining({
            seq: 2,
            type: EventType.SessionConfigured,
            data: { configuration },
          }),
        ])
        expect(forked.session.configuration).toEqual(configuration)
        expect(
          (await store.readProjection(forked.sessionId))?.configuration,
        ).toEqual(configuration)
      })
    })

    it("forks an exact event prefix into a new Session", async () => {
      await withKernel(implementation, async ({ kernel, store }) => {
        const source = await kernel.createSession({
          title: "Fork source",
          workingDirectory: "/workspace/project",
          mateId: "mate_default",
          mateRevisionId: "mate_revision_1",
          metadata: { source: "test" },
        })
        const firstInput = await admit(kernel, source.sessionId, "first")
        const firstTurn = await kernel.startTurn({
          sessionId: source.sessionId,
          inputId: firstInput.inputId,
        })
        const beforeCompaction = await kernel.readSession({
          sessionId: source.sessionId,
        })
        const throughSeq = beforeCompaction.session?.seq
        if (throughSeq === undefined) throw new Error("missing source Session")
        const compaction = await kernel.recordCompaction({
          sessionId: source.sessionId,
          turnId: firstTurn.turnId,
          expectedCompactionId: null,
          throughSeq,
          coveredTurnIds: [],
          summary: "Shared compacted history.",
          replacement: checkpointReplacement("Shared compacted history."),
        })
        await kernel.completeTurnWithAssistantOutput({
          sessionId: source.sessionId,
          turnId: firstTurn.turnId,
          content: [{ type: "text", text: "first reply" }],
        })
        const cutInput = await admit(kernel, source.sessionId, "replace-me")
        const cutTurn = await kernel.startTurn({
          sessionId: source.sessionId,
          inputId: cutInput.inputId,
        })
        await kernel.completeTurn({
          sessionId: source.sessionId,
          turnId: cutTurn.turnId,
        })
        const sourceEvents = await store.readEvents(source.sessionId)
        const cutIndex = sourceEvents.findIndex(
          (event) =>
            event.type === EventType.InputAdmitted &&
            event.data.inputId === cutInput.inputId,
        )

        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: cutInput.inputId,
          reason: "edit",
        })
        const targetEvents = await store.readEvents(forked.sessionId)

        expect(targetEvents).toHaveLength(cutIndex)
        expect(targetEvents[0]).toMatchObject({
          seq: 1,
          type: EventType.SessionCreated,
          data: {
            title: "Fork source",
            workingDirectory: "/workspace/project",
            mateId: "mate_default",
            mateRevisionId: "mate_revision_1",
            parentSessionId: source.sessionId,
            forkedFromInputId: cutInput.inputId,
            forkReason: "edit",
            metadata: { source: "test" },
          },
        })
        expect(
          targetEvents
            .slice(1)
            .map(({ sessionId: _sessionId, ...event }) => event),
        ).toEqual(
          sourceEvents
            .slice(1, cutIndex)
            .map(({ sessionId: _sessionId, ...event }) => event),
        )
        expect(forked.session).toEqual(
          await store.readProjection(forked.sessionId),
        )
        expect(forked.session.updatedAt >= forked.session.createdAt).toBe(true)
        expect(forked.session.compaction).toMatchObject({
          compactionId: compaction.compactionId,
          throughSeq,
          summary: "Shared compacted history.",
        })
        expect(await store.readEvents(source.sessionId)).toEqual(sourceEvents)

        const replacement = await kernel.admitInput({
          sessionId: forked.sessionId,
          parentInputId: cutInput.inputId,
          content: { kind: "text", text: "replacement" },
        })
        expect(replacement.event).toMatchObject({
          data: { parentInputId: cutInput.inputId },
        })
        await expect(
          kernel.admitInput({
            sessionId: forked.sessionId,
            parentInputId: "input_unrelated",
            content: { kind: "text", text: "invalid parent" },
          }),
        ).rejects.toThrow("Input input_unrelated was not found")
      })
    })

    it("forks before the first Input without copying history", async () => {
      await withKernel(implementation, async ({ kernel, store }) => {
        const source = await kernel.createSession()
        const input = await admit(kernel, source.sessionId, "first-cut")
        await kernel.cancelInput({
          sessionId: source.sessionId,
          inputId: input.inputId,
        })

        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: input.inputId,
          reason: "undo",
        })

        expect(await store.readEvents(forked.sessionId)).toEqual([
          expect.objectContaining({
            seq: 1,
            type: EventType.SessionCreated,
            data: expect.objectContaining({
              parentSessionId: source.sessionId,
              forkedFromInputId: input.inputId,
              forkReason: "undo",
            }),
          }),
        ])
      })
    })

    it("settles queued work but requires the runtime to interrupt an active Turn", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const queued = await kernel.createSession()
        const queuedInput = await admit(kernel, queued.sessionId, "queued-fork")
        const queuedFork = await kernel.forkSession({
          sessionId: queued.sessionId,
          atInputId: queuedInput.inputId,
          reason: "undo",
        })
        expect(queuedFork.sourceEvents).toMatchObject([
          { type: EventType.InputCancelled },
        ])

        const active = await kernel.createSession()
        const activeInput = await admit(kernel, active.sessionId, "active-fork")
        await kernel.startTurn({
          sessionId: active.sessionId,
          inputId: activeInput.inputId,
        })
        await expect(
          kernel.forkSession({
            sessionId: active.sessionId,
            atInputId: activeInput.inputId,
            reason: "undo",
          }),
        ).rejects.toMatchObject({
          code: YakitoriErrorCode.InvalidState,
          details: {
            sessionId: active.sessionId,
            operation: "fork_session",
          },
        })
      })
    })

    it("closes a turn left open by a mid-turn fork cut", async () => {
      await withKernel(implementation, async ({ kernel, store }) => {
        const source = await kernel.createSession()
        const firstInput = await admit(kernel, source.sessionId, "first")
        const firstTurn = await kernel.startTurn({
          sessionId: source.sessionId,
          inputId: firstInput.inputId,
        })
        // Admitted while the first Turn is still running, so its admission
        // sits between turn.started and turn.completed in the journal.
        const midTurnInput = await admit(kernel, source.sessionId, "mid-turn")
        await kernel.completeTurn({
          sessionId: source.sessionId,
          turnId: firstTurn.turnId,
        })
        await kernel.cancelInput({
          sessionId: source.sessionId,
          inputId: midTurnInput.inputId,
        })

        const forked = await kernel.forkSession({
          sessionId: source.sessionId,
          atInputId: midTurnInput.inputId,
          reason: "undo",
        })

        // The cut lands before the first Turn's terminal event, so the fork
        // must close that Turn instead of leaving it Started forever.
        expect(forked.session.activeTurn).toBeUndefined()
        expect(forked.session.interruptedTurns).toEqual([
          expect.objectContaining({
            turnId: firstTurn.turnId,
            state: TurnState.Interrupted,
            interruptedReason:
              "The Session was forked before this Turn finished.",
          }),
        ])
        const targetEvents = await store.readEvents(forked.sessionId)
        expect(targetEvents.at(-1)).toMatchObject({
          type: EventType.TurnInterrupted,
          data: { turnId: firstTurn.turnId },
        })
        expect(targetEvents.map((event) => event.seq)).toEqual(
          targetEvents.map((_, index) => index + 1),
        )

        // The forked Session can start new work immediately.
        const followUp = await admit(kernel, forked.sessionId, "follow-up")
        const followUpTurn = await kernel.startTurn({
          sessionId: forked.sessionId,
          inputId: followUp.inputId,
        })
        expect(followUpTurn.turnId).toBeTruthy()
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
          "reasoning",
          "assistant_message",
          "tool_call",
          "tool_result",
        ])
      })
    })

    it("records a compaction checkpoint inside the active Turn", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        const read = await kernel.readSession({ sessionId: active.sessionId })
        const throughSeq = read.session?.seq
        if (throughSeq === undefined) throw new Error("missing session")
        const recorded = await kernel.recordCompaction({
          ...active,
          expectedCompactionId: null,
          throughSeq,
          coveredTurnIds: [],
          summary: "Goal: ship the feature.",
          replacement: checkpointReplacement("Goal: ship the feature."),
          usage: { inputTokens: 12, outputTokens: 4 },
        })

        expect(recorded.compactionId.startsWith("compaction_")).toBe(true)
        expect(recorded.event).toMatchObject({
          type: EventType.ContextCompacted,
          data: {
            compactionId: recorded.compactionId,
            turnId: active.turnId,
            throughSeq,
            coveredTurnIds: [],
            summary: "Goal: ship the feature.",
            usage: { inputTokens: 12, outputTokens: 4 },
          },
        })
        const replay = await kernel.replaySession({
          sessionId: active.sessionId,
        })
        expect(replay.session?.compaction).toMatchObject({
          compactionId: recorded.compactionId,
          throughSeq,
          coveredTurnIds: [],
          summary: "Goal: ship the feature.",
          replacement: {
            windowNumber: 1,
            history: checkpointReplacement("Goal: ship the feature.").history,
            worldStateBaseline: {},
          },
        })
        const window = replay.session?.compaction?.replacement
        expect(window?.windowId.startsWith("context_window_")).toBe(true)
        expect(window?.firstWindowId).toBe(window?.windowId)
      })
    })

    it("rejects stale compaction snapshots and invalid coverage", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const active = await activeTurn(kernel)
        const read = await kernel.readSession({ sessionId: active.sessionId })
        const seq = read.session?.seq
        if (seq === undefined) throw new Error("missing session")

        await expect(
          kernel.recordCompaction({
            ...active,
            expectedCompactionId: "compaction_stale",
            throughSeq: seq,
            coveredTurnIds: [],
            summary: "stale",
            replacement: checkpointReplacement("stale"),
          }),
        ).rejects.toThrow("checkpoint changed")
        await expect(
          kernel.recordCompaction({
            ...active,
            expectedCompactionId: null,
            throughSeq: seq - 1,
            coveredTurnIds: [],
            summary: "stale history",
            replacement: checkpointReplacement("stale history"),
          }),
        ).rejects.toThrow("history changed")
        await expect(
          kernel.recordCompaction({
            ...active,
            expectedCompactionId: null,
            throughSeq: seq,
            coveredTurnIds: ["turn_missing"],
            summary: "bad coverage",
            replacement: checkpointReplacement("bad coverage"),
          }),
        ).rejects.toThrow("continuous prefix")
      })
    })

    it("refuses to record a compaction without an active Turn", async () => {
      await withKernel(implementation, async ({ kernel }) => {
        const session = await kernel.createSession()
        const input = await admit(kernel, session.sessionId, "work")
        const turn = await kernel.startTurn({
          sessionId: session.sessionId,
          inputId: input.inputId,
        })
        await kernel.completeTurn({
          sessionId: session.sessionId,
          turnId: turn.turnId,
        })

        await expect(
          kernel.recordCompaction({
            sessionId: session.sessionId,
            turnId: turn.turnId,
            expectedCompactionId: null,
            throughSeq: 3,
            coveredTurnIds: [turn.turnId],
            summary: "too late",
            replacement: checkpointReplacement("too late"),
          }),
        ).rejects.toThrow("is not active")
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
          usage: {
            inputTokens: 100,
            outputTokens: 8,
            cacheReadInputTokens: 75,
          },
          metrics: {
            modelCalls: 1,
            toolCalls: 0,
            modelDurationMs: 320,
            toolDurationMs: 0,
            averageTimeToFirstTokenMs: 80,
          },
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
            usage: {
              inputTokens: 100,
              outputTokens: 8,
              cacheReadInputTokens: 75,
            },
            metrics: {
              modelCalls: 1,
              toolCalls: 0,
              modelDurationMs: 320,
              toolDurationMs: 0,
              averageTimeToFirstTokenMs: 80,
            },
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
            usage: {
              inputTokens: 100,
              outputTokens: 8,
              cacheReadInputTokens: 75,
            },
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

    it("keeps cached and replay rebuilt projections equal", async () => {
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

function checkpointReplacement(summary: string) {
  return {
    history: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: summary }],
      },
    ],
    worldStateBaseline: {},
  }
}

async function withKernel(
  implementation: "memory" | "jsonl",
  run: (context: { kernel: SessionKernel; store: EventStore }) => Promise<void>,
) {
  if (implementation === "memory") {
    const store = createMemoryEventStore()
    await run({ kernel: createSessionKernel(store), store })
    return
  }
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-witness-"))
  const store = createJsonlEventStore({
    sessionsDir: join(rootDir, "sessions"),
  })
  cleanup.push(async () => {
    await store.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  await run({ kernel: createSessionKernel(store), store })
}
