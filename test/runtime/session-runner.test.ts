import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createDurableEventHub,
  createFauxProvider,
  createMateKernel,
  createRuntimeLimits,
  createSessionKernel,
  createSessionRunner,
  createSqliteEventStore,
  createSqliteMateStore,
  createTransientEventHub,
  EventType,
  ModelStopReason,
  type EventEnvelope,
  type LiveSessionEvent,
} from "../../src/index.ts"

describe("session runner", () => {
  it("runs a text-only turn with exact durable journal sequence and replay", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          snapshots: ["He", "Hello"],
          content: [{ type: "text", text: "Hello" }],
          stopReason: ModelStopReason.EndTurn,
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        durableHub: runtime.durableHub,
      })

      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "hi" },
      })
      await runner.wake(session.sessionId)

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(replayed.events.map((event) => event.type)).toEqual([
        EventType.SessionCreated,
        EventType.InputAdmitted,
        EventType.TurnStarted,
        EventType.AssistantMessage,
        EventType.TurnCompleted,
      ])
      expect(replayed.session?.completedTurns).toHaveLength(1)
      expect(replayed.session?.items).toEqual([
        expect.objectContaining({
          kind: "assistant_message",
          status: "completed",
          content: { kind: "text", text: "Hello" },
        }),
      ])
      expect(replayed.session?.activeTurn).toBeUndefined()
      expect(provider.callCount).toBe(1)
    })
  })

  it("processes two queued Inputs as sequential Turns in admission order", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "one" }] },
        { content: [{ type: "text", text: "two" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_1",
        content: { kind: "text", text: "first" },
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_2",
        content: { kind: "text", text: "second" },
      })

      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns).toHaveLength(2)
      expect(read.session?.items.map((item) => item.content)).toEqual([
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ])
      expect(
        provider.requests.map((request) => request.messages.at(-1)),
      ).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "first" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second" }],
        },
      ])
    })
  })

  it("shares one execution lane across concurrent wakes", async () => {
    await withRuntime(async (runtime) => {
      let activeCalls = 0
      let maxActive = 0
      const provider = createFauxProvider([
        {
          snapshots: ["x"],
          content: [{ type: "text", text: "done" }],
        },
      ])
      const stream: typeof provider.stream = async function* (request) {
        activeCalls += 1
        maxActive = Math.max(maxActive, activeCalls)
        try {
          yield* provider.stream(request)
        } finally {
          activeCalls -= 1
        }
      }

      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "only one" },
      })

      await Promise.all([
        runner.wake(session.sessionId),
        runner.wake(session.sessionId),
        runner.wake(session.sessionId),
      ])

      expect(maxActive).toBe(1)
      expect(provider.callCount).toBe(1)
    })
  })

  it("does not lose a wake that arrives at worker shutdown", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first" }] },
        { content: [{ type: "text", text: "second" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_a",
        content: { kind: "text", text: "a" },
      })

      const firstWake = runner.wake(session.sessionId)
      // Admit the second input while the first wake is finishing.
      await firstWake
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_b",
        content: { kind: "text", text: "b" },
      })
      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns).toHaveLength(2)
      expect(provider.callCount).toBe(2)
    })
  })

  it("includes prior successful history in the second model request", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first reply" }] },
        { content: [{ type: "text", text: "second reply" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_1",
        content: { kind: "text", text: "hello" },
      })
      await runner.wake(session.sessionId)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_2",
        content: { kind: "text", text: "again" },
      })
      await runner.wake(session.sessionId)

      expect(provider.requests[1]?.messages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "first reply" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "again" }],
        },
      ])
    })
  })

  it("publishes snapshots to the transient hub but not to durable replay", async () => {
    await withRuntime(async (runtime) => {
      const live: LiveSessionEvent[] = []
      const durable: EventEnvelope[] = []
      runtime.durableHub.subscribe("unused", () => undefined)
      const transientHub = createTransientEventHub()
      const provider = createFauxProvider([
        {
          snapshots: ["partial", "final text"],
          content: [{ type: "text", text: "final text" }],
        },
      ])
      const session = await createAttributedSession(runtime)
      transientHub.subscribe(session.sessionId, (event) => {
        live.push(event)
      })
      runtime.durableHub.subscribe(session.sessionId, (events) => {
        durable.push(...events)
      })

      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        durableHub: runtime.durableHub,
        transientHub,
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "stream please" },
      })
      await runner.wake(session.sessionId)

      expect(live.length).toBeGreaterThan(0)
      expect(live.every((event) => event.type === "assistant.snapshot")).toBe(
        true,
      )
      expect(
        durable.some((event) => event.type === EventType.AssistantMessage),
      ).toBe(true)
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(
        replayed.events.every(
          (event) => event.type !== ("assistant.snapshot" as typeof event.type),
        ),
      ).toBe(true)
    })
  })

  it("maps throw, premature end, length, oversized output, budget, and abort to terminals", async () => {
    await withRuntime(async (runtime) => {
      await expectTerminal(
        runtime,
        [{ throwDuring: new Error("boom") }],
        "failed",
      )
      await expectTerminal(runtime, [{ endWithoutResponse: true }], "failed")
      await expectTerminal(
        runtime,
        [{ stopReason: ModelStopReason.Length, content: [] }],
        "failed",
      )
      await expectTerminal(
        runtime,
        [
          {
            content: [{ type: "text", text: "x".repeat(2_000) }],
          },
        ],
        "failed",
        createRuntimeLimits({ assistantResponseBytes: 100 }),
      )
      await expectTerminal(
        runtime,
        [{ content: [{ type: "text", text: "never used" }] }],
        "failed",
        createRuntimeLimits({ modelCallsPerTurn: 0 }),
      )

      const abortProvider = createFauxProvider([{ waitForAbort: true }])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: abortProvider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "abort me" },
      })
      const wake = runner.wake(session.sessionId)
      // Wait until a turn is active, then interrupt.
      for (;;) {
        const read = await runtime.kernel.readSession({
          sessionId: session.sessionId,
        })
        if (read.session?.activeTurn) {
          await runner.interrupt({
            sessionId: session.sessionId,
            turnId: read.session.activeTurn.turnId,
            reason: "user_cancel",
          })
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await wake
      const final = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(final.session?.cancelledTurns).toHaveLength(1)
    })
  })

  it("aborts in-memory execution on shutdown without claiming cancellation", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([{ waitForAbort: true }])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "stay active" },
      })
      const wake = runner.wake(session.sessionId)
      for (;;) {
        const read = await runtime.kernel.readSession({
          sessionId: session.sessionId,
        })
        if (read.session?.activeTurn) break
        await new Promise((resolve) => setTimeout(resolve, 1))
      }

      await runner.close()
      await wake

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.activeTurn).toBeDefined()
      expect(read.session?.cancelledTurns).toEqual([])
      expect(read.session?.interruptedTurns).toEqual([])
    })
  })
})

