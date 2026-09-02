import { describe, expect, it } from "vitest"
import type {
  TurnControl,
  TurnProcessor,
  TurnRuntime,
} from "../../src/core/session.ts"
import { SessionStatus, type TurnInput } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

describe("live Session actor", () => {
  it("reports active Turn ownership synchronously enough for shutdown", async () => {
    const mayFinish = deferred<void>()
    const counts: number[] = []
    const manager = createManager({
      async run() {
        await mayFinish.promise
      },
    })
    const unsubscribe = manager.subscribeRunningTurnCount((count) => {
      counts.push(count)
    })
    const thread = await manager.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    expect(manager.runningTurnCount).toBe(1)

    mayFinish.resolve()
    await nextEventOfType(thread, "turn.completed")
    expect(manager.runningTurnCount).toBe(0)
    expect(counts).toContain(0)

    unsubscribe()
    await manager.shutdown()
  })

  it("routes turn input atomically as Started, Steered, or NotSubmitted", async () => {
    const mayFinish = deferred<void>()
    const steering: string[] = []
    const manager = createManager({
      async run(_session, _input, control) {
        await mayFinish.promise
        steering.push(
          ...control.takeSteering().map((item) => item.content.text),
        )
      },
    })
    const thread = await manager.createThread()
    expect(thread.agentStatus).toBe("pending_init")

    const started = await thread.startIfIdle({
      submissionId: "turn_first",
      content: { kind: "text", text: "first" },
    })
    expect(started).toEqual({ type: "started", turnId: "turn_first" })
    expect(thread.agentStatus).toBe("running")
    expect(
      await thread.startIfIdle({
        content: { kind: "text", text: "must not queue" },
      }),
    ).toEqual({ type: "not_submitted", reason: "not_idle" })
    expect(
      await thread.steer(
        { content: { kind: "text", text: "wrong" } },
        "turn_previous",
      ),
    ).toEqual({ type: "not_submitted", reason: "turn_mismatch" })
    expect(
      await thread.startOrSteer({
        content: { kind: "text", text: "correction one" },
      }),
    ).toEqual({ type: "steered", turnId: "turn_first" })
    expect(
      await thread.steer(
        { content: { kind: "text", text: "correction two" } },
        "turn_first",
      ),
    ).toEqual({ type: "steered", turnId: "turn_first" })

    mayFinish.resolve()
    await nextEventOfType(thread, "turn.completed")
    expect(steering).toEqual(["correction one", "correction two"])
    expect(thread.status).toBe(SessionStatus.Idle)
    expect(thread.agentStatus).toEqual({ completed: null })
    await manager.shutdown()
  })

  it("rejects steering once the active task has atomically closed its input", async () => {
    const closed = deferred<void>()
    const mayFinish = deferred<void>()
    const manager = createManager({
      async run(_runtime, _input, control) {
        expect(control.takeSteeringOrComplete()).toEqual({ type: "complete" })
        closed.resolve()
        await mayFinish.promise
      },
    })
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_closing",
      content: { kind: "text", text: "run" },
    })
    await closed.promise

    await expect(
      thread.startOrSteer({ content: { kind: "text", text: "too late" } }),
    ).resolves.toEqual({ type: "not_submitted", reason: "not_idle" })
    await expect(
      thread.steer(
        { content: { kind: "text", text: "too late" } },
        "turn_closing",
      ),
    ).resolves.toEqual({ type: "not_submitted", reason: "no_active_turn" })

    mayFinish.resolve()
    await nextEventOfType(thread, "turn.completed")
    await manager.shutdown()
  })

  it("deduplicates durable submissions and compares cancellation inside the actor", async () => {
    const mayFinish = deferred<void>()
    const store = new MemoryThreadStore()
    const manager = createManager(
      {
        async run() {
          await mayFinish.promise
        },
      },
      store,
    )
    const thread = await manager.createThread()
    const input = {
      submissionId: "turn_idempotent",
      content: { kind: "text" as const, text: "once" },
    }
    expect(await thread.startIfIdle(input)).toEqual({
      type: "started",
      turnId: "turn_idempotent",
    })
    const inputItemId = thread.snapshot().context.history[0]?.id
    expect(await thread.startIfIdle(input)).toEqual({
      type: "replayed",
      turnId: "turn_idempotent",
      inputItemId,
    })
    expect(
      await thread.startIfIdle({
        ...input,
        content: { kind: "text", text: "different" },
      }),
    ).toEqual({ type: "not_submitted", reason: "request_conflict" })
    expect(await thread.interruptTurn("turn_other")).toBe(false)
    expect(await thread.interruptTurn("turn_idempotent", "cancelled")).toBe(
      true,
    )
    await nextEventOfType(thread, "turn.interrupted")
    await manager.shutdown()

    const resumedManager = createManager({ run: async () => undefined }, store)
    const resumed = await resumedManager.resumeThread(thread.id)
    expect(await resumed?.startIfIdle(input)).toEqual({
      type: "replayed",
      turnId: "turn_idempotent",
      inputItemId,
    })
    await resumedManager.shutdown()
    mayFinish.resolve()
  })

  it("does not admit or mutate a Turn when preparation fails", async () => {
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () => ({
        prepare() {
          throw new Error("configuration unavailable")
        },
        start() {
          throw new Error("unreachable")
        },
      }),
    })
    const thread = await manager.createThread()

    await expect(
      thread.startIfIdle({
        content: { kind: "text", text: "must not persist" },
      }),
    ).rejects.toThrow("configuration unavailable")
    expect(thread.status).toBe(SessionStatus.Idle)
    expect(thread.agentStatus).toEqual({
      errored: "configuration unavailable",
    })
    expect(thread.snapshot()).toMatchObject({
      context: { history: [] },
    })
    expect(thread.snapshot().configuration).toBeUndefined()
    expect(
      (await store.readThread(thread.id))?.rollout.map(
        (entry) => entry.item.type,
      ),
    ).toEqual(["session_meta", "agent_status"])
    await manager.shutdown()

    const resumedManager = createManager({ run: async () => undefined }, store)
    const resumed = await resumedManager.resumeThread(thread.id)
    expect(resumed?.agentStatus).toEqual({
      errored: "configuration unavailable",
    })
    await resumedManager.shutdown()
  })

  it("survives synchronous processor failures and reports aborts as interruption", async () => {
    let call = 0
    const manager = createManager({
      run(_session, _input, control) {
        call += 1
        if (call === 1) throw new Error("sync failure")
        return new Promise((_resolve, reject) => {
          control.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      },
    })
    const thread = await manager.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "fail" } })
    expect(await nextEventOfType(thread, "session.error")).toMatchObject({
      message: "sync failure",
    })
    expect(thread.status).toBe(SessionStatus.Idle)
    expect(thread.agentStatus).toEqual({ errored: "sync failure" })

    await thread.startIfIdle({
      submissionId: "turn_abort",
      content: { kind: "text", text: "abort" },
    })
    await thread.interrupt("user_cancelled")
    expect(await nextEventOfType(thread, "turn.interrupted")).toMatchObject({
      reason: "user_cancelled",
    })
    expect(thread.status).toBe(SessionStatus.Idle)
    expect(thread.agentStatus).toBe("interrupted")
    await manager.shutdown()
  })

  it("force-settles an interrupted Turn whose processor ignores abort", async () => {
    let lateWrite: Promise<void> | undefined
    let abortCalls = 0
    const never = deferred<void>()
    const manager = createManager({
      async run(runtime) {
        await never.promise
        lateWrite = runtime.recordConversationItems([])
      },
      abort() {
        abortCalls += 1
      },
    })
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_stuck",
      content: { kind: "text", text: "stuck" },
    })

    await thread.interrupt("forced")
    await nextEventOfType(thread, "turn.interrupted")

    expect(thread.status).toBe(SessionStatus.Idle)
    expect(abortCalls).toBe(1)
    never.resolve()
    await Promise.resolve()
    await expect(lateWrite).rejects.toThrow("no longer active")
    await manager.shutdown()
  })

  it("releases the active Turn even when hard abort throws", async () => {
    const never = deferred<void>()
    const manager = createManager({
      run: async () => never.promise,
      abort() {
        throw new Error("kill failed")
      },
    })
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_abort_throws",
      content: { kind: "text", text: "stuck" },
    })

    await thread.interrupt("forced")
    expect(await nextEventOfType(thread, "session.error")).toMatchObject({
      operation: "interrupt",
      message: "kill failed",
    })
    expect(await nextEventOfType(thread, "turn.interrupted")).toMatchObject({
      reason: "forced",
    })
    expect(thread.status).toBe(SessionStatus.Idle)

    never.resolve()
    await manager.shutdown()
  })

  it("persists the input and TurnStart fence before returning Started", async () => {
    const store = new MemoryThreadStore()
    const mayFinish = deferred<void>()
    const manager = createManager({ run: async () => mayFinish.promise }, store)
    const thread = await manager.createThread()

    expect(
      await thread.startIfIdle({
        submissionId: "turn_durable",
        content: { kind: "text", text: "durable" },
      }),
    ).toEqual({ type: "started", turnId: "turn_durable" })
    const storedAtStart = await store.readThread(thread.id)
    expect(storedAtStart?.rollout.map((entry) => entry.item.type)).toEqual([
      "session_meta",
      "response_item",
      "turn_context",
      "turn_started",
    ])

    mayFinish.resolve()
    await nextEventOfType(thread, "turn.completed")
    expect(
      (await store.readThread(thread.id))?.rollout.at(-1)?.item,
    ).toMatchObject({ type: "turn_completed", outcome: "completed" })
    await manager.shutdown()
  })

  it("preserves image attachments in the durable initial user item", async () => {
    const store = new MemoryThreadStore()
    const manager = createManager({ run: async () => undefined }, store)
    const thread = await manager.createThread()

    await thread.startIfIdle({
      submissionId: "turn_image",
      content: {
        kind: "text",
        text: "inspect",
        attachments: [
          {
            name: "screen.png",
            mediaType: "image/png",
            sizeBytes: 123,
            detail: "original",
            file: { rolloutId: thread.id, path: "attachments/screen.png" },
          },
        ],
      },
    })
    await nextEventOfType(thread, "turn.completed")

    const stored = await store.readThread(thread.id)
    const input = stored?.rollout.find(
      (entry) => entry.item.type === "response_item",
    )
    expect(input?.item).toMatchObject({
      type: "response_item",
      item: {
        item: {
          role: "user",
          images: [
            {
              mediaType: "image/png",
              detail: "original",
              file: {
                rolloutId: thread.id,
                path: "attachments/screen.png",
              },
              sizeBytes: 123,
            },
          ],
        },
      },
    })
    await manager.shutdown()
  })

  it("flushes a buffered terminal item before publishing its event", async () => {
    const store = new MemoryThreadStore()
    const mayFinish = deferred<void>()
    const persistenceErrors: unknown[] = []
    const manager = new ThreadManager({
      store,
      onPersistenceError: (error) => persistenceErrors.push(error),
      createTurnProcessor: () =>
        withPreparation({ run: async () => mayFinish.promise }),
    })
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_terminal_retry",
      content: { kind: "text", text: "finish" },
    })

    store.failNextAppend = true
    mayFinish.resolve()
    await nextEventOfType(thread, "turn.completed")

    expect((await store.readThread(thread.id))?.rollout.at(-1)?.item).toEqual({
      type: "turn_completed",
      turnId: "turn_terminal_retry",
      outcome: "completed",
    })
    expect(persistenceErrors).toEqual([expect.any(Error)])
    await manager.shutdown()
  })

  it("keeps the Turn active until its terminal rollout and event are published", async () => {
    const store = new MemoryThreadStore()
    const mayFinish = deferred<void>()
    const terminalFlushStarted = deferred<void>()
    const terminalMayFlush = deferred<void>()
    const manager = createManager({ run: async () => mayFinish.promise }, store)
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_terminal_fence",
      content: { kind: "text", text: "finish" },
    })
    store.flushStarted = () => terminalFlushStarted.resolve()
    store.flushBarrier = terminalMayFlush.promise

    mayFinish.resolve()
    await terminalFlushStarted.promise
    expect(thread.status).toBe(SessionStatus.Active)
    await expect(
      thread.startIfIdle({ content: { kind: "text", text: "too early" } }),
    ).resolves.toEqual({ type: "not_submitted", reason: "not_idle" })

    terminalMayFlush.resolve()
    await nextEventOfType(thread, "turn.completed")
    expect(thread.status).toBe(SessionStatus.Idle)
    await manager.shutdown()
  })

  it("retries the unwritten rollout suffix after an append failure", async () => {
    const store = new MemoryThreadStore()
    store.failNextAppend = true
    const persistenceErrors: unknown[] = []
    const manager = new ThreadManager({
      store,
      onPersistenceError: (error) => persistenceErrors.push(error),
      createTurnProcessor: () =>
        withPreparation({
          run: async () => undefined,
        }),
    })
    const thread = await manager.createThread()

    await thread.startIfIdle({
      submissionId: "item_first",
      content: { kind: "text", text: "first" },
    })
    await nextEventOfType(thread, "turn.completed")
    expect(
      thread.snapshot().context.history.map((item) => item.turnId),
    ).toContain("item_first")

    await thread.startIfIdle({
      submissionId: "item_second",
      content: { kind: "text", text: "second" },
    })
    await nextEventOfType(thread, "turn.completed")
    await manager.shutdown()

    const stored = await store.readThread(thread.id)
    expect(
      stored?.rollout.flatMap((entry) =>
        entry.item.type === "response_item" &&
        entry.item.item.item.role === "user"
          ? [entry.item.item.turnId]
          : [],
      ),
    ).toEqual(["item_first", "item_second"])
    expect(persistenceErrors).toEqual([expect.any(Error)])
  })

  it("holds a stable fork barrier while later input waits in the mailbox", async () => {
    const firstMayAbort = deferred<void>()
    const forkStarted = deferred<void>()
    const forkMayFinish = deferred<void>()
    const store = new MemoryThreadStore()
    store.prepareForkStarted = () => forkStarted.resolve()
    store.createForkBarrier = forkMayFinish.promise
    const manager = createManager(
      {
        async run(_session, input, control) {
          if (input.submissionId !== "item_cut") return
          if (control.signal.aborted) firstMayAbort.resolve()
          else {
            control.signal.addEventListener("abort", () =>
              firstMayAbort.resolve(),
            )
          }
          await firstMayAbort.promise
        },
      },
      store,
    )
    const source = await manager.createThread()
    await source.startIfIdle({
      submissionId: "item_before",
      content: { kind: "text", text: "before" },
    })
    await nextEventOfType(source, "turn.completed")
    await source.startIfIdle({
      submissionId: "item_cut",
      content: { kind: "text", text: "cut" },
    })

    const forkPromise = manager.forkThread({
      sourceThreadId: source.id,
      beforeTurnId: "item_cut",
    })
    await forkStarted.promise
    const laterInput = source.startIfIdle({
      submissionId: "item_later",
      content: { kind: "text", text: "later" },
    })
    let laterSettled = false
    void laterInput.finally(() => {
      laterSettled = true
    })
    await Promise.resolve()
    expect(laterSettled).toBe(false)
    forkMayFinish.resolve()
    const { thread: fork } = await forkPromise

    expect(fork.snapshot().context.history.map((item) => item.turnId)).toEqual([
      "item_before",
    ])
    expect(await laterInput).toEqual({ type: "started", turnId: "item_later" })
    await nextEventOfType(source, "turn.completed")
    expect(source.status).toBe(SessionStatus.Idle)
    await manager.shutdown()
  })

  it("completes teardown and unregisters the Thread when persistence cleanup fails", async () => {
    const store = new MemoryThreadStore()
    const manager = createManager({ run: async () => undefined }, store)
    const thread = await manager.createThread()
    store.failNextFlush = true
    store.failNextShutdown = true

    await thread.shutdownAndWait()

    expect(thread.status).toBe(SessionStatus.Shutdown)
    expect(manager.getThread(thread.id)).toBeUndefined()
    const resumed = await manager.resumeThread(thread.id)
    expect(resumed?.status).toBe(SessionStatus.Idle)
    await manager.shutdown()
  })

  it("disposes processor-owned live resources during Session shutdown", async () => {
    let disposals = 0
    const manager = createManager({
      run() {},
      dispose() {
        disposals += 1
      },
    })
    const thread = await manager.createThread()

    await thread.shutdownAndWait()

    expect(disposals).toBe(1)
    await manager.shutdown()
    expect(disposals).toBe(1)
  })

  it("isolates throwing persistence observers from teardown", async () => {
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      onPersistenceError() {
        throw new Error("observer failed")
      },
      createTurnProcessor: () =>
        withPreparation({ run: async () => undefined }),
    })
    const thread = await manager.createThread()
    store.failNextFlush = true
    store.failNextShutdown = true

    await thread.shutdownAndWait()

    expect(thread.status).toBe(SessionStatus.Shutdown)
    expect(manager.getThread(thread.id)).toBeUndefined()
  })

  it("serializes resume with manager shutdown and cannot install an orphan", async () => {
    const store = new MemoryThreadStore()
    const creator = createManager({ run: async () => undefined }, store)
    const created = await creator.createThread()
    await creator.shutdown()

    const resumeMayFinish = deferred<void>()
    store.resumeBarrier = resumeMayFinish.promise
    const manager = createManager({ run: async () => undefined }, store)
    const resume = manager.resumeThread(created.id)
    const shutdown = manager.shutdown()
    const concurrentShutdown = manager.shutdown()
    let concurrentShutdownSettled = false
    void concurrentShutdown.finally(() => {
      concurrentShutdownSettled = true
    })
    await Promise.resolve()
    expect(concurrentShutdownSettled).toBe(false)
    resumeMayFinish.resolve()
    await expect(resume).rejects.toThrow("shut down while resuming")
    await Promise.all([shutdown, concurrentShutdown])

    expect(manager.getThread(created.id)).toBeUndefined()
  })

  it("releases a failed fork reservation and leaves no phantom target", async () => {
    const store = new MemoryThreadStore()
    const manager = createManager({ run: async () => undefined }, store)
    const source = await manager.createThread()
    await source.startIfIdle({
      submissionId: "turn_source",
      content: { kind: "text", text: "source" },
    })
    await nextEventOfType(source, "turn.completed")
    store.failNextCreateFork = true

    await expect(
      manager.forkThread({
        sourceThreadId: source.id,
        beforeTurnId: "turn_source",
      }),
    ).rejects.toThrow("create fork failed")
    expect((await manager.listThreads()).threads).toHaveLength(1)

    await manager.discardThread(source.id)
    expect(await store.readThread(source.id)).toBeUndefined()
    await manager.shutdown()
  })

  it("protects a source while a prepared fork reservation is live", async () => {
    const store = new MemoryThreadStore()
    const manager = createManager({ run: async () => undefined }, store)
    const source = await manager.createThread()
    const prepared = await store.prepareFork({
      sourceThreadId: source.id,
      boundary: { type: "latest" },
    })

    await expect(store.deleteThread(source.id)).rejects.toThrow(
      "active fork reservation",
    )
    await store.releasePreparedFork(prepared)
    await manager.discardThread(source.id)
    expect(await store.readThread(source.id)).toBeUndefined()
    await manager.shutdown()
  })

  it("isolates status subscriber exceptions from Turn completion", async () => {
    const manager = createManager({ run: async () => undefined })
    const thread = await manager.createThread()
    thread.subscribeStatus(() => {
      throw new Error("observer failed")
    })

    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await nextEventOfType(thread, "turn.completed")

    expect(thread.status).toBe(SessionStatus.Idle)
    await manager.shutdown()
  })

  it("does not reuse a previous Turn answer when a follow-up has no assistant text", async () => {
    let call = 0
    const manager = createManager({
      async run(runtime, input) {
        call += 1
        if (call !== 1) return
        await runtime.recordConversationItems([
          {
            id: "message_first_answer",
            turnId: input.submissionId,
            createdAt: new Date().toISOString(),
            item: {
              role: "assistant",
              content: [{ type: "text", text: "first answer" }],
            },
          },
        ])
      },
    })
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_with_answer",
      content: { kind: "text", text: "first" },
    })
    await nextEventOfType(thread, "turn.completed")
    expect(thread.agentStatus).toEqual({ completed: "first answer" })

    await thread.startIfIdle({
      submissionId: "turn_without_answer",
      content: { kind: "text", text: "second" },
    })
    await nextEventOfType(thread, "turn.completed")
    expect(thread.agentStatus).toEqual({ completed: null })
    await manager.shutdown()
  })

  it("deduplicates a stable agent message after its first flush fails", async () => {
    const store = new MemoryThreadStore()
    const manager = createManager({ run() {} }, store)
    const thread = await manager.createThread()
    store.failNextFlush = true

    await expect(
      thread.deliverAgentMessage("agent_message_stable", "retry-safe"),
    ).rejects.toThrow("flush failed")
    await thread.deliverAgentMessage("agent_message_stable", "retry-safe")

    const stored = await store.readThread(thread.id)
    expect(
      stored?.rollout.filter(
        (record) =>
          record.item.type === "agent_message" &&
          record.item.messageId === "agent_message_stable",
      ),
    ).toHaveLength(1)
    expect(
      stored?.rollout.filter(
        (record) =>
          record.item.type === "agent_message" &&
          record.item.item.id === "agent_message_stable",
      ),
    ).toHaveLength(1)
    await manager.shutdown()
  })

  it("preserves an accepted agent message when compaction follows a failed flush", async () => {
    const snapshotTaken = deferred<void>()
    const releaseCompaction = deferred<void>()
    const store = new MemoryThreadStore()
    const manager = createManager(
      {
        async run(runtime) {
          const snapshot = runtime.snapshot()
          snapshotTaken.resolve()
          await releaseCompaction.promise
          await runtime.replaceConversationHistory({
            replacement: [],
            summary: "checkpoint",
            baseContextRevision: snapshot.contextRevision,
            baseHistoryLength: snapshot.context.history.length,
          })
        },
      },
      store,
    )
    const thread = await manager.createThread()
    await thread.startIfIdle({
      submissionId: "turn_compaction_race",
      content: { kind: "text", text: "compact" },
    })
    await snapshotTaken.promise
    store.failNextFlush = true
    await expect(
      thread.deliverAgentMessage("agent_message_race", "must survive"),
    ).rejects.toThrow("flush failed")
    releaseCompaction.resolve()
    await nextEventOfType(thread, "turn.completed")
    await manager.shutdown()

    const resumedManager = createManager({ run() {} }, store)
    const resumed = await resumedManager.resumeThread(thread.id)
    expect(
      resumed
        ?.snapshot()
        .context.history.some((message) => message.id === "agent_message_race"),
    ).toBe(true)
    await resumedManager.shutdown()
  })
})

