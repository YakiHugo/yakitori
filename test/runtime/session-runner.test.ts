import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  COMPACT_DIRECTIVE,
  createDurableEventHub,
  createFauxProvider,
  createMateKernel,
  createProviderRegistry,
  createRuntimeLimits,
  createSessionKernel,
  createSessionRunner,
  createJsonlEventStore,
  createSqliteMateStore,
  createTransientEventHub,
  createYakitoriError,
  EventType,
  InputRole,
  ModelStopReason,
  SessionConfiguration,
  YakitoriErrorCode,
  type EventEnvelope,
  type ContextWindowReplacement,
  type LiveSessionEvent,
  type ModelContentBlock,
  type ModelRequest,
  type ModelStopReason as ModelStopReasonType,
  type StreamFn,
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
        EventType.SessionConfigured,
        EventType.TurnStarted,
        EventType.WorldStateUpdated,
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

  it("switches the next Turn target and inherits it for later Inputs", async () => {
    await withRuntime(async (runtime) => {
      const defaultProvider = createFauxProvider([
        { content: [{ type: "text", text: "default" }] },
      ])
      const selectedProvider = createFauxProvider([
        { content: [{ type: "text", text: "selected" }] },
        { content: [{ type: "text", text: "inherited" }] },
      ])
      const providers = createProviderRegistry({
        faux: defaultProvider.stream,
        anthropic: selectedProvider.stream,
      })
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: providers.stream,
        provider: "faux",
        model: "scripted",
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_default",
        content: { kind: "text", text: "first" },
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_switch",
        content: { kind: "text", text: "second" },
        modelSelection: {
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_inherit",
        content: { kind: "text", text: "third" },
      })

      await runner.wake(session.sessionId)

      expect(defaultProvider.callCount).toBe(1)
      expect(selectedProvider.callCount).toBe(2)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(
        read.session?.turns.map((turn) => ({
          provider: turn.executionContext?.provider,
          model: turn.executionContext?.model,
          promptId: turn.executionContext?.promptId,
        })),
      ).toEqual([
        { provider: "faux", model: "scripted", promptId: "default" },
        {
          provider: "anthropic",
          model: "claude-opus-4-6",
          promptId: "anthropic",
        },
        {
          provider: "anthropic",
          model: "claude-opus-4-6",
          promptId: "anthropic",
        },
      ])
    })
  })

  it("carries a selected effort into the context and inherits it for later Inputs", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "selected" }] },
        { content: [{ type: "text", text: "inherited" }] },
      ])
      const providers = createProviderRegistry({ openai: provider.stream })
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: providers.stream,
        provider: "faux",
        model: "scripted",
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_effort",
        content: { kind: "text", text: "first" },
        modelSelection: {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "high",
          speed: "fast",
        },
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        requestId: "request_inherit_effort",
        content: { kind: "text", text: "second" },
      })

      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(
        read.session?.turns.map((turn) => ({
          provider: turn.executionContext?.provider,
          model: turn.executionContext?.model,
          effort: turn.executionContext?.effort,
          speed: turn.executionContext?.speed,
        })),
      ).toEqual([
        {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "high",
          speed: "fast",
        },
        {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "high",
          speed: "fast",
        },
      ])
      expect(
        provider.requests.map((request) => ({
          effort: request.target.effort,
          speed: request.target.speed,
        })),
      ).toEqual([
        { effort: "high", speed: "fast" },
        { effort: "high", speed: "fast" },
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

  it("keeps the lane alive when a queued Input is cancelled before startTurn", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "second answer" }] },
      ])
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "cancelled" },
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "survivor" },
      })

      // Simulate the cancel race: the Input is consumed between the lane's
      // readSession and startTurn, so startTurn rejects InvalidState for an
      // Input that is no longer Admitted.
      const realStartTurn = runtime.kernel.startTurn.bind(runtime.kernel)
      let startTurnCalls = 0
      const kernel: typeof runtime.kernel = {
        ...runtime.kernel,
        async startTurn(input) {
          startTurnCalls += 1
          if (startTurnCalls === 1) {
            await runtime.kernel.cancelInput({
              sessionId: input.sessionId,
              inputId: input.inputId,
              reason: "user_cancel",
            })
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: `Input ${input.inputId} is already Cancelled.`,
            })
          }
          return realStartTurn(input)
        },
      }
      const runner = createSessionRunner({
        kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })

      await runner.wake(session.sessionId)

      expect(startTurnCalls).toBe(2)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns).toHaveLength(1)
      expect(read.session?.items.map((item) => item.content)).toEqual([
        { kind: "text", text: "second answer" },
      ])
      expect(provider.callCount).toBe(1)
    })
  })

  it("reports a startTurn InvalidState that is not a cancel race", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "unused" }] },
      ])
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first" },
      })

      // The Input stays pending, so this InvalidState is a real conflict and
      // must surface through onRuntimeError instead of being swallowed.
      const thrown = createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Simulated active-turn conflict.",
      })
      let startTurnCalls = 0
      const kernel: typeof runtime.kernel = {
        ...runtime.kernel,
        async startTurn(input) {
          startTurnCalls += 1
          if (startTurnCalls === 1) throw thrown
          return runtime.kernel.startTurn(input)
        },
      }
      const runtimeErrors: unknown[] = []
      const runner = createSessionRunner({
        kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        onRuntimeError: (error) => {
          runtimeErrors.push(error)
        },
      })

      await runner.wake(session.sessionId)

      expect(runtimeErrors).toEqual([thrown])
      expect(provider.callCount).toBe(0)
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
          role: "developer",
          content: [
            {
              type: "text",
              text: expect.stringContaining("<multi_agent_context>"),
            },
          ],
          context: {
            type: "world_state",
            sectionId: "multi_agent",
            revision: expect.any(String),
          },
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: expect.stringContaining("<environment>"),
            },
          ],
          context: {
            type: "world_state",
            sectionId: "environment",
            revision: expect.any(String),
          },
        },
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

  it("keeps persisted base instructions and emits one developer model-switch fragment", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first reply" }] },
        { content: [{ type: "text", text: "second reply" }] },
        { content: [{ type: "text", text: "third reply" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first" },
      })
      await runner.wake(session.sessionId)
      for (const text of ["switch", "continue"]) {
        await runtime.kernel.admitInput({
          sessionId: session.sessionId,
          content: { kind: "text", text },
          modelSelection: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        })
        await runner.wake(session.sessionId)
      }

      expect(provider.requests[1]?.system).toEqual(provider.requests[0]?.system)
      expect(provider.requests[2]?.system).toEqual(provider.requests[0]?.system)
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const modelFragments = replayed.session?.worldStateUpdates.flatMap(
        (update) =>
          update.fragments.filter((fragment) => fragment.id === "model"),
      )
      expect(modelFragments).toHaveLength(1)
      expect(modelFragments?.[0]).toMatchObject({
        role: "developer",
        text: expect.stringContaining("<model_switch>"),
      })
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        "<model_switch>",
      )
    })
  })

  it("keeps only base instructions in system and records world state", async () => {
    await withRuntime(async (runtime) => {
      await writeFile(join(runtime.rootDir, "AGENTS.md"), "Use focused tests.")
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "ok" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "hi" },
      })
      await runner.wake(session.sessionId)

      const system = provider.requests[0]?.system
      expect(system?.[0]?.text).toContain(
        "You are Yakitori, a coding agent working with the user in their local workspace.",
      )
      expect(system?.map((section) => section.id)).toEqual([
        "base.instructions",
      ])
      const visible = JSON.stringify(provider.requests[0]?.messages)
      expect(visible).toContain("Use focused tests.")
      expect(visible).toContain("<environment>")
      expect(visible).toContain(`Working directory: ${runtime.rootDir}`)
      expect(visible).not.toContain("Answer briefly.")
    })
  })

  it("does not include Mate instructions in model context", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "ok" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const mate = await runtime.mateKernel.createMate({
        instructions: "",
        name: "QuietMate",
        role: "Assistant",
      })
      const session = await runtime.kernel.createSession({
        title: "quiet",
        workingDirectory: runtime.rootDir,
        mateId: mate.mate.id,
        mateRevisionId: mate.mate.currentRevision.id,
      })
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "hi" },
      })
      await runner.wake(session.sessionId)

      const system = provider.requests[0]?.system
      expect(system?.[0]?.text.startsWith("You are Yakitori")).toBe(true)
      expect(system?.map((section) => section.id)).toEqual([
        "base.instructions",
      ])
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
        `Working directory: ${runtime.rootDir}`,
      )
    })
  })

  it("captures an AGENTS change as an anchored world-state diff before the next step", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          content: [
            {
              type: "tool_call",
              id: "call_write_agents",
              name: "write_file",
              input: {
                path: "AGENTS.md",
                content: "Run the focused test before finishing.",
              },
            },
          ],
          stopReason: ModelStopReason.ToolUse,
        },
        { content: [{ type: "text", text: "done" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        now: () => new Date(2026, 7, 21),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "add project instructions" },
      })

      await runner.wake(session.sessionId)

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const updates = replayed.events.flatMap((event) =>
        event.type === EventType.WorldStateUpdated ? [event] : [],
      )
      expect(updates).toHaveLength(2)
      expect(updates[0]?.data.full).toBe(true)
      expect(updates[1]?.data).toMatchObject({
        full: false,
        afterItemId: replayed.session?.tools[0]?.resultItemId,
        state: {
          "project.instructions": {
            directory: expect.any(String),
            text: expect.stringContaining(
              "Run the focused test before finishing.",
            ),
          },
        },
        fragments: [
          {
            id: "project.instructions",
            text: expect.stringContaining(
              "Run the focused test before finishing.",
            ),
          },
        ],
      })
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        "Run the focused test before finishing.",
      )
      const diffIndex = provider.requests[1]?.messages.findIndex(
        (message) =>
          message.role === "user" &&
          message.context?.sectionId === "project.instructions",
      )
      const toolResultIndex = provider.requests[1]?.messages.findIndex(
        (message) => message.role === "tool",
      )
      expect(diffIndex).toBeGreaterThan(toolResultIndex ?? -1)
    })
  })

  it("fails the Turn when project instruction discovery fails", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "must not run" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        loadProjectInstructions: async () => {
          throw new Error("instruction read failed")
        },
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "hi" },
      })

      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(provider.callCount).toBe(0)
      expect(read.session?.failedTurns[0]?.error?.message).toContain(
        "instruction read failed",
      )
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
          reasoningSnapshots: ["inspect", "inspect files"],
          content: [
            { type: "reasoning", text: "inspect files" },
            { type: "text", text: "final text" },
          ],
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
      expect(live.some((event) => event.type === "assistant.snapshot")).toBe(
        true,
      )
      expect(live.some((event) => event.type === "reasoning.snapshot")).toBe(
        true,
      )
      expect(
        durable.some((event) => event.type === EventType.AssistantMessage),
      ).toBe(true)
      expect(
        durable.find((event) => event.type === EventType.AssistantMessage)?.data
          .content,
      ).toEqual([
        { type: "reasoning", text: "inspect files" },
        { type: "text", text: "final text" },
      ])
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(
        replayed.events.every(
          (event) =>
            event.type !== ("assistant.snapshot" as typeof event.type) &&
            event.type !== ("reasoning.snapshot" as typeof event.type),
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

  it("compacts dropped history into a durable checkpoint under pressure", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          content: [
            {
              type: "tool_call",
              id: "call_1",
              name: "read_file",
              input: { path: "missing.txt" },
            },
          ],
          stopReason: ModelStopReason.ToolUse,
        },
        {
          content: [{ type: "text", text: "first answer" }],
          usage: { inputTokens: 100, outputTokens: 50 },
        },
        {
          content: [{ type: "text", text: "Goal: checkpoint one." }],
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        {
          content: [
            {
              type: "tool_call",
              id: "call_2",
              name: "read_file",
              input: { path: "missing.txt" },
            },
          ],
          stopReason: ModelStopReason.ToolUse,
          usage: { inputTokens: 200, outputTokens: 60 },
        },
        {
          content: [{ type: "text", text: "second answer" }],
          usage: { inputTokens: 300, outputTokens: 70 },
        },
        {
          content: [{ type: "text", text: "Goal: checkpoint two." }],
          usage: { inputTokens: 20, outputTokens: 6 },
        },
        {
          content: [{ type: "text", text: "third answer" }],
          usage: { inputTokens: 400, outputTokens: 80 },
        },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({
          modelVisibleMessageBlocks: 100,
          modelVisibleContextBytes: 100_000,
          compactionTriggerRatio: 0.000_01,
          compactionRetainRatio: 0,
          compactionSummaryBytes: 1,
        }),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.configureSession({
        sessionId: session.sessionId,
        configuration: SessionConfiguration.create({
          selection: { provider: "faux", model: "scripted" },
          workspaceRoot: runtime.rootDir,
          enabledTools: ["read_file"],
          approvalPolicy: "never",
          limits: createRuntimeLimits({
            modelVisibleMessageBlocks: 100,
            modelVisibleContextBytes: 100_000,
            compactionTriggerRatio: 0.000_01,
            compactionRetainRatio: 0,
            compactionSummaryBytes: 16 * 1024,
          }),
        }).snapshot,
      })
      for (const question of [
        "first question",
        "second question",
        "third question",
      ]) {
        await runtime.kernel.admitInput({
          sessionId: session.sessionId,
          content: { kind: "text", text: question },
        })
        await runner.wake(session.sessionId)
      }

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const turns = replayed.session?.turns ?? []
      const [firstTurn, secondTurn, thirdTurn] = turns
      const compacted = replayed.events.filter(
        (event) => event.type === EventType.ContextCompacted,
      )
      if (compacted.length !== 2) throw new Error("expected two compactions")
      const [first, second] = compacted
      if (
        first?.type !== EventType.ContextCompacted ||
        second?.type !== EventType.ContextCompacted
      ) {
        throw new Error("expected compaction facts")
      }

      // throughSeq is the high-water seq observed before the summary call:
      // nothing is appended between turn.started and the first context build.
      const secondTurnStarted = replayed.events.find(
        (event) =>
          event.type === EventType.TurnStarted &&
          event.data.turnId === secondTurn?.turnId,
      )
      expect(first.data).toMatchObject({
        turnId: secondTurn?.turnId,
        throughSeq: secondTurnStarted?.seq,
        coveredTurnIds: [firstTurn?.turnId],
        summary: "Goal: checkpoint one.",
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      // Coverage is cumulative: the second checkpoint supersedes the first.
      expect(second.data.coveredTurnIds).toEqual([
        firstTurn?.turnId,
        secondTurn?.turnId,
      ])
      expect(second.data.summary).toBe("Goal: checkpoint two.")
      const firstReplacement = first.data.replacement as
        | ContextWindowReplacement
        | undefined
      const secondReplacement = second.data.replacement as
        | ContextWindowReplacement
        | undefined
      expect(secondReplacement?.previousWindowId).toBe(
        firstReplacement?.windowId,
      )
      expect(secondReplacement?.firstWindowId).toBe(firstReplacement?.windowId)
      expect(secondReplacement?.windowNumber).toBe(2)

      // The summarization request flattens the dropped turns, carries no
      // tools, and folds the previous checkpoint into its instruction.
      const firstSummary = provider.requests[2]
      expect(firstSummary?.tools).toEqual([])
      expect(firstSummary?.system.at(-1)?.text).toContain("checkpoint")
      const firstSummaryText = JSON.stringify(firstSummary?.messages)
      expect(firstSummaryText).toContain("first question")
      expect(firstSummaryText).toContain("first answer")
      const secondSummary = provider.requests[5]
      const secondInstruction = secondSummary?.messages.at(-1)
      if (secondInstruction?.role !== "user") {
        throw new Error("missing summarization instruction")
      }
      expect(secondInstruction.content[0]?.text).toContain(
        "Previous checkpoint:\nGoal: checkpoint one.",
      )

      // The real request after compaction uses the exact durable replacement
      // prefix and excludes covered turns.
      const realRequest = provider.requests[6]
      const checkpointMessage = realRequest?.messages.find(
        (message) =>
          message.role === "user" &&
          message.content[0]?.text.includes("<context_compacted>"),
      )
      if (checkpointMessage?.role !== "user") {
        throw new Error("missing checkpoint")
      }
      expect(checkpointMessage.content[0]?.text).toContain(
        "Goal: checkpoint two.",
      )
      const realText = JSON.stringify(realRequest?.messages)
      expect(realText).toContain("<environment>")
      expect(realText).not.toContain("first question")
      expect(realText).not.toContain("second question")
      expect(realRequest?.messages.at(-1)).toEqual({
        role: "user",
        content: [{ type: "text", text: "third question" }],
      })
      for (const checkpoint of compacted) {
        if (checkpoint.type !== EventType.ContextCompacted) {
          throw new Error("expected compaction fact")
        }
        const replacement = checkpoint.data.replacement as
          | ContextWindowReplacement
          | undefined
        expect(replacement?.history).toContainEqual(
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                text: expect.stringContaining("<context_compacted>"),
              }),
            ],
          }),
        )
        expect(replacement?.worldStateBaseline).toBeDefined()
        expect(
          replayed.events.find(
            (event) =>
              event.type === EventType.WorldStateUpdated &&
              event.data.turnId === checkpoint.data.turnId &&
              event.data.full &&
              event.seq > checkpoint.seq,
          ),
        ).toBeUndefined()
      }

      // Compaction usage is folded into turn.completed usage.
      expect(secondTurn?.usage).toEqual({
        inputTokens: 510,
        outputTokens: 135,
      })
      expect(thirdTurn?.usage).toEqual({
        inputTokens: 420,
        outputTokens: 86,
      })
      expect(provider.callCount).toBe(7)
    })
  })

  it("does not count the compaction call against the model call budget", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          content: [
            {
              type: "tool_call",
              id: "call_1",
              name: "read_file",
              input: { path: "missing.txt" },
            },
          ],
          stopReason: ModelStopReason.ToolUse,
        },
        { content: [{ type: "text", text: "first answer" }] },
        { content: [{ type: "text", text: "Goal: checkpoint." }] },
        {
          content: [
            {
              type: "tool_call",
              id: "call_2",
              name: "read_file",
              input: { path: "missing.txt" },
            },
          ],
          stopReason: ModelStopReason.ToolUse,
        },
        { content: [{ type: "text", text: "second answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({
          modelCallsPerTurn: 2,
          modelVisibleMessageBlocks: 100,
          modelVisibleContextBytes: 100_000,
          compactionTriggerRatio: 0.000_01,
          compactionRetainRatio: 0,
        }),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first question" },
      })
      await runner.wake(session.sessionId)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "second question" },
      })
      await runner.wake(session.sessionId)

      // The second turn makes two real model calls plus one compaction call;
      // counting housekeeping would exhaust the budget of two.
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns).toHaveLength(2)
      expect(read.session?.failedTurns).toEqual([])
      expect(provider.callCount).toBe(5)

      // The checkpoint remains visible across both real calls in the Turn.
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const assistantMetadata = replayed.events.flatMap((event) =>
        event.type === EventType.AssistantMessage
          ? [event.data.providerMetadata]
          : [],
      )
      expect(assistantMetadata).toEqual([
        expect.not.objectContaining({ droppedCompactionCheckpoint: true }),
        expect.not.objectContaining({ droppedCompactionCheckpoint: true }),
      ])
    })
  })

  it("fails the Turn instead of sending silently dropped history", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first answer" }] },
        { throwDuring: new Error("summarizer down") },
        { content: [{ type: "text", text: "second answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({ modelVisibleMessageBlocks: 3 }),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first question" },
      })
      await runner.wake(session.sessionId)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "second question" },
      })
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await runner.wake(session.sessionId)
        expect(errors).toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(
        replayed.events.some(
          (event) => event.type === EventType.ContextCompacted,
        ),
      ).toBe(false)
      expect(replayed.session?.completedTurns).toHaveLength(1)
      expect(replayed.session?.failedTurns).toHaveLength(1)
      expect(replayed.session?.failedTurns[0]?.error).toMatchObject({
        code: YakitoriErrorCode.InvalidState,
        details: { code: "context_compaction_required" },
      })
      expect(provider.requests).toHaveLength(2)
    })
  })

  it("does not log a compaction failure when the summary is aborted", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first answer" }] },
        { waitForAbort: true },
        { content: [{ type: "text", text: "unreached" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({ modelVisibleMessageBlocks: 3 }),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first question" },
      })
      await runner.wake(session.sessionId)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "second question" },
      })

      // The second Turn drops history, so its first model call is the parked
      // compaction summary; interrupt while it is in flight.
      const wake = runner.wake(session.sessionId)
      for (;;) {
        if (provider.callCount >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const started = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      const active = started.session?.activeTurn
      if (!active) throw new Error("missing active turn")

      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await runner.interrupt({
          sessionId: session.sessionId,
          turnId: active.turnId,
          reason: "user_cancel",
        })
        await wake
        expect(errors).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }

      const final = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(final.session?.cancelledTurns).toHaveLength(1)
    })
  })

  it("retries an over-long summary request with a reduced source", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        {
          content: [{ type: "text", text: "first answer".padEnd(1_000, "a") }],
        },
        {
          content: [{ type: "text", text: "second answer".padEnd(1_000, "b") }],
        },
        {
          throwDuring: new Error(
            "prompt is too long: 250000 tokens > 200000 maximum",
          ),
        },
        { content: [{ type: "text", text: "Goal: checkpoint." }] },
        { content: [{ type: "text", text: "third answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({
          modelVisibleMessageBlocks: 100,
          modelVisibleContextBytes: 10_000,
          compactionTriggerRatio: 0.5,
          compactionRetainRatio: 0,
        }),
      })
      const session = await createAttributedSession(runtime)
      for (const question of [
        "first question",
        "second question",
        "third question",
      ]) {
        await runtime.kernel.admitInput({
          sessionId: session.sessionId,
          content: { kind: "text", text: question.padEnd(1_000, "q") },
        })
        await runner.wake(session.sessionId)
      }

      expect(provider.callCount).toBe(5)
      // The third turn's first summary request carries both uncovered
      // dropped turns; the retry keeps the oldest half so checkpoint coverage
      // remains a continuous historical prefix.
      const firstAttempt = JSON.stringify(provider.requests[2]?.messages)
      expect(firstAttempt).toContain("first question")
      expect(firstAttempt).toContain("second question")
      const retryAttempt = JSON.stringify(provider.requests[3]?.messages)
      expect(retryAttempt).toContain("first question")
      expect(retryAttempt).not.toContain("second question")

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const compacted = replayed.events.filter(
        (event) => event.type === EventType.ContextCompacted,
      )
      expect(compacted).toHaveLength(1)
      const turns = replayed.session?.turns ?? []
      // Coverage follows the reduced source and leaves the next Turn verbatim.
      expect(compacted[0]?.data).toMatchObject({
        coveredTurnIds: [turns[0]?.turnId],
        summary: "Goal: checkpoint.",
      })
      expect(replayed.session?.completedTurns).toHaveLength(3)
    })
  })

  it("skips compaction quietly when the checkpoint is not smaller than its source", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first answer" }] },
        { content: [{ type: "text", text: "Goal: ".padEnd(500, "x") }] },
        { content: [{ type: "text", text: "second answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({
          modelVisibleMessageBlocks: 100,
          modelVisibleContextBytes: 100_000,
          compactionTriggerRatio: 0.000_01,
          compactionRetainRatio: 0,
        }),
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "first question" },
      })
      await runner.wake(session.sessionId)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "second question" },
      })
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await runner.wake(session.sessionId)
        // Not smaller is a no-op, not a failure: no error log, no breaker.
        expect(errors).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }

      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(
        replayed.events.some(
          (event) => event.type === EventType.ContextCompacted,
        ),
      ).toBe(false)
      expect(replayed.session?.completedTurns).toHaveLength(2)
    })
  })

  it("stops attempting compaction after consecutive failures", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first answer" }] },
        { throwDuring: new Error("summarizer down") },
        { content: [{ type: "text", text: "second answer" }] },
        { throwDuring: new Error("summarizer down") },
        { content: [{ type: "text", text: "third answer" }] },
        { throwDuring: new Error("summarizer down") },
        { content: [{ type: "text", text: "fourth answer" }] },
        { content: [{ type: "text", text: "fifth answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        limits: createRuntimeLimits({
          modelVisibleMessageBlocks: 100,
          modelVisibleContextBytes: 100_000,
          compactionTriggerRatio: 0.000_01,
          compactionRetainRatio: 0,
        }),
      })
      const session = await createAttributedSession(runtime)
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        for (const question of [
          "first question",
          "second question",
          "third question",
          "fourth question",
          "fifth question",
        ]) {
          await runtime.kernel.admitInput({
            sessionId: session.sessionId,
            content: { kind: "text", text: question },
          })
          await runner.wake(session.sessionId)
        }
      } finally {
        errors.mockRestore()
      }

      // Turns two through four each pay one failed summary call; the fifth
      // turn goes straight to its real call because the breaker tripped.
      expect(provider.callCount).toBe(8)
      const lastRequest = JSON.stringify(provider.requests[7]?.messages)
      expect(lastRequest).toContain("fifth question")
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns).toHaveLength(5)
    })
  })

  it("runs a manual compact directive turn without a real model call", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first answer" }] },
        { content: [{ type: "text", text: "second answer" }] },
        { content: [{ type: "text", text: "Goal: manual checkpoint." }] },
        { content: [{ type: "text", text: "third answer" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      for (const question of ["first question", "second question"]) {
        await runtime.kernel.admitInput({
          sessionId: session.sessionId,
          content: { kind: "text", text: question },
        })
        await runner.wake(session.sessionId)
      }

      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        role: InputRole.Runtime,
        content: { kind: "text", text: COMPACT_DIRECTIVE },
      })
      await runner.wake(session.sessionId)

      // Two real answers plus the summary call; the directive Turn itself
      // never prompts the model for a response.
      expect(provider.callCount).toBe(3)
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      const turns = replayed.session?.turns ?? []
      const compacted = replayed.events.filter(
        (event) => event.type === EventType.ContextCompacted,
      )
      expect(compacted).toHaveLength(1)
      expect(compacted[0]?.data).toMatchObject({
        turnId: turns[2]?.turnId,
        coveredTurnIds: [turns[0]?.turnId, turns[1]?.turnId],
        summary: "Goal: manual checkpoint.",
      })
      expect(replayed.session?.completedTurns).toHaveLength(3)

      // The follow-up turn sees the checkpoint; neither the directive nor
      // the housekeeping note leaks into model history.
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "third question" },
      })
      await runner.wake(session.sessionId)
      const followUp = JSON.stringify(provider.requests[3]?.messages)
      expect(followUp).toContain("<context_compacted>")
      expect(followUp).toContain("Goal: manual checkpoint.")
      expect(followUp).not.toContain(COMPACT_DIRECTIVE)
      expect(followUp).not.toContain("Compacted")
      expect(provider.callCount).toBe(4)
    })
  })

  it("completes a compact directive with a note when nothing qualifies", async () => {
    await withRuntime(async (runtime) => {
      const provider = createFauxProvider([])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
      })
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        role: InputRole.Runtime,
        content: { kind: "text", text: COMPACT_DIRECTIVE },
      })
      await runner.wake(session.sessionId)

      expect(provider.callCount).toBe(0)
      const replayed = await runtime.kernel.replaySession({
        sessionId: session.sessionId,
      })
      expect(
        replayed.events.some(
          (event) => event.type === EventType.ContextCompacted,
        ),
      ).toBe(false)
      expect(replayed.session?.completedTurns).toHaveLength(1)
    })
  })
})

