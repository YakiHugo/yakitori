import { describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { waitForValue } from "../support/wait-for-value.ts"

describe("archived conversation queue admission", () => {
  it("preserves queued input across archived resume and explicit start until restored", async () => {
    const store = new MemoryThreadStore()
    const queue = new InputQueue()
    const seen: string[] = []
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* (request) {
            seen.push(
              request.messages
                .flatMap((message) =>
                  message.role === "user" ? message.content : [],
                )
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .find((text) => text === "retained queued work") ?? "",
            )
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "done" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      inputQueue: queue,
    })
    try {
      const created = await handlers.createSession({
        workingDirectory: process.cwd(),
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      if (!created.ok) throw new Error(created.error.message)
      const sessionId = created.value.session.id
      await manager.closeThread(sessionId)
      const queued = await handlers.queueInput({
        sessionId,
        requestId: "request_archived_queue",
        content: createUserInput("retained queued work"),
      })
      if (!queued.ok) throw new Error(queued.error.message)
      expect(
        await handlers.updateSidebar({
          type: "session",
          sessionId,
          archived: true,
        }),
      ).toMatchObject({ ok: true })
      await manager.resumeThread(sessionId)
      // Finish the automatic wake's per-session queue tail before asserting.
      expect(
        await handlers.startQueuedInput({
          sessionId,
          inputId: queued.value.inputId,
        }),
      ).toMatchObject({ ok: false, error: { code: "conflict" } })
      expect(seen).toEqual([])
      expect(
        queue.list(sessionId).map((item) => item.input.content.text),
      ).toEqual(["retained queued work"])
      expect(await store.sessionPresentation(sessionId)).toMatchObject({
        archived: true,
      })
      expect(
        await handlers.updateSidebar({
          type: "session",
          sessionId,
          archived: false,
        }),
      ).toMatchObject({ ok: true })
      expect(
        await handlers.startQueuedInput({
          sessionId,
          inputId: queued.value.inputId,
        }),
      ).toMatchObject({ ok: true })
      await waitForValue(() => (seen.length === 1 ? true : undefined))
      expect(seen).toEqual(["retained queued work"])
      expect(queue.list(sessionId)).toEqual([])
    } finally {
      await manager.shutdown()
      await handlers.close()
      queue.close()
    }
  })
  it("serializes archive behind a queued start that already owns admission", async () => {
    const store = new MemoryThreadStore()
    const queue = new InputQueue()
    const admissionRead = Promise.withResolvers<void>()
    const releaseAdmission = Promise.withResolvers<void>()
    const releaseTurn = Promise.withResolvers<void>()
    let holdAdmission = false
    let calls = 0
    const readPresentation = store.sessionPresentation.bind(store)
    store.sessionPresentation = async (sessionId) => {
      const presentation = await readPresentation(sessionId)
      if (holdAdmission) {
        holdAdmission = false
        admissionRead.resolve()
        await releaseAdmission.promise
      }
      return presentation
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* () {
            calls += 1
            await releaseTurn.promise
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "done" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      inputQueue: queue,
    })
    try {
      const created = await handlers.createSession({
        workingDirectory: process.cwd(),
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      if (!created.ok) throw new Error(created.error.message)
      const sessionId = created.value.session.id
      // Drain the install wake before arranging a persisted waiting row.
      expect(
        await handlers.reorderQueuedInputs({ sessionId, inputIds: [] }),
      ).toMatchObject({ ok: true })
      const item = queue.enqueue(sessionId, {
        submissionId: "request_archive_overlap",
        content: createUserInput("queued overlap"),
      })
      holdAdmission = true
      const starting = handlers.startQueuedInput({
        sessionId,
        inputId: item.id,
      })
      await admissionRead.promise
      const archiving = handlers.updateSidebar({
        type: "session",
        sessionId,
        archived: true,
      })
      releaseAdmission.resolve()
      expect(await starting).toMatchObject({ ok: true })
      expect(await archiving).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      })
      expect(await readPresentation(sessionId)).not.toMatchObject({
        archived: true,
      })
      expect(manager.getThread(sessionId)?.snapshot().activeTurnId).toBe(
        "request_archive_overlap",
      )
      expect(queue.list(sessionId)).toEqual([])
      releaseTurn.resolve()
      await waitForValue(() =>
        manager.getThread(sessionId)?.status === "idle" ? true : undefined,
      )
      expect(calls).toBe(1)
    } finally {
      releaseAdmission.resolve()
      releaseTurn.resolve()
      await manager.shutdown()
      await handlers.close()
      queue.close()
    }
  })
})
