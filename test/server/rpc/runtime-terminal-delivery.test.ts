import { describe, expect, it, vi } from "vitest"
import type { TurnProcessor } from "../../../src/core/session.ts"
import { ThreadManager } from "../../../src/core/thread-manager.ts"
import type { StoredEventEnvelope } from "../../../src/kernel/events.ts"
import type { LiveSessionEvent } from "../../../src/runtime/live-events.ts"
import { SessionConfiguration } from "../../../src/runtime/session-configuration.ts"
import { createSessionEventHub } from "../../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../../src/server/handlers.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import { MemoryThreadStore } from "../../core/memory-thread-store.ts"
import {
  deferred,
  initializeConnection,
  openTestConnection,
} from "./testkit.ts"

describe("runtime terminal delivery", () => {
  const failures = ["append", "flush", "append and flush"] as const
  for (const outcome of ["completed", "failed", "interrupted"] as const) {
    for (const failure of failures) {
      it(`delivers ${outcome} when terminal ${failure} fails`, async () => {
        const store = new MemoryThreadStore()
        const mayFinish = deferred<void>()
        const persistenceErrors: unknown[] = []
        const manager = new ThreadManager({
          store,
          onPersistenceError: (error) => persistenceErrors.push(error),
          createTurnProcessor: () => ({
            prepare: prepareTurn,
            start(runtime, _input, _context, control) {
              runtime.emitModelStream({
                itemId: "answer",
                kind: "assistant",
                text: "first",
              })
              runtime.emitModelStream({
                itemId: "answer",
                kind: "assistant",
                text: "first last",
              })
              control.signal.addEventListener("abort", () =>
                mayFinish.resolve(),
              )
              return {
                completion: mayFinish.promise.then(() => {
                  if (outcome === "failed") throw new Error("model failed")
                }),
                abort() {},
              }
            },
          }),
        })
        const eventHub = createSessionEventHub()
        const handlers = createThreadServerHandlers({
          manager,
          store,
          eventHub,
        })
        const processor = new MessageProcessor({ handlers, eventHub })
        const client = openTestConnection(processor)
        // Keep the second delta pending until a publication barrier flushes it.
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now())
        try {
          await initializeConnection(client)
          const created = await handlers.createSession()
          if (!created.ok) throw new Error(created.body.error.message)
          const sessionId = created.body.session.id
          expect(
            await client.sendRequest("session/subscribe", { sessionId }),
          ).toHaveProperty("result")
          await client.waitForFrame(
            (frame) =>
              "method" in frame && frame.method === "session/replayComplete",
          )
          const turnId = "request_terminal"
          const admitted = await handlers.admitInput({
            sessionId,
            requestId: turnId,
            content: { kind: "text", text: "finish" },
          })
          if (!admitted.ok) throw new Error(admitted.body.error.message)
          store.failNextAppend = failure !== "flush"
          store.failNextFlush = failure !== "append"
          if (outcome === "interrupted") {
            const cancelled = await handlers.cancelTurn({
              sessionId,
              turnId,
              reason: "user stop",
            })
            expect(cancelled.ok).toBe(true)
          } else {
            mayFinish.resolve()
          }

          await client.waitForFrame(
            (frame) =>
              "method" in frame &&
              frame.method === "session/transient" &&
              (frame.params as LiveSessionEvent).type === "turn.finished",
          )
          const transients = client
            .notifications("session/transient")
            .map((frame) => frame.params as LiveSessionEvent)
          const terminal = transients.filter(
            (event) => event.type === "turn.finished",
          )
          expect(terminal).toEqual([
            {
              type: "turn.finished",
              sessionId,
              turnId,
              outcome:
                outcome === "failed"
                  ? {
                      status: "failed",
                      error: expect.objectContaining({
                        message: "model failed",
                      }),
                    }
                  : outcome === "interrupted"
                    ? { status: "interrupted", reason: "user stop" }
                    : { status: "completed" },
              createdAt: expect.any(String),
            },
          ])
          expect(terminal[0]).not.toHaveProperty("seq")
          expect(manager.getThread(sessionId)?.status).toBe("idle")
          expect(persistenceErrors).toHaveLength(
            failure === "append and flush" ? 2 : 1,
          )
          expect(
            transients.filter(
              (event) =>
                event.type === "session.error" &&
                event.operation === "persistence",
            ),
          ).toHaveLength(failure === "append and flush" ? 2 : 1)
          expect(
            transients
              .filter((event) => event.type === "assistant.delta")
              .map((event) => event.delta),
          ).toEqual(["first", " last"])
          expect(transients.at(-1)?.type).toBe("turn.finished")

          const history = await handlers.readSessionEvents({ sessionId })
          if (!history.ok) throw new Error(history.body.error.message)
          const durable = client
            .notifications("session/event")
            .map(
              (frame) => (frame.params as { event: StoredEventEnvelope }).event,
            )
          expect(durable).toEqual(
            failure === "append"
              ? history.body.events.filter(
                  (event) => event.type !== "turn.completed",
                )
              : history.body.events,
          )
          expect(
            history.body.events.some(
              (event) => event.type === "turn.completed",
            ),
          ).toBe(failure !== "append and flush")
          expect(durable.some((event) => event.type === "turn.completed")).toBe(
            failure === "flush",
          )
        } finally {
          clock.mockRestore()
          mayFinish.resolve()
          await manager.shutdown()
          await handlers.close()
          await processor.closeConnection(client.id)
        }
      })
    }
  }

  it("delivers runtime finish and an error when history reads keep failing", async () => {
    const store = new MemoryThreadStore()
    const mayFinish = deferred<void>()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () => ({
        prepare: prepareTurn,
        start() {
          return { completion: mayFinish.promise, abort() {} }
        },
      }),
    })
    const eventHub = createSessionEventHub()
    const reportOperationalFailure = vi.fn()
    const handlers = createThreadServerHandlers({
      manager,
      store,
      eventHub,
      reportOperationalFailure,
    })
    const processor = new MessageProcessor({ handlers, eventHub })
    const client = openTestConnection(processor)
    const readThread = store.readThread.bind(store)
    try {
      await initializeConnection(client)
      const created = await handlers.createSession()
      if (!created.ok) throw new Error(created.body.error.message)
      const sessionId = created.body.session.id
      expect(
        await client.sendRequest("session/subscribe", { sessionId }),
      ).toHaveProperty("result")
      await client.waitForFrame(
        (frame) =>
          "method" in frame && frame.method === "session/replayComplete",
      )
      const turnId = "request_unreadable_history"
      const admitted = await handlers.admitInput({
        sessionId,
        requestId: turnId,
        content: { kind: "text", text: "finish" },
      })
      if (!admitted.ok) throw new Error(admitted.body.error.message)
      await client.waitForFrame(
        (frame) =>
          "method" in frame &&
          frame.method === "session/event" &&
          (frame.params as { event: StoredEventEnvelope }).event.type ===
            "turn.started",
      )
      const deliveredBeforeFinish = client.notifications("session/event")
      store.readThread = async () => {
        throw new Error("history unavailable")
      }
      mayFinish.resolve()

      await client.waitForFrame(
        (frame) =>
          "method" in frame &&
          frame.method === "session/transient" &&
          (frame.params as LiveSessionEvent).type === "turn.finished",
      )
      expect(
        client.notifications("session/transient").map((frame) => frame.params),
      ).toEqual([
        {
          type: "session.error",
          sessionId,
          operation: "persistence",
          message: "Session history could not be read: history unavailable",
          createdAt: expect.any(String),
        },
        {
          type: "turn.finished",
          sessionId,
          turnId,
          outcome: { status: "completed" },
          createdAt: expect.any(String),
        },
      ])
      expect(client.notifications("session/event")).toEqual(
        deliveredBeforeFinish,
      )
      expect(reportOperationalFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "thread-event-pump",
          operation: "replay-rollout",
          sessionId,
          cause: expect.objectContaining({ message: "history unavailable" }),
        }),
      )
      expect(manager.getThread(sessionId)?.status).toBe("idle")
    } finally {
      store.readThread = readThread
      mayFinish.resolve()
      await manager.shutdown()
      await handlers.close()
      await processor.closeConnection(client.id)
    }
  })

  it("flushes pending output before retry warnings and preserves resumed stream suffixes", async () => {
    const store = new MemoryThreadStore()
    const mayResume = deferred<void>()
    const mayFinish = deferred<void>()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () => ({
        prepare: prepareTurn,
        start(runtime) {
          for (const kind of ["assistant", "reasoning"] as const) {
            runtime.emitModelStream({ itemId: "answer", kind, text: "first" })
            runtime.emitModelStream({
              itemId: "answer",
              kind,
              text: "first last",
            })
          }
          runtime.emitWarning("Retrying attempt 2 of 3.", {
            code: "model.retry",
            message: "Stream disconnected",
            details: {
              kind: "stream_disconnected",
              nextAttempt: 2,
              maxAttempts: 3,
              delayMs: 1000,
            },
          })
          return {
            completion: mayResume.promise.then(async () => {
              for (const kind of ["assistant", "reasoning"] as const) {
                runtime.emitModelStream({
                  itemId: "answer",
                  kind,
                  text: "first last resumed",
                })
              }
              await mayFinish.promise
            }),
            abort() {},
          }
        },
      }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    const processor = new MessageProcessor({ handlers, eventHub })
    const client = openTestConnection(processor)
    vi.useFakeTimers()
    try {
      await initializeConnection(client)
      const created = await handlers.createSession()
      if (!created.ok) throw new Error(created.body.error.message)
      const sessionId = created.body.session.id
      expect(
        await client.sendRequest("session/subscribe", { sessionId }),
      ).toHaveProperty("result")
      await client.waitForFrame(
        (frame) =>
          "method" in frame && frame.method === "session/replayComplete",
      )
      const admitted = await handlers.admitInput({
        sessionId,
        requestId: "request_retry",
        content: { kind: "text", text: "retry" },
      })
      if (!admitted.ok) throw new Error(admitted.body.error.message)
      await client.waitForFrame(
        (frame) =>
          "method" in frame &&
          frame.method === "session/transient" &&
          (frame.params as LiveSessionEvent).type === "runtime.warning",
      )
      const beforeResume = client
        .notifications("session/transient")
        .map((frame) => frame.params as LiveSessionEvent)
      expect(
        beforeResume
          .filter((event) => event.type !== "item.started")
          .map((event) =>
            event.type === "assistant.delta" || event.type === "reasoning.delta"
              ? [event.type, event.delta]
              : [event.type],
          ),
      ).toEqual([
        ["assistant.delta", "first"],
        ["reasoning.delta", "first"],
        ["assistant.delta", " last"],
        ["reasoning.delta", " last"],
        ["runtime.warning"],
      ])
      // A held retry must not receive delayed pre-failure output after its warning.
      await vi.advanceTimersByTimeAsync(100)
      expect(
        client.notifications("session/transient").map((frame) => frame.params),
      ).toEqual(beforeResume)

      mayResume.resolve()
      await client.waitForFrame(
        (frame) =>
          "method" in frame &&
          frame.method === "session/transient" &&
          (frame.params as LiveSessionEvent).type === "reasoning.delta" &&
          (frame.params as { delta: string }).delta === " resumed",
      )
      const resumed = client
        .notifications("session/transient")
        .map((frame) => frame.params as LiveSessionEvent)
      expect(resumed.slice(beforeResume.length)).toEqual([
        expect.objectContaining({
          type: "assistant.delta",
          itemId: "answer",
          delta: " resumed",
        }),
        expect.objectContaining({
          type: "reasoning.delta",
          itemId: "answer_reasoning",
          delta: " resumed",
        }),
      ])
    } finally {
      vi.useRealTimers()
      mayResume.resolve()
      mayFinish.resolve()
      await manager.shutdown()
      await handlers.close()
      await processor.closeConnection(client.id)
    }
  })
})

const prepareTurn: TurnProcessor["prepare"] = (_snapshot, input) => {
  const selection = { provider: "faux", model: "scripted" }
  return {
    turnId: input.submissionId,
    selection,
    configuration: SessionConfiguration.create({
      selection,
      workspaceRoot: process.cwd(),
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: input.submissionId,
    }).snapshot,
  }
}