describe("multi-agent runtime", () => {
  it("composes synchronous delegation from spawn_agent and wait_agent", async () => {
    await withRuntime(async (runtime) => {
      const requests: ModelRequest[] = []
      const stream: StreamFn = async function* (request) {
        requests.push(request)
        const serialized = JSON.stringify(request.messages)
        const toolResults = request.messages.filter(
          (message) => message.role === "tool",
        )
        const waitCompleted = toolResults.some((message) =>
          message.content.includes('"timedOut":false'),
        )
        if (serialized.includes("You are agent /root/survey,")) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          yield response([{ type: "text", text: "child findings" }])
          return
        }
        if (toolResults.length === 0) {
          yield response(
            [
              {
                type: "tool_call",
                id: "spawn_survey",
                name: "spawn_agent",
                input: {
                  task_name: "survey",
                  message: "inspect the repository",
                  fork_turns: "all",
                },
              },
            ],
            ModelStopReason.ToolUse,
          )
          return
        }
        if (!waitCompleted) {
          yield response(
            [
              {
                type: "tool_call",
                id: "wait_survey",
                name: "wait_agent",
                input: { timeout_ms: 5_000 },
              },
            ],
            ModelStopReason.ToolUse,
          )
          return
        }
        yield response([{ type: "text", text: "parent complete" }])
      }
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream,
      })
      const root = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: root.sessionId,
        content: { kind: "text", text: "delegate and wait" },
      })

      await runner.wake(root.sessionId)

      const sessions = await runtime.kernel.listSessions()
      const childSummary = sessions.sessions.find(
        (session) => session.parentSessionId === root.sessionId,
      )
      if (childSummary === undefined) throw new Error("missing child agent")
      const parent = await runtime.kernel.readSession({
        sessionId: root.sessionId,
      })
      const child = await runtime.kernel.readSession({
        sessionId: childSummary.sessionId,
      })
      expect(parent.session?.completedTurns).toHaveLength(1)
      expect(child.session?.completedTurns).toHaveLength(1)
      expect(
        parent.session?.tools.find((tool) => tool.name === "wait_agent")
          ?.output,
      ).toMatchObject({ timedOut: false })
      expect(child.session?.metadata).toMatchObject({
        agent: {
          kind: "subagent",
          path: "/root/survey",
          depth: 1,
        },
      })
      expect(child.session?.inheritedContext).toMatchObject({
        sourceSessionId: root.sessionId,
        history: expect.any(Array),
        worldStateBaseline: {
          environment: expect.any(Object),
        },
      })
      expect(child.session?.worldStateUpdates[0]).toMatchObject({
        full: false,
        state: {
          multi_agent: { path: "/root/survey" },
        },
        fragments: [{ id: "multi_agent" }],
      })

      const rootRequest = requests.find((request) =>
        JSON.stringify(request.messages).includes("delegate and wait"),
      )
      const childRequest = requests.find((request) =>
        JSON.stringify(request.messages).includes(
          "You are agent /root/survey,",
        ),
      )
      expect(rootRequest).toBeDefined()
      expect(childRequest).toBeDefined()
      expect(childRequest?.cacheKey).toBe(root.sessionId)
      expect(childRequest?.tools).toEqual(rootRequest?.tools)
      expect(JSON.stringify(rootRequest?.messages)).toContain(
        "You are agent /root.",
      )
      expect(JSON.stringify(childRequest?.messages)).not.toContain(
        "You are agent /root.",
      )
      expect(JSON.stringify(childRequest?.messages)).toContain(
        "You are agent /root/survey,",
      )
      expect(JSON.stringify(childRequest?.messages)).toContain(
        "delegate and wait",
      )
      expect(JSON.stringify(childRequest?.messages)).toContain(
        "inspect the repository",
      )
      expect(
        childRequest?.messages.filter(
          (message) =>
            (message.role === "user" || message.role === "developer") &&
            message.context?.sectionId === "multi_agent",
        ),
      ).toHaveLength(1)
    })
  })

  it("replaces inherited agent context across nested full-history forks", async () => {
    await withRuntime(async (runtime) => {
      const requests: ModelRequest[] = []
      const stream: StreamFn = async function* (request) {
        requests.push(request)
        const serialized = JSON.stringify(request.messages)
        const hasToolResult = request.messages.some(
          (message) => message.role === "tool",
        )
        if (serialized.includes("You are agent /root/child/grandchild,")) {
          yield response([{ type: "text", text: "grandchild done" }])
          return
        }
        if (serialized.includes("You are agent /root/child,")) {
          if (!hasToolResult) {
            yield response(
              [
                {
                  type: "tool_call",
                  id: "spawn_grandchild",
                  name: "spawn_agent",
                  input: {
                    task_name: "grandchild",
                    message: "grandchild task",
                    fork_turns: "all",
                  },
                },
              ],
              ModelStopReason.ToolUse,
            )
            return
          }
          yield response([{ type: "text", text: "child done" }])
          return
        }
        if (!hasToolResult) {
          yield response(
            [
              {
                type: "tool_call",
                id: "spawn_child",
                name: "spawn_agent",
                input: {
                  task_name: "child",
                  message: "child task",
                  fork_turns: "all",
                },
              },
            ],
            ModelStopReason.ToolUse,
          )
          return
        }
        yield response([{ type: "text", text: "root done" }])
      }
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream,
      })
      const root = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: root.sessionId,
        content: { kind: "text", text: "root task" },
      })

      await runner.wake(root.sessionId)
      const child = (await runtime.kernel.listSessions()).sessions.find(
        (session) => session.parentSessionId === root.sessionId,
      )
      if (child === undefined) throw new Error("missing child agent")
      await runner.wake(child.sessionId)
      const grandchild = (await runtime.kernel.listSessions()).sessions.find(
        (session) => session.parentSessionId === child.sessionId,
      )
      if (grandchild === undefined) throw new Error("missing grandchild agent")
      await runner.wake(grandchild.sessionId)
      const grandchildSession = await runtime.kernel.readSession({
        sessionId: grandchild.sessionId,
      })

      const grandchildRequest = requests.find((request) =>
        JSON.stringify(request.messages).includes(
          "You are agent /root/child/grandchild,",
        ),
      )
      expect(grandchildRequest).toBeDefined()
      const serialized = JSON.stringify(grandchildRequest?.messages)
      expect(serialized).not.toContain("You are agent /root.")
      expect(serialized).not.toContain("You are agent /root/child,")
      expect(serialized).toContain("You are agent /root/child/grandchild,")
      expect(serialized).toContain("root task")
      expect(serialized).toContain("child task")
      expect(serialized).toContain("grandchild task")
      expect(
        grandchildRequest?.messages.filter(
          (message) =>
            (message.role === "user" || message.role === "developer") &&
            message.context?.sectionId === "multi_agent",
        ),
      ).toHaveLength(1)
      expect(
        grandchildRequest?.messages.filter(
          (message) =>
            (message.role === "user" || message.role === "developer") &&
            message.context?.sectionId === "environment",
        ),
      ).toHaveLength(1)
      expect(grandchildSession.session?.worldStateUpdates[0]).toMatchObject({
        full: false,
        state: {
          multi_agent: { path: "/root/child/grandchild" },
        },
        fragments: [{ id: "multi_agent" }],
      })
    })
  })

  it("keeps tool schemas stable and guides explore through its role context", async () => {
    await withRuntime(async (runtime) => {
      const requests: ModelRequest[] = []
      const stream: StreamFn = async function* (request) {
        requests.push(request)
        const serialized = JSON.stringify(request.messages)
        const isChild = serialized.includes("You are agent /root/explorer,")
        const toolResults = request.messages.filter(
          (message) => message.role === "tool",
        )
        if (isChild) {
          yield response([{ type: "text", text: "reported without editing" }])
          return
        }
        if (toolResults.length === 0) {
          yield response(
            [
              {
                type: "tool_call",
                id: "spawn_explorer",
                name: "spawn_agent",
                input: {
                  task_name: "explorer",
                  message: "inspect only",
                  agent_type: "explore",
                },
              },
            ],
            ModelStopReason.ToolUse,
          )
          return
        }
        yield response([{ type: "text", text: "parent done" }])
      }
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream,
      })
      const root = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: root.sessionId,
        content: { kind: "text", text: "ask an explorer" },
      })

      await runner.wake(root.sessionId)
      const sessions = await runtime.kernel.listSessions()
      const childSummary = sessions.sessions.find(
        (session) => session.parentSessionId === root.sessionId,
      )
      if (childSummary === undefined) throw new Error("missing explore agent")
      await runner.wake(childSummary.sessionId)
      const rootTools = requests.find((request) =>
        JSON.stringify(request.messages).includes("ask an explorer"),
      )?.tools
      const childRequest = requests.find((request) =>
        JSON.stringify(request.messages).includes(
          "You are agent /root/explorer,",
        ),
      )
      const childTools = childRequest?.tools
      expect(childTools).toEqual(rootTools)
      expect(childTools?.map((tool) => tool.name)).toContain("edit_file")
      expect(childTools?.map((tool) => tool.name)).toContain("spawn_agent")
      expect(JSON.stringify(childRequest?.messages)).toContain(
        "This is an exploration role. Inspect and report; do not modify files or run mutating commands.",
      )
      expect(JSON.stringify(childRequest?.messages)).not.toContain(
        "ask an explorer",
      )
      expect(JSON.stringify(childRequest?.messages)).toContain("inspect only")
    })
  })
})

function response(
  content: readonly ModelContentBlock[],
  stopReason: ModelStopReasonType = ModelStopReason.EndTurn,
) {
  return {
    type: "response" as const,
    response: { content, stopReason },
  }
}

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
    const failed = read.session?.failedTurns.at(-1)
    expect(failed?.metrics).toBeDefined()
    expect(failed?.metrics?.modelCalls).toBe(
      limits.modelCallsPerTurn === 0 ? 0 : 1,
    )
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
  const eventStore = createJsonlEventStore({
    sessionsDir: join(rootDir, "sessions"),
  })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "mates.sqlite"),
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
    await eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}