async function expectTerminal(
  runtime: RuntimeContext,
  script: Parameters<typeof createFauxProvider>[0],
  terminal: "failed" | "cancelled",
  limits = createRuntimeLimits(),
): Promise<void> {
  const provider = createFauxProvider(script)
  const runner = createSessionRunner({
    kernel: runtime.kernel,
    mateKernel: runtime.mateKernel,
    stream: provider.stream,
    limits,
  })
  const session = await createAttributedSession(runtime)
  await runtime.kernel.admitInput({
    sessionId: session.sessionId,
    content: { kind: "text", text: "case" },
  })
  await runner.wake(session.sessionId)
  const read = await runtime.kernel.readSession({
    sessionId: session.sessionId,
  })
  if (terminal === "failed") {
    expect(read.session?.failedTurns.length).toBeGreaterThan(0)
  } else {
    expect(read.session?.cancelledTurns.length).toBeGreaterThan(0)
  }
  expect(read.session?.activeTurn).toBeUndefined()
}

type RuntimeContext = {
  readonly kernel: ReturnType<typeof createSessionKernel>
  readonly mateKernel: ReturnType<typeof createMateKernel>
  readonly durableHub: ReturnType<typeof createDurableEventHub>
  readonly rootDir: string
}

async function createAttributedSession(runtime: RuntimeContext) {
  const mate = await runtime.mateKernel.createMate({
    instructions: "Answer briefly.",
    name: "RunnerMate",
    role: "Assistant",
  })
  return runtime.kernel.createSession({
    title: "runner",
    workingDirectory: runtime.rootDir,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
}

async function withRuntime(run: (runtime: RuntimeContext) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-runner-"))
  const eventStore = createSqliteEventStore({ rootDir })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "events.sqlite"),
  })
  const runtime: RuntimeContext = {
    kernel: createSessionKernel(eventStore),
    mateKernel: createMateKernel(mateStore),
    durableHub: createDurableEventHub(),
    rootDir,
  }
  try {
    await run(runtime)
  } finally {
    mateStore.close()
    eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}