function createManager(
  processor: TestProcessor,
  store: MemoryThreadStore = new MemoryThreadStore(),
): ThreadManager {
  return new ThreadManager({
    store,
    createTurnProcessor: () => withPreparation(processor),
  })
}

type TestProcessor = {
  run(
    runtime: TurnRuntime,
    input: TurnInput,
    control: TurnControl,
  ): Promise<void> | void
  abort?(): void
  dispose?(): void | Promise<void>
}

function withPreparation(processor: TestProcessor): TurnProcessor {
  return {
    dispose: () => processor.dispose?.(),
    prepare(_snapshot, input) {
      const selection = { provider: "faux", model: "scripted" }
      return {
        turnId: input.submissionId,
        selection,
        configuration: SessionConfiguration.create({
          selection,
          workspaceRoot: "/workspace",
          enabledTools: [],
          approvalPolicy: "always_approve",
          promptCacheKey: input.submissionId,
        }).snapshot,
      }
    },
    start(runtime, input, _context, control) {
      let completion: Promise<void>
      try {
        completion = Promise.resolve(processor.run(runtime, input, control))
      } catch (error) {
        completion = Promise.reject(error)
      }
      return {
        completion,
        abort: () => processor.abort?.(),
      }
    },
  }
}

async function nextEventOfType<
  Type extends NonNullable<
    Awaited<
      ReturnType<
        import("../../src/core/agent-thread.ts").AgentThread["nextEvent"]
      >
    >
  >["type"],
>(thread: import("../../src/core/agent-thread.ts").AgentThread, type: Type) {
  for (;;) {
    const event = await thread.nextEvent()
    if (event === undefined) throw new Error(`Session ended before ${type}.`)
    if (event.type === type) return event
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}
