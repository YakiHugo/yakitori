import { strict as assert } from "node:assert"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { StoredRolloutItem } from "../../src/core/rollout.ts"
import type {
  SessionEvent,
  SubmitTurnInput,
} from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import {
  createToolRegistry,
  plainToolName,
  type RuntimeTool,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

const testHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testHome.path,
}))
const cleanups: Array<() => Promise<void>> = []
beforeEach(async () => {
  testHome.path = await mkdtemp(join(tmpdir(), "yakitori-durable-turn-"))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await rm(testHome.path, { recursive: true, force: true })
})

describe("durable Turn execution contracts", () => {
  it("interrupts uncooperative readiness without executing the tool or publishing a second terminal", async () => {
    const entered = deferred()
    const release = deferred()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "stuck_ready", name: "stuck", input: {} },
        ],
      },
    ])
    const runtime = createRuntime(provider.stream, [
      {
        ...tool("stuck"),
        async waitUntilReady() {
          entered.resolve()
          await release.promise
        },
        async execute(_input, context) {
          await appendFile(
            join(context.workspaceRoot, "unexpected-effect"),
            "executed\n",
          )
          return { ok: true, output: {}, content: "executed" }
        },
      },
    ])
    const thread = await runtime.createThread()
    await thread.startIfIdle(input("wait", "ready_turn"))
    await entered.promise
    await thread.interrupt("stop readiness")
    const events = await throughTerminal(thread)
    const before = await assertDurableTerminal(
      runtime.root,
      thread.id,
      "ready_turn",
      "interrupted",
      events,
    )
    await expect(
      readFile(join(runtime.root, "unexpected-effect")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    release.resolve()
    await runtime.manager.shutdown()
    expect(await readJournal(runtime.root, thread.id)).toEqual(before)
    expect(provider.callCount).toBe(1)
    await expect(
      readFile(join(runtime.root, "unexpected-effect")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reopens interrupted tool history and preserves usage and later provider failure diagnostics", async () => {
    const entered = deferred()
    const initial = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        usage: { inputTokens: 9, outputTokens: 2 },
        content: [
          { type: "tool_call", id: "tool_wait", name: "wait", input: {} },
        ],
      },
    ])
    const runtime = createRuntime(initial.stream, [
      {
        ...tool("wait"),
        execute(_input, context) {
          entered.resolve()
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            )
          })
        },
      },
    ])
    const thread = await runtime.createThread()
    await thread.startIfIdle(input("wait", "interrupted_turn"))
    await entered.promise
    await thread.interrupt("stop tool")
    const events = await throughTerminal(thread)
    const interrupted = await assertDurableTerminal(
      runtime.root,
      thread.id,
      "interrupted_turn",
      "interrupted",
      events,
    )
    expect(interrupted.at(-1)?.item).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 2 },
    })
    await runtime.manager.shutdown()

    const resumedProvider = createFauxProvider([
      {
        assertRequest(request) {
          const calls = request.messages.filter(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) =>
                  block.type === "tool_call" && block.id === "tool_wait",
              ),
          )
          expect(calls).toHaveLength(1)
          assert(calls[0] !== undefined)
          const callIndex = request.messages.indexOf(calls[0])
          expect(request.messages[callIndex + 1]).toMatchObject({
            role: "tool",
            toolCallId: "tool_wait",
            isError: true,
          })
          expect(
            request.messages.filter(
              (message) =>
                message.role === "tool" && message.toolCallId === "tool_wait",
            ),
          ).toHaveLength(1)
        },
        content: [{ type: "text", text: "recovered" }],
      },
      {
        failure: {
          kind: "provider_error",
          stage: "model_event",
          provider: "test",
          wireApi: "unknown",
          providerCode: "provider_failed",
          message: "provider failed",
        },
        usage: { inputTokens: 4, outputTokens: 1 },
      },
    ])
    const reopened = createRuntime(resumedProvider.stream)
    const resumed = await reopened.manager.resumeThread(thread.id)
    assert(resumed !== undefined)
    await resumed.startIfIdle(input("continue", "recovery_turn"))
    await assertDurableTerminal(
      runtime.root,
      thread.id,
      "recovery_turn",
      "completed",
      await throughTerminal(resumed),
    )
    expect(resumed.agentStatus).toEqual({ completed: "recovered" })
    await resumed.startIfIdle(input("fail", "failure_turn"))
    const failed = await assertDurableTerminal(
      runtime.root,
      thread.id,
      "failure_turn",
      "failed",
      await throughTerminal(resumed),
    )
    expect(failed.at(-1)?.item).toMatchObject({
      usage: { inputTokens: 4, outputTokens: 1 },
      error: {
        code: "model.provider_error",
        details: {
          kind: "provider_error",
          stage: "model_event",
          provider: "test",
          providerCode: "provider_failed",
        },
      },
    })
    await reopened.manager.shutdown()
    const stored = await new JsonlThreadStore({
      root: runtime.root,
    }).readThread(thread.id)
    expect(stored?.rollout).toEqual(failed)
    expect(initial.callCount).toBe(1)
    expect(resumedProvider.callCount).toBe(2)
  })

  it.each([
    "raw",
    "wrapped",
    "snapshot",
  ] as const)("durably orders interruption after observed usage even when the %s stream closes late", async (mode) => {
    const observed = deferred()
    const release = deferred()
    const stream: StreamFn = async function* (request) {
      if (mode === "snapshot")
        request.onUsageSnapshot?.({ inputTokens: 7, outputTokens: 2 })
      else
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "complete" }],
            usage: { inputTokens: 7, outputTokens: 2 },
          },
        }
      observed.resolve()
      await release.promise
    }
    const runtime = createRuntime(
      mode === "raw"
        ? stream
        : createModelRequestStream(stream, { wireApi: "unknown" }),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle(input("run", "late_stream_turn"))
    await observed.promise
    const flushed = deferred()
    const releaseFlush = deferred()
    const flush = runtime.store.flushThread.bind(runtime.store)
    vi.spyOn(runtime.store, "flushThread").mockImplementation(async (id) => {
      await flush(id)
      const last = (await readJournal(runtime.root, id)).at(-1)?.item
      if (
        last?.type === "turn_completed" &&
        last.turnId === "late_stream_turn"
      ) {
        flushed.resolve()
        await releaseFlush.promise
      }
    })
    await thread.interrupt("after usage")
    let published = false
    const terminal = throughTerminal(thread).then((events) => {
      published = true
      return events
    })
    try {
      // Race observable milestones, not a timeout, so skipping the barrier fails immediately.
      expect(
        await Promise.race([
          flushed.promise.then(() => "flushed"),
          terminal.then(() => "published"),
        ]),
      ).toBe("flushed")
      // Real journal bytes alone cannot prove the caller awaited the fsync barrier.
      expect(published).toBe(false)
    } finally {
      releaseFlush.resolve()
    }
    const events = await terminal
    const journal = await assertDurableTerminal(
      runtime.root,
      thread.id,
      "late_stream_turn",
      "interrupted",
      events,
    )
    expect(journal.at(-1)?.item).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 2 },
    })
    release.resolve()
    await runtime.manager.shutdown()
    expect(await readJournal(runtime.root, thread.id)).toEqual(journal)
    const trailing: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) break
      trailing.push(event)
    }
    expect(
      trailing.filter(
        (event) =>
          event.type === "model.stream" ||
          event.type === "turn.completed" ||
          event.type === "turn.interrupted",
      ),
    ).toEqual([])
    expect(
      (await new JsonlThreadStore({ root: runtime.root }).readThread(thread.id))
        ?.rollout,
    ).toEqual(journal)
  })

  it("rebuilds a disconnected attempt from completed filesystem effects and reopens that history without replaying the tool", async () => {
    const attemptClosed = deferred()
    const effectPath = join(testHome.path, "effects.log")
    const call = {
      type: "tool_call" as const,
      id: "write_once",
      name: "effect",
      input: {},
    }
    const completed = createFauxProvider([
      {
        assertRequest(request) {
          const callIndex = request.messages.findIndex(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) => block.type === "tool_call" && block.id === call.id,
              ),
          )
          expect(callIndex).toBeGreaterThan(-1)
          expect(request.messages[callIndex + 1]).toMatchObject({
            role: "tool",
            toolCallId: call.id,
            content: [{ type: "text", text: "wrote receipt" }],
          })
        },
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 5, outputTokens: 1 },
      },
    ])
    let attempts = 0
    const raw: StreamFn = async function* (request) {
      attempts += 1
      if (attempts > 1) {
        expect(await readFile(effectPath, "utf8")).toBe("applied\n")
        yield* completed.stream(request)
        return
      }
      try {
        yield { type: "output_item", itemId: "effect_call", content: [call] }
        yield {
          type: "failure",
          failure: {
            kind: "stream_disconnected",
            stage: "response_body",
            provider: "faux",
            wireApi: "unknown",
            message: "connection lost",
          },
          usage: { inputTokens: 9, outputTokens: 2 },
        }
      } finally {
        attemptClosed.resolve()
      }
    }
    const runtime = createRuntime(
      createModelRequestStream(raw, {
        wireApi: "unknown",
        maxAttempts: 2,
        sleep: async () => {},
      }),
      [
        {
          ...tool("effect"),
          effect: "mutate",
          async execute() {
            // Finishing after the stream closes requires the retry boundary to drain tools.
            await attemptClosed.promise
            await appendFile(effectPath, "applied\n")
            return {
              ok: true,
              output: { receipt: "applied" },
              content: "wrote receipt",
            }
          },
        },
      ],
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle(input("apply", "retry_turn"))
    const events = await throughTerminal(thread)
    expect(completed.requests[0]?.messages).toContainEqual({
      role: "tool",
      toolCallId: call.id,
      content: [{ type: "text", text: "wrote receipt" }],
    })
    expect(thread.agentStatus).toEqual({ completed: "done" })
    const journal = await assertDurableTerminal(
      runtime.root,
      thread.id,
      "retry_turn",
      "completed",
      events,
    )
    const history = journal.flatMap(({ item }) =>
      item.type === "response_item" ? [item.item.item] : [],
    )
    expect(
      history.filter(
        (message) => message.role === "tool" && message.toolCallId === call.id,
      ),
    ).toHaveLength(1)
    expect(journal.at(-1)?.item).toMatchObject({
      usage: { inputTokens: 14, outputTokens: 3 },
    })
    expect(attempts).toBe(2)
    expect(
      events.filter(
        (event) =>
          event.type === "runtime.warning" && event.code === "model.retry",
      ),
    ).toHaveLength(1)
    await runtime.manager.shutdown()

    const next = createFauxProvider([
      {
        assertRequest(request) {
          expect(
            request.messages.filter(
              (message) =>
                message.role === "tool" && message.toolCallId === call.id,
            ),
          ).toHaveLength(1)
          expect(request.messages).toContainEqual({
            role: "tool",
            toolCallId: call.id,
            content: [{ type: "text", text: "wrote receipt" }],
          })
        },
        content: [{ type: "text", text: "already applied" }],
      },
    ])
    const reopened = createRuntime(next.stream)
    const resumed = await reopened.manager.resumeThread(thread.id)
    assert(resumed !== undefined)
    await resumed.startIfIdle(input("what happened?", "after_reload"))
    await assertDurableTerminal(
      runtime.root,
      thread.id,
      "after_reload",
      "completed",
      await throughTerminal(resumed),
    )
    expect(await readFile(effectPath, "utf8")).toBe("applied\n")
    expect(next.callCount).toBe(1)
  })
})

function createRuntime(stream: StreamFn, tools: RuntimeTool[] = []) {
  const root = testHome.path
  const store = new JsonlThreadStore({ root })
  const assets = createRolloutAssets(root, {
    withMutationLease: (rolloutId, mutate) =>
      store.withRolloutAssetMutation(rolloutId, mutate),
  })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        toolRegistry: createToolRegistry(tools),
        rolloutAssets: assets,
        loadProjectInstructions: async () => undefined,
      }),
  })
  cleanups.push(() => manager.shutdown())
  return {
    root,
    store,
    manager,
    createThread: () =>
      manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      }),
  }
}

function tool(name: string): Omit<RuntimeTool, "execute"> {
  return {
    toolName: plainToolName(name),
    description: "Execution contract probe",
    inputSchema: { type: "object" },
    effect: "observe",
    approvalRequirement: { kind: "none" },
  }
}

function input(text: string, submissionId: string): SubmitTurnInput {
  return {
    submissionId,
    content: { kind: "parts", parts: [{ type: "text", text }] },
  }
}

async function throughTerminal(thread: {
  nextEvent(): Promise<SessionEvent | undefined>
}) {
  const events: SessionEvent[] = []
  for (;;) {
    const event = await thread.nextEvent()
    assert(event !== undefined, "Session ended before its terminal event")
    events.push(event)
    if (
      ["turn.completed", "turn.interrupted", "turn.failed"].includes(event.type)
    )
      return events
  }
}

async function readJournal(
  root: string,
  rolloutId: string,
): Promise<StoredRolloutItem[]> {
  const text = await readFile(
    join(root, "rollouts", rolloutId, "rollout.jsonl"),
    "utf8",
  )
  expect(text.endsWith("\n")).toBe(true)
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as StoredRolloutItem)
}

async function assertDurableTerminal(
  root: string,
  rolloutId: string,
  turnId: string,
  outcome: "completed" | "interrupted" | "failed",
  events: SessionEvent[],
) {
  const terminalType =
    outcome === "completed"
      ? "turn.completed"
      : outcome === "interrupted"
        ? "turn.interrupted"
        : "turn.failed"
  expect(
    events
      .filter((event) =>
        [
          "turn.started",
          "turn.completed",
          "turn.interrupted",
          "turn.failed",
          "session.error",
        ].includes(event.type),
      )
      .map((event) => event.type),
  ).toEqual(
    outcome === "failed"
      ? ["turn.started", "session.error", terminalType]
      : ["turn.started", terminalType],
  )
  expect(events.slice(0, -1)).toContainEqual(
    expect.objectContaining({
      type: "rollout.appended",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "turn_completed", turnId, outcome }),
      ]),
    }),
  )
  // Inspect the actual bytes at publication time, before shutdown can flush anything.
  const journal = await readJournal(root, rolloutId)
  const terminals = journal.filter(
    ({ item }) => item.type === "turn_completed" && item.turnId === turnId,
  )
  expect(terminals).toHaveLength(1)
  expect(journal.at(-1)).toBe(terminals[0])
  expect(terminals[0]?.item).toMatchObject({ outcome })
  const start = journal.find(
    ({ item }) => item.type === "turn_started" && item.turnId === turnId,
  )
  assert(start !== undefined && terminals[0] !== undefined)
  expect(start.seq).toBeLessThan(terminals[0].seq)
  return journal
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
