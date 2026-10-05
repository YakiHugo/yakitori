import { toolContentText } from "../../src/runtime/model-tool-content.ts"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { SessionEvent } from "../../src/core/session-io.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import {
  type AgentControl,
  createAgentControl,
} from "../../src/runtime/agent-control.ts"
import { HookEvent, type HookRunner } from "../../src/runtime/hooks.ts"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import type {
  ModelRequest,
  ModelStreamEvent,
  StreamFn,
} from "../../src/runtime/model.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import {
  createModelProvider,
  type ModelClient,
} from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createStaticModelsManager,
  type ModelsManager,
} from "../../src/runtime/models-manager.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import type { RolloutBudgetConfig } from "../../src/runtime/rollout-budget.ts"
import { mcpResult } from "../../src/runtime/tools/mcp-result.ts"
import { createReadDocumentTool } from "../../src/runtime/tools/read-media.ts"
import {
  createToolRegistry,
  plainToolName,
  type RuntimeTool,
} from "../../src/runtime/tools/registry.ts"
import {
  createTurnProcessor,
  type TurnProcessorOperationalFailure,
  type TurnProcessorOptions,
} from "../../src/runtime/turn-processor.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { createFauxProvider } from "../support/faux-provider.ts"
import { waitForValue } from "../support/wait-for-value.ts"
import { pdfFixture } from "./tools/pdf-fixture.ts"

const testUserHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testUserHome.path,
}))
beforeEach(async () => {
  testUserHome.path = await mkdtemp(join(tmpdir(), "yakitori-user-home-"))
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(testUserHome.path, { recursive: true, force: true })
})

describe("Turn processor", () => {
  it("retains completed request usage after process exit during the next request", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-usage-checkpoint-"))
    try {
      const result = execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../support/usage-checkpoint-process.ts", import.meta.url),
          ),
          root,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, HOME: root, USERPROFILE: root },
        },
      )
      const { threadId } = JSON.parse(result) as { threadId: string }
      const reopened = new JsonlThreadStore({ root })
      const stored = await reopened.readThread(threadId)
      expect(
        stored?.rollout
          .filter(({ item }) => item.type === "turn_usage")
          .map(({ item }) => item),
      ).toEqual([
        expect.objectContaining({
          type: "turn_usage",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000,
            cacheReadInputTokens: 900_000,
            cacheWriteInputTokens: 0,
          },
        }),
      ])
      expect(
        stored?.rollout.some(({ item }) => item.type === "turn_completed"),
      ).toBe(false)
      expect((await reopened.readUsageSummary()).totals).toMatchObject({
        inputTokens: 1_000_000,
        outputTokens: 1_000,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("persists goal continuations as developer context without invoking user prompt hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-goal-input-"))
    const store = new JsonlThreadStore({ root })
    const entered = deferred<void>()
    const release = deferred<void>()
    const submittedPrompts: string[] = []
    let requests = 0
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          hookRunner: {
            async dispose() {},
            async run(request) {
              if (request.event === HookEvent.UserPromptSubmit)
                submittedPrompts.push(String(request.payload.prompt))
              return {
                continue: request.event !== HookEvent.UserPromptSubmit,
                additionalContext: [],
              }
            },
          },
          stream: async function* (request) {
            requests += 1
            const goalMessages = request.messages.filter(
              (message) =>
                message.role === "developer" &&
                message.context?.type === "goal",
            )
            expect(goalMessages).toHaveLength(requests)
            expect(goalMessages[0]).toMatchObject({
              role: "developer",
              context: { type: "goal", goalId: "goal_continue" },
              content: [{ type: "text", text: "Continue the goal" }],
            })
            if (requests === 1) {
              entered.resolve()
              await release.promise
            } else {
              expect(goalMessages[1]).toMatchObject({
                role: "developer",
                context: { type: "goal", goalId: "goal_continue" },
                content: [{ type: "text", text: "Wrap up the goal" }],
              })
            }
            yield responseEvent(requests === 1 ? "progress" : "wrapped up")
          },
        }),
    })
    try {
      const thread = await manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      const continuation = {
        submissionId: "turn_goal_continue",
        content: { kind: "text" as const, text: "Continue the goal" },
        goalId: "goal_continue",
      }
      const started = await thread.startIfIdle(continuation)
      expect(started.type).toBe("started")
      await entered.promise
      await thread.steer(
        {
          content: { kind: "text", text: "Wrap up the goal" },
          goalId: "goal_continue",
        },
        continuation.submissionId,
      )
      release.resolve()
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({ completed: "wrapped up" })
      expect(submittedPrompts).toEqual([])
      expect(requests).toBe(2)
      await manager.closeThread(thread.id)
      const restored = await manager.resumeThread(thread.id)
      const history = restored
        ?.snapshot()
        .context.history.map(({ item }) => item)
      expect(
        history?.filter(
          (item) => item.role === "developer" && item.context?.type === "goal",
        ),
      ).toHaveLength(2)
      for (const retry of [
        {
          submissionId: continuation.submissionId,
          content: continuation.content,
        },
        { ...continuation, goalId: "goal_replacement" },
      ]) {
        await expect(restored?.startIfIdle(retry)).resolves.toEqual({
          type: "not_submitted",
          reason: "request_conflict",
        })
      }
      await expect(restored?.startIfIdle(continuation)).resolves.toMatchObject({
        type: "replayed",
      })
    } finally {
      release.resolve()
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("persists each answer fragment before continuing and returns the whole answer", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "First " }],
      },
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "second " }],
      },
      { content: [{ type: "text", text: "third." }] },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "First second third." })
    expect(provider.requests[1]?.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "First " }],
    })
    expect(provider.requests[2]?.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "second " }],
    })
    const reminders = provider.requests[2]?.messages.filter(
      (message) =>
        message.role === "developer" &&
        message.content.some(
          (block) =>
            block.type === "text" &&
            block.text.includes("Continue exactly where it stopped"),
        ),
    )
    expect(reminders).toHaveLength(1)
    const completion = (await runtime.store.readThread(thread.id))?.rollout.at(
      -1,
    )?.item
    expect(completion).toMatchObject({
      type: "turn_completed",
      outcome: "completed",
      metrics: { modelCalls: 3 },
      completion: { answerItemIds: expect.any(Array) },
    })
    if (completion?.type !== "turn_completed")
      throw new Error("Missing completion")
    expect(completion.completion?.answerItemIds).toHaveLength(3)
  })

  it("ends with a durable partial answer when the continuation budget is exhausted", async () => {
    const provider = createFauxProvider([
      ...["One ", "two ", "three"].map((text) => ({
        stopReason: ModelStopReason.Length,
        content: [{ type: "text" as const, text }],
      })),
      { content: [{ type: "text", text: "Next answer." }] },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "One two three", reason: "truncated" })
    expect(provider.callCount).toBe(3)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.at(-1)?.item,
    ).toMatchObject({
      outcome: "completed",
      completion: { reason: "truncated" },
    })
    await thread.startIfIdle({ content: { kind: "text", text: "Continue." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Next answer." })
    expect(JSON.stringify(provider.requests[3]?.messages)).toContain("three")
  })

  it.each([
    false,
    true,
  ])("rejects a first truncation without usable text (reasoning: %s)", async (reasoning) => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.Length,
        content: reasoning ? [{ type: "reasoning", text: "thinking" }] : [],
      },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ errored: "Model response was truncated without usable text." })
    expect(provider.callCount).toBe(1)
  })

  it("keeps the earlier answer when its continuation produces an empty truncation", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "Partial answer" }],
      },
      { stopReason: ModelStopReason.Length, content: [] },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Partial answer", reason: "truncated" })
    expect(provider.callCount).toBe(2)
  })

  it("does not replenish continuation budget after a stop hook starts a new answer", async () => {
    let stops = 0
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "Old " }],
      },
      { content: [{ type: "text", text: "answer" }] },
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "New " }],
      },
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "answer" }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        hookRunner: {
          async dispose() {},
          async run(request) {
            if (request.event === HookEvent.Stop) stops += 1
            return {
              continue: request.event !== HookEvent.Stop || stops > 1,
              additionalContext: [],
            }
          },
        },
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "New answer", reason: "truncated" })
    expect(provider.callCount).toBe(4)
    expect(stops).toBe(1)
  })

  it("preserves completed streamed tool effects when the response has an incomplete tail", async () => {
    let effects = 0
    const executed = deferred<void>()
    const call = {
      type: "tool_call" as const,
      id: "complete",
      name: "effect",
      input: {},
    }
    const runtime = await createRuntime(
      async function* () {
        yield { type: "output_item", itemId: "complete_item", content: [call] }
        await executed.promise
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.Length,
            incompleteToolCalls: true,
            content: [
              call,
              { type: "text", text: "Preserved explanation" },
              { ...call, id: "unstarted" },
            ],
          },
        }
      },
      createToolRegistry([
        {
          toolName: plainToolName("effect"),
          description: "Count effects",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            effects += 1
            executed.resolve()
            return { ok: true, output: effects, content: "Done" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Work." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ errored: "Model response contained an incomplete tool call." })
    expect(effects).toBe(1)
    expect(
      thread
        .snapshot()
        .context.history.filter(({ item }) => item.role === "tool"),
    ).toHaveLength(1)
    expect(JSON.stringify(thread.snapshot().context.history)).toContain(
      "Preserved explanation",
    )
  })

  it("executes complete tools from a length-stopped response only once", async () => {
    let effects = 0
    let samples = 0
    const call = {
      type: "tool_call" as const,
      id: "complete",
      name: "effect",
      input: {},
    }
    const runtime = await createRuntime(
      async function* () {
        samples += 1
        if (samples === 1) {
          yield {
            type: "output_item",
            itemId: "complete_item",
            content: [call],
          }
          yield {
            type: "response",
            response: { stopReason: ModelStopReason.Length, content: [call] },
          }
        } else yield responseEvent("Finished")
      },
      createToolRegistry([
        {
          toolName: plainToolName("effect"),
          description: "Count effects",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            effects += 1
            return { ok: true, output: effects, content: "Done" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Work." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Finished" })
    expect(effects).toBe(1)
    expect(samples).toBe(2)
  })

  it("preserves partial text but keeps a failed continuation as a failure", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.Length,
        content: [{ type: "text", text: "Partial" }],
      },
      { throwBefore: new Error("Connection failed") },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ errored: "Connection failed" })
    expect(JSON.stringify(thread.snapshot().context.history)).toContain(
      "Partial",
    )
  })

  it.each([
    false,
    true,
  ])("bounds repeated tool truncations before another request (streamed: %s)", async (streamed) => {
    let effects = 0
    let samples = 0
    const runtime = await createRuntime(
      async function* () {
        samples += 1
        const call = {
          type: "tool_call" as const,
          id: `effect_${samples}`,
          name: "effect",
          input: {},
        }
        if (streamed)
          yield {
            type: "output_item",
            itemId: `item_${samples}`,
            content: [call],
          }
        yield {
          type: "response",
          response: { stopReason: ModelStopReason.Length, content: [call] },
        }
      },
      createToolRegistry([
        {
          toolName: plainToolName("effect"),
          description: "Count effects",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            effects += 1
            return { ok: true, output: effects, content: "Done" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Work." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({
        errored: "Model repeatedly hit its generation limit during tool calls.",
      })
    expect(samples).toBe(5)
    expect(effects).toBe(5)
    expect(
      thread
        .snapshot()
        .context.history.filter(({ item }) => item.role === "tool"),
    ).toHaveLength(5)
  })

  it("excludes retried attempt commentary while retaining earlier Length answer fragments", async () => {
    let samples = 0
    const runtime = await createRuntime(async function* () {
      samples += 1
      if (samples === 1) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.Length,
            content: [{ type: "text", text: "Answer " }],
          },
        }
        return
      }
      yield {
        type: "output_item",
        itemId: "retry_commentary",
        content: [{ type: "text", text: "Checking again." }],
      }
      yield {
        type: "retry",
        committedOutput: true,
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 0,
        failure: {
          kind: "stream_disconnected",
          stage: "response_body",
          provider: "faux",
          wireApi: "faux",
          message: "Disconnected",
        },
      }
      yield responseEvent("complete.")
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Explain." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Answer complete." })
    expect(JSON.stringify(thread.snapshot().context.history)).toContain(
      "Checking again.",
    )
  })

  it.each([
    false,
    true,
  ])("preserves refusal text without continuing or running a stop hook (discarded tool tail: %s)", async (incompleteToolCalls) => {
    const hook = vi.fn<HookRunner["run"]>(async () => ({
      continue: true,
      additionalContext: [],
    }))
    let modelCalls = 0
    const runtime = await createRuntime(
      async function* () {
        modelCalls += 1
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ContentFilter,
            incompleteToolCalls,
            content: [{ type: "text", text: "Cannot help with that." }],
          },
        }
      },
      createToolRegistry([]),
      {
        hookRunner: { async dispose() {}, run: hook },
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "Request." } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Cannot help with that.", reason: "refused" })
    expect(modelCalls).toBe(1)
    expect(thread.snapshot().context.history).toContainEqual(
      expect.objectContaining({
        item: {
          role: "assistant",
          content: [{ type: "text", text: "Cannot help with that." }],
        },
      }),
    )
    expect(
      hook.mock.calls.some(([request]) => request.event === HookEvent.Stop),
    ).toBe(false)
  })

  it("materializes a new Session only after the prompt hook accepts its input", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "yakitori-prompt-materialization-"),
    )
    const store = new JsonlThreadStore({ root })
    let threadId = ""
    let sampled = false
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* () {
            sampled = true
            expect(
              (await store.listThreads()).threads.map((thread) => thread.id),
            ).toContain(threadId)
            yield responseEvent("accepted")
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          hookRunner: {
            async dispose() {},
            async run(request) {
              if (request.event === HookEvent.UserPromptSubmit)
                expect(
                  (await store.listThreads()).threads.map(
                    (thread) => thread.id,
                  ),
                ).not.toContain(threadId)
              return {
                continue: request.payload.prompt !== "block",
                additionalContext: [],
              }
            },
          },
        }),
    })
    try {
      const thread = await manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      threadId = thread.id
      await thread.startIfIdle({
        content: { kind: "text", text: "Persist after hook" },
      })
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({
          completed: "accepted",
        })
      expect(sampled).toBe(true)

      sampled = false
      const blocked = await manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "mate_revision_test",
      })
      threadId = blocked.id
      await blocked.startIfIdle({ content: { kind: "text", text: "block" } })
      await expect.poll(() => blocked.agentStatus).toEqual({ completed: null })
      expect(sampled).toBe(false)
      expect(
        (await store.listThreads()).threads.map((entry) => entry.id),
      ).not.toContain(blocked.id)
      await manager.closeThread(blocked.id)
      expect(await store.readThread(blocked.id)).toBeUndefined()
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("records a user message only after its prompt hook accepts it", async () => {
    const sampled: string[] = []
    const hookRunner: HookRunner = {
      async dispose() {},
      async run(request) {
        if (request.event === HookEvent.UserPromptSubmit) {
          return {
            continue: request.payload.prompt !== "blocked",
            additionalContext: [],
          }
        }
        return { continue: true, additionalContext: [] }
      },
    }
    const runtime = await createRuntime(
      async function* (request) {
        sampled.push(JSON.stringify(request.messages))
        yield responseEvent("accepted")
      },
      createToolRegistry([]),
      { hookRunner },
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({
      submissionId: "turn_blocked",
      content: { kind: "text", text: "blocked" },
    })
    await expect.poll(() => thread.status).toBe("idle")
    expect(sampled).toEqual([])
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.turnId === "turn_blocked" &&
          item.item.item.role === "user",
      ),
    ).toBe(false)

    await thread.startIfIdle({
      submissionId: "turn_accepted",
      content: { kind: "text", text: "accepted prompt" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "accepted" })
    expect(sampled).toHaveLength(1)
    expect(sampled[0]).toContain("accepted prompt")
    expect(sampled[0]).not.toContain("blocked")
  })

  it("enforces the output byte limit across deltas", async () => {
    const runtime = await createRuntime(
      async function* () {
        yield { type: "delta", text: "ab" }
        yield { type: "delta", text: "cd" }
        yield { type: "delta", text: "ef" }
        yield responseEvent("abcdef")
      },
      createToolRegistry([]),
      {
        executionPolicy: createSessionExecutionPolicy({
          assistantResponseBytes: 5,
        }),
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "go" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({
        errored: "Model stream update exceeded the configured byte limit.",
      })
  })

  it("counts a Unicode character split across deltas once", async () => {
    const emoji = "🙂"
    const runtime = await createRuntime(
      async function* () {
        yield { type: "delta", text: emoji[0] ?? "" }
        yield { type: "delta", text: emoji[1] ?? "" }
        yield {
          type: "response",
          response: { stopReason: ModelStopReason.EndTurn, content: [] },
        }
      },
      createToolRegistry([]),
      {
        executionPolicy: createSessionExecutionPolicy({
          assistantResponseBytes: 4,
        }),
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "go" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: null })
  })

  it("snapshots model transport configuration once per Turn", async () => {
    const policies: Parameters<ModelClient["startTurn"]>[1][] = []
    const responses = ["first", "second"]
    const modelClient: ModelClient = {
      hasProvider: (provider) => provider === "faux",
      models: () => createStaticModelsManager("faux"),
      startTurn(_provider, policy) {
        policies.push(policy)
        const text = responses.shift()
        if (text === undefined) throw new Error("Missing scripted response.")
        return {
          models: createStaticModelsManager("faux"),
          stream: async function* () {
            yield responseEvent(text)
          },
          close() {},
        }
      },
      close() {},
    }
    let maxAttempts = 4
    const runtime = await createRuntime(
      () => {
        throw new Error("Fallback stream must not run.")
      },
      createToolRegistry([]),
      {
        modelClient,
        provider: "faux",
        model: "faux",
        loadModelTransport: async () => ({
          maxAttempts,
          providers: { faux: { streamIdleTimeoutMs: 300_000 } },
        }),
      },
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "one" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "first" })
    maxAttempts = 2
    await thread.startIfIdle({ content: { kind: "text", text: "two" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "second" })

    const stored = await runtime.store.readThread(thread.id)
    const contexts = stored?.rollout.flatMap(({ item }) =>
      item.type === "turn_context" ? [item.context] : [],
    )
    expect(
      contexts?.map((context) => context.configuration.modelTransport),
    ).toEqual([
      {
        maxAttempts: 4,
        providers: { faux: { streamIdleTimeoutMs: 300_000 } },
      },
      {
        maxAttempts: 2,
        providers: { faux: { streamIdleTimeoutMs: 300_000 } },
      },
    ])
    expect(policies).toEqual([
      { maxAttempts: 4, streamIdleTimeoutMs: 300_000 },
      { maxAttempts: 2, streamIdleTimeoutMs: 300_000 },
    ])
  })

  it("runs pre/post tool hooks around the approved tool invocation", async () => {
    const events: string[] = []
    let executingThreadId: string | undefined
    const hookRunner: HookRunner = {
      async dispose() {},
      async run(request) {
        events.push(request.event)
        if (request.event === HookEvent.PreToolUse) {
          return {
            continue: true,
            additionalContext: [],
            updatedInput: { value: "after-hook" },
          }
        }
        if (request.event === HookEvent.PostToolUse) {
          return {
            continue: true,
            additionalContext: ["post-hook context"],
          }
        }
        return {
          continue: true,
          additionalContext: [],
        }
      },
    }
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "hooked_call",
            name: "hooked",
            input: { value: "before-hook" },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                toolContentText(message.content).includes("post-hook context"),
            ),
          ).toBe(true)
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          toolName: plainToolName("hooked"),
          description: "hooked tool",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute(input, context) {
            expect(input).toEqual({ value: "after-hook" })
            executingThreadId = context.threadId
            return { ok: true, output: "complete", content: "tool complete" }
          },
        },
      ]),
      {
        hookRunner,
        sessionHookContext: {
          sessionId: "session_hooked",
          workspaceRoot: process.cwd(),
          source: "startup",
          isSubagent: true,
        },
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(executingThreadId).toBe(thread.id)
    await runtime.manager.shutdown()
    expect(events).toEqual([
      HookEvent.SubagentStart,
      HookEvent.UserPromptSubmit,
      HookEvent.PreToolUse,
      HookEvent.PostToolUse,
      HookEvent.SubagentStop,
    ])
  })

  it("applies a body-after-prefix limit to growth after the first sampled input", async () => {
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "first done" }],
        usage: {
          inputTokens: 800,
          outputTokens: 200,
          activeContextTokens: 1_000,
        },
      },
      {
        content: [{ type: "text", text: "second done" }],
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          activeContextTokens: 1_100,
        },
      },
      {
        assertRequest(request) {
          expect(request.compaction).toBe("local")
          expect(JSON.stringify(request.messages)).not.toContain(
            "third request",
          )
        },
        content: [{ type: "text", text: "checkpoint" }],
      },
      {
        content: [{ type: "text", text: "third done" }],
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          activeContextTokens: 60,
        },
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 2_000,
        modelAutoCompactTokenLimit: 300,
        modelAutoCompactTokenLimitScope: "body_after_prefix",
      },
    )
    const thread = await runtime.createThread()
    for (const text of ["first request", "second request", "third request"]) {
      await thread.startIfIdle({ content: { kind: "text", text } })
      await nextLifecycleEvent(thread)
      await nextLifecycleEvent(thread)
    }

    expect(provider.callCount).toBe(4)
    expect(thread.snapshot().context).toMatchObject({
      activeContextTokens: 60,
      autoCompactPrefillTokens: 50,
    })
  })

  it("compacts a running tool chain while retaining user corrections outside the summary", async () => {
    let effects = 0
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "work_once", name: "work", input: {} },
        ],
        usage: { activeContextTokens: 59_000 },
      },
      {
        assertRequest(request) {
          expect(request.compaction === "local").toBe(true)
          expect(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                toolContentText(message.content) === "work completed",
            ),
          ).toBe(true)
        },
        content: [
          { type: "text", text: "The work was performed. Report its result." },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages.some(
              (message) =>
                message.role === "user" &&
                message.content.some(
                  (block) =>
                    block.type === "text" &&
                    block.text ===
                      "Complete the work. Do not change the public API.",
                ),
            ),
          ).toBe(true)
          expect(
            request.messages.some((message) => message.role === "tool"),
          ).toBe(false)
        },
        content: [{ type: "text", text: "Finished without API changes." }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          toolName: plainToolName("work"),
          description: "Perform work",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            effects += 1
            return { ok: true, output: effects, content: "work completed" }
          },
        },
      ]),
      { modelContextWindowTokens: 60_000 },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: {
        kind: "text",
        text: "Complete the work. Do not change the public API.",
      },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "Finished without API changes." })
    expect(effects).toBe(1)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.some(
        ({ item }) => item.type === "compacted",
      ),
    ).toBe(true)
  })

  it.each([
    "unchanged",
    "slower-summary",
    "warmup-priority",
    "instructions",
    "invalid-summary",
    "cancelled",
  ])("prepares during tools and safely handles %s checkpoints", async (mode) => {
    const applied =
      mode === "unchanged" ||
      mode === "slower-summary" ||
      mode === "warmup-priority"
    let now = 1000
    if (applied) {
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now)
      cleanups.push(async () => {
        dateNow.mockRestore()
      })
    }
    const firstToolFinished = deferred<void>()
    let warmups = 0
    const summaryReady = deferred<void>()
    const releaseSummary = deferred<void>()
    const summaryFinished = deferred<void>()
    const releaseTool = deferred<void>()
    const usageReported = deferred<void>()
    let normalCalls = 0
    let tools = 0
    let compactions = 0
    let secondToolFinished = false
    const stream: StreamFn = async function* (request) {
      if (request.compaction === "local") {
        compactions += 1
        expect(secondToolFinished).toBe(compactions > 1)
        expect(request.tools).toEqual([])
        if (compactions === 1)
          expect(JSON.stringify(request.messages)).not.toContain("call_2")
        summaryReady.resolve()
        if (applied) await releaseSummary.promise
        yield {
          type: "response",
          response: {
            stopReason:
              mode === "invalid-summary" && compactions === 1
                ? ModelStopReason.Length
                : ModelStopReason.EndTurn,
            content: [{ type: "text", text: "Earlier work completed." }],
            usage: { inputTokens: 100, outputTokens: 20 },
          },
        }
        summaryFinished.resolve()
        if (mode === "cancelled") {
          usageReported.resolve()
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            else
              request.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              })
          })
        }
        return
      }
      normalCalls += 1
      if (normalCalls <= 2) {
        if (mode === "warmup-priority" && normalCalls === 1) {
          yield {
            type: "output_item",
            itemId: "first_tool",
            content: [
              { type: "tool_call", id: "call_1", name: "work", input: {} },
            ],
          }
          await firstToolFinished.promise
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: `call_${normalCalls}`,
                name: "work",
                input: {},
              },
            ],
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              activeContextTokens: normalCalls === 2 ? 6000 : 1000,
            },
          },
        }
        return
      }
      expect(secondToolFinished).toBe(true)
      const messages = JSON.stringify(request.messages)
      expect(messages).toContain("Do not change the public API")
      expect(messages).toContain("Earlier work completed.")
      expect(messages).not.toContain("large old output")
      if (applied) {
        expect(Date.now() - 1000).toBe(mode === "slower-summary" ? 500 : 400)
        expect(request.messages.filter((item) => item.role === "tool")).toEqual(
          [
            {
              role: "tool",
              toolCallId: "call_2",
              content: [{ type: "text", text: "exact fresh result" }],
            },
          ],
        )
        expect(
          request.messages.some(
            (item) =>
              item.role === "assistant" &&
              item.content.some(
                (block) => block.type === "tool_call" && block.id === "call_2",
              ),
          ),
        ).toBe(true)
      }
      if (mode === "instructions")
        expect(messages).toContain("new project constraint")
      yield responseEvent("Done")
    }
    const runtime = await createRuntime(
      stream,
      createToolRegistry([
        {
          toolName: plainToolName("work"),
          description: "Work",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            tools += 1
            if (tools === 2) {
              await releaseTool.promise
              secondToolFinished = true
              return { ok: true, output: null, content: "exact fresh result" }
            }
            firstToolFinished.resolve()
            return {
              ok: true,
              output: null,
              content: "large old output ".repeat(400),
            }
          },
        },
      ]),
      {
        modelContextWindowTokens: 60_000,
        modelAutoCompactTokenLimit: 5000,
        ...(mode !== "warmup-priority"
          ? {}
          : {
              modelClient: {
                hasProvider: () => true,
                models: () => createStaticModelsManager("faux"),
                startTurn: () => ({
                  models: createStaticModelsManager("faux"),
                  stream,
                  warmup: async function* () {
                    warmups += 1
                    yield responseEvent("")
                  },
                  close() {},
                }),
                close() {},
              },
            }),
        loadProjectInstructions: async () =>
          mode === "instructions" && secondToolFinished
            ? { directory: "/workspace", text: "new project constraint" }
            : undefined,
      },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: { kind: "text", text: "Do not change the public API" },
    })
    await summaryReady.promise
    expect(
      thread
        .snapshot()
        .context.history.some(
          ({ item }) => item.role === "tool" && item.toolCallId === "call_1",
        ),
    ).toBe(true)
    // A controlled clock and independent gates measure the critical path;
    // no live provider, network timing, or scheduler-speed assertion is used.
    if (mode === "unchanged" || mode === "warmup-priority") {
      now = 1300
      releaseSummary.resolve()
      await summaryFinished.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      now = 1400
      releaseTool.resolve()
    } else if (mode === "slower-summary") {
      now = 1400
      releaseTool.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(normalCalls).toBe(2)
      now = 1500
      releaseSummary.resolve()
    } else releaseTool.resolve()
    if (mode === "cancelled") {
      await usageReported.promise
      await thread.interrupt("cancel checkpoint")
      await expect.poll(() => thread.agentStatus).toBe("interrupted")
      const stored = await runtime.store.readThread(thread.id)
      expect(
        stored?.rollout.filter(({ item }) => item.type === "compacted"),
      ).toEqual([])
      expect(
        stored?.rollout
          .filter(({ item }) => item.type === "turn_completed")
          .at(-1)?.item,
      ).toMatchObject({
        outcome: "interrupted",
        usage: { inputTokens: 300, outputTokens: 40 },
      })
      expect(JSON.stringify(thread.snapshot().context.history)).toContain(
        "large old output",
      )
      return
    }
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "Done" })
    expect(tools).toBe(2)
    expect(warmups).toBe(0)
    expect(compactions).toBe(applied ? 1 : 2)
    const stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.filter(({ item }) => item.type === "compacted"),
    ).toHaveLength(1)
    expect(
      stored?.rollout
        .filter(({ item }) => item.type === "turn_completed")
        .at(-1)?.item,
    ).toMatchObject({
      usage: {
        inputTokens: applied ? 300 : 400,
        outputTokens: applied ? 40 : 60,
      },
      metrics: {
        modelCalls: applied ? 4 : 5,
        toolCalls: 2,
        latency: {
          backgroundCompactionsApplied: applied ? 1 : 0,
          backgroundCompactionsDiscarded: applied ? 0 : 1,
          ...(applied
            ? {
                backgroundCompactionMs: mode === "slower-summary" ? 500 : 300,
                backgroundCompactionOverlapMs:
                  mode === "slower-summary" ? 400 : 300,
              }
            : {}),
        },
      },
    })
  })

  it("pairs compaction token usage with model timing while excluding compaction hooks", async () => {
    let now = 1_000
    let normalCalls = 0
    const hooks: HookEvent[] = []
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const stream: StreamFn = async function* (request) {
        const compacting = request.compaction === "local"
        if (!compacting) normalCalls += 1
        const text = compacting
          ? "checkpoint"
          : normalCalls === 1
            ? "old ".repeat(9000)
            : "done"
        now += compacting ? 100 : 50
        yield { type: "delta", text }
        now += compacting ? 300 : 150
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text }],
            usage: {
              inputTokens: compacting ? 80 : 20,
              outputTokens: compacting ? 40 : 10,
              activeContextTokens:
                !compacting && normalCalls === 1 ? 40_000 : 100,
            },
          },
        }
      }
      const runtime = await createRuntime(stream, createToolRegistry([]), {
        modelContextWindowTokens: 60_000,
        modelAutoCompactTokenLimit: 30_000,
        hookRunner: {
          async dispose() {},
          async run(request) {
            hooks.push(request.event)
            if (request.event === HookEvent.PreCompact) now += 1_000
            if (request.event === HookEvent.PostCompact) now += 2_000
            return { continue: true, additionalContext: [] }
          },
        },
      })
      const thread = await runtime.createThread()
      for (const text of ["First.", "Continue."]) {
        await thread.startIfIdle({ content: { kind: "text", text } })
        await nextLifecycleEvent(thread)
        await nextLifecycleEvent(thread)
      }
      expect(thread.agentStatus).toEqual({ completed: "done" })
      expect(hooks.filter((event) => event !== HookEvent.Stop)).toEqual([
        HookEvent.UserPromptSubmit,
        HookEvent.PreCompact,
        HookEvent.PostCompact,
        HookEvent.UserPromptSubmit,
      ])
      const stored = await runtime.store.readThread(thread.id)
      const completed = stored?.rollout
        .filter(({ item }) => item.type === "turn_completed")
        .at(-1)?.item
      expect(completed).toMatchObject({
        lastRequestStartedAt: new Date(4_600).toISOString(),
        usage: { inputTokens: 100, outputTokens: 50 },
        metrics: {
          modelCalls: 2,
          toolCalls: 0,
          modelDurationMs: 600,
          toolDurationMs: 0,
          averageTimeToFirstTokenMs: 75,
        },
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it.each([
    45, 100,
  ])("accounts for compaction in the shared budget of %i tokens", async (limitTokens) => {
    let calls = 0
    const requests: string[] = []
    const stream: StreamFn = async function* (request) {
      calls += 1
      requests.push(JSON.stringify(request.messages))
      const compacting = request.compaction === "local"
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [
            {
              type: "text",
              text: compacting
                ? "checkpoint"
                : calls === 1
                  ? "old ".repeat(9000)
                  : "done",
            },
          ],
          usage: {
            outputTokens: compacting ? 40 : 10,
            activeContextTokens: compacting ? 100 : calls === 1 ? 40_000 : 100,
          },
        },
      }
    }
    const runtime = await createRuntime(
      stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 60_000,
        modelAutoCompactTokenLimit: 30_000,
      },
      (threadId) =>
        rootOnlyAgentControl(threadId, undefined, {
          limitTokens,
          reminderAtRemainingTokens: [],
          samplingTokenWeight: 1,
          prefillTokenWeight: 1,
        }),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "First." } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "Continue." } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    if (limitTokens === 45) {
      expect(thread.agentStatus).toEqual({
        errored: "Session rollout token budget exceeded.",
      })
      expect(calls).toBe(2)
      expect(
        (await runtime.store.readThread(thread.id))?.rollout.some(
          ({ item }) => item.type === "compacted",
        ),
      ).toBe(false)
    } else {
      expect(thread.agentStatus).toEqual({ completed: "done" })
      expect(requests.at(-1)).toContain("50 weighted tokens")
    }
  })

  it("continues tool follow-ups until the model completes the task", async () => {
    let completedTools = 0
    let samples = 0
    const stream: StreamFn = async function* () {
      samples += 1
      if (completedTools === 40) {
        yield responseEvent("All forty work items completed.")
        return
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.ToolUse,
          content: [0, 1].map((index) => ({
            type: "tool_call" as const,
            id: `work_${samples}_${index}`,
            name: "work",
            input: {},
          })),
        },
      }
    }
    const runtime = await createRuntime(
      stream,
      createToolRegistry([
        {
          toolName: plainToolName("work"),
          description: "Complete a work item",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: { kind: "none" },
          async execute() {
            completedTools += 1
            return { ok: true, output: completedTools, content: "complete" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: { kind: "text", text: "Complete forty work items." },
    })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(completedTools).toBe(40)
    const stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "assistant" &&
          item.item.item.content.some(
            (block) =>
              block.type === "text" &&
              block.text === "All forty work items completed.",
          ),
      ),
    ).toBe(true)
  })

  it("disposes tools when model-client cleanup fails", async () => {
    let toolDisposed = false
    const toolRegistry = createToolRegistry([
      {
        toolName: plainToolName("cleanup_probe"),
        description: "Cleanup probe",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          return { ok: true, output: null, content: "done" }
        },
        dispose() {
          toolDisposed = true
        },
      },
    ])
    const modelClient: ModelClient = {
      hasProvider: (provider) => provider === "faux",
      models: () => createStaticModelsManager("faux"),
      startTurn() {
        throw new Error("unused")
      },
      async close() {
        throw new Error("model close failed")
      },
    }
    const processor = createTurnProcessor({ modelClient, toolRegistry })

    const dispose = processor.dispose?.()
    await expect(dispose).rejects.toThrow("Failed to dispose Turn processor")
    await expect(dispose).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "model close failed" })],
    })

    expect(toolDisposed).toBe(true)
  })

  it("persists an acknowledged mailbox message exactly once after append failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mailbox-"))
    const store = new MemoryThreadStore()
    const firstProvider = createFauxProvider([
      {
        assertRequest(request) {
          expect(
            JSON.stringify(request.messages).match(/durable mailbox/g),
          ).toHaveLength(1)
        },
        content: [{ type: "text", text: "first done" }],
      },
    ])
    let rootControl: AgentControl | undefined
    let firstManager!: ThreadManager
    firstManager = new ThreadManager({
      store,
      createTurnProcessor(stored) {
        const control = rootOnlyAgentControl(
          stored.metadata.id,
          async (request) => {
            const target = firstManager.getThread(request.sessionId)
            if (target === undefined) throw new Error("missing target thread")
            await target.deliverAgentMessage(request.messageId, request.text)
          },
        )
        rootControl = control
        return createTurnProcessor({
          stream: firstProvider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          agentControl: control,
        })
      },
    })
    const thread = await firstManager.createThread({
      workingDirectory: root,
      mateId: "mate_live",
      mateRevisionId: "mate_revision_live",
    })
    if (rootControl === undefined) throw new Error("missing root control")
    store.failNextAppend = true
    await rootControl
      .bind(thread.id, {
        provider: "faux",
        model: "scripted",
      })
      .sendMessage({ target: thread.id, message: "durable mailbox" })
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await firstManager.shutdown()

    const stored = await store.readThread(thread.id)
    expect(
      stored?.rollout.filter(
        (entry) =>
          entry.item.type === "agent_message" &&
          entry.item.item.item.role === "user" &&
          entry.item.item.item.content.some(
            (block) =>
              block.type === "text" && block.text.includes("durable mailbox"),
          ),
      ),
    ).toHaveLength(1)

    const resumedProvider = createFauxProvider([
      {
        assertRequest(request) {
          expect(
            JSON.stringify(request.messages).match(/durable mailbox/g),
          ).toHaveLength(1)
        },
        content: [{ type: "text", text: "resumed done" }],
      },
    ])
    let resumedManager!: ThreadManager
    resumedManager = new ThreadManager({
      store,
      createTurnProcessor: (storedThread) =>
        createTurnProcessor({
          stream: resumedProvider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          agentControl: rootOnlyAgentControl(
            storedThread.metadata.id,
            async (request) => {
              const target = resumedManager.getThread(request.sessionId)
              if (target === undefined) throw new Error("missing target thread")
              await target.deliverAgentMessage(request.messageId, request.text)
            },
          ),
        }),
    })
    const resumed = await resumedManager.resumeThread(thread.id)
    await resumed?.startIfIdle({
      content: { kind: "text", text: "run after restart" },
    })
    if (resumed !== undefined) {
      await nextLifecycleEvent(resumed)
      await nextLifecycleEvent(resumed)
    }
    await resumedManager.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it("runs against actor-owned context and persists usage with the terminal Turn", async () => {
    const provider = createFauxProvider([
      {
        assertRequest(request) {
          expect(request.system).toHaveLength(1)
        },
        content: [
          { type: "reasoning", text: "Think", providerMetadata: { id: "r" } },
          { type: "text", text: "Hello" },
        ],
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          activeContextTokens: 9,
        },
        providerRequestId: "provider_request_1",
      },
    ])
    const runtime = await createRuntime(provider.stream)
    const thread = await runtime.createThread()

    await expect(
      thread.startIfIdle({ content: { kind: "text", text: "hi" } }),
    ).resolves.toMatchObject({ type: "started" })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")

    expect(
      thread.snapshot().context.history.map((item) => item.item.role),
    ).toEqual(["user", "developer", "developer", "user", "assistant"])
    expect(thread.snapshot().configuration?.defaultTarget).toEqual({
      provider: "faux",
      model: "scripted",
    })
    const stored = await runtime.store.readThread(thread.id)
    const completed = stored?.rollout.find(
      (entry) =>
        entry.item.type === "turn_completed" &&
        entry.item.outcome === "completed",
    )?.item
    expect(completed).toMatchObject({
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        activeContextTokens: 9,
      },
      metrics: { modelCalls: 1, toolCalls: 0 },
    })
    if (completed?.type === "turn_completed") {
      expect(completed.metrics?.modelDurationMs).toBeGreaterThanOrEqual(0)
      expect(completed.metrics?.toolDurationMs).toBe(0)
      expect(
        completed.metrics?.averageTimeToFirstTokenMs,
      ).toBeGreaterThanOrEqual(0)
    }
    const assistant = stored?.rollout.find(
      (entry) =>
        entry.item.type === "response_item" &&
        entry.item.item.item.role === "assistant",
    )
    expect(
      stored?.rollout.find((entry) => entry.item.type === "token_count")?.item,
    ).toMatchObject({
      type: "token_count",
      historyAnchorItemId:
        assistant?.item.type === "response_item"
          ? assistant.item.item.id
          : undefined,
      provider: "faux",
      model: "scripted",
    })
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "response_item" &&
          entry.item.item.item.role === "assistant",
      )?.item,
    ).toMatchObject({
      item: {
        providerMetadata: {
          provider: "faux",
          model: "scripted",
          requestId: "provider_request_1",
        },
      },
    })
    expect(
      stored?.rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item.type] : [],
      ),
    ).toEqual(["reasoning", "agent_message"])
  })

  it("records assistant tool calls and tool results before the next model call", async () => {
    const provider = createFauxProvider([
      {
        usage: { inputTokens: 10, outputTokens: 2, activeContextTokens: 9 },
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_echo",
            name: "echo",
            input: { text: "hello" },
          },
        ],
      },
      {
        usage: { inputTokens: 4, outputTokens: 1, activeContextTokens: 3 },
        assertRequest(request) {
          expect(
            request.messages.slice(-2).map((message) => message.role),
          ).toEqual(["assistant", "tool"])
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const tools = createToolRegistry([
      {
        toolName: plainToolName("echo"),
        description: "Echo text",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute(value) {
          return { ok: true, output: value as never, content: "hello" }
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "use echo" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(provider.callCount).toBe(2)
    expect(
      thread.snapshot().context.history.map((item) => item.item.role),
    ).toEqual([
      "user",
      "developer",
      "developer",
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
    const rollout = (await runtime.store.readThread(thread.id))?.rollout ?? []
    expect(
      rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item.type] : [],
      ),
    ).toEqual(["dynamic_tool_call", "agent_message"])
    const started = rollout.filter(
      (entry) => entry.item.type === "item_started",
    )
    expect(started).toHaveLength(1)
    const completed = rollout.find(
      (entry) =>
        entry.item.type === "item_completed" &&
        entry.item.item.type === "dynamic_tool_call",
    )
    expect(started[0]?.item).toMatchObject({
      item: {
        itemId:
          completed?.item.type === "item_completed"
            ? completed.item.item.itemId
            : undefined,
      },
    })
    expect(started[0]?.seq).toBeLessThan(completed?.seq ?? -1)
    expect(
      rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "completed",
      )?.item,
    ).toMatchObject({
      usage: {
        inputTokens: 14,
        outputTokens: 3,
        activeContextTokens: 3,
      },
    })
  })

  it("persists the last of multiple request starts even when its stream finishes much later", async () => {
    const firstStart = Date.parse("2026-09-20T10:00:00.000Z")
    const secondStart = Date.parse("2026-09-20T10:03:00.000Z")
    let clock = firstStart
    let calls = 0
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock)
    try {
      const stream: StreamFn = async function* () {
        calls += 1
        if (calls === 1) {
          clock = secondStart
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.ToolUse,
              content: [
                {
                  type: "tool_call",
                  id: "tool_clock",
                  name: "clock",
                  input: {},
                },
              ],
            },
          }
        } else {
          clock += 7 * 60_000
          yield responseEvent("done")
        }
      }
      const runtime = await createRuntime(
        stream,
        createToolRegistry([
          {
            toolName: plainToolName("clock"),
            description: "Clock",
            inputSchema: { type: "object" },
            effect: "observe",
            approvalRequirement: { kind: "none" },
            async execute() {
              return { ok: true, output: {}, content: "tick" }
            },
          },
        ]),
      )
      const thread = await runtime.createThread()
      await thread.startIfIdle({ content: { kind: "text", text: "tick" } })
      await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })

      expect(calls).toBe(2)
      expect(
        (await runtime.store.readThread(thread.id))?.rollout.find(
          ({ item }) => item.type === "turn_completed",
        )?.item,
      ).toMatchObject({
        lastRequestStartedAt: "2026-09-20T10:03:00.000Z",
        metrics: { modelCalls: 2 },
      })
      expect(clock).toBe(Date.parse("2026-09-20T10:10:00.000Z"))
    } finally {
      dateNow.mockRestore()
    }
  })

  it("leaves the request start unknown when the final stream retries internally", async () => {
    const stream: StreamFn = async function* () {
      yield {
        type: "retry",
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 100,
        failure: {
          kind: "connection_failed",
          stage: "connect",
          provider: "faux",
          wireApi: "unknown",
          message: "First request failed.",
        },
      }
      yield responseEvent("done")
    }
    const runtime = await createRuntime(stream)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "retry" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })

    const completed = (await runtime.store.readThread(thread.id))?.rollout.find(
      ({ item }) => item.type === "turn_completed",
    )?.item
    expect(completed).toMatchObject({
      type: "turn_completed",
      outcome: "completed",
    })
    expect(completed).not.toHaveProperty("lastRequestStartedAt")
  })

  it("reports an unexpected tool throw with its owning operation", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_throw",
            name: "throwing_tool",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "recovered" }] },
    ])
    const cause = new Error("unexpected tool throw")
    const tools = createToolRegistry([
      {
        toolName: plainToolName("throwing_tool"),
        description: "Throw unexpectedly",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          throw cause
        },
      },
    ])
    const failures: TurnProcessorOperationalFailure[] = []
    const runtime = await createRuntime(provider.stream, tools, {
      async onOperationalFailure(failure) {
        failures.push(failure)
        throw new Error("reporter rejected")
      },
    })
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "use it" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    await Promise.resolve()

    expect(failures).toEqual([{ operation: "execute-tool", cause }])
  })

  it("carries a deferred search hit through the next model request and dispatches it", async () => {
    const registry = createToolRegistry([])
    registry.replaceExternalSource("calendar-server", [
      {
        toolName: { namespace: "calendar", name: "search_events" },
        exposure: "deferred",
        description: "Search calendar events",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          return {
            ok: true,
            output: { events: ["planning"] },
            content: "planning",
          }
        },
      },
    ])
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "search_1",
            name: "tool_search",
            input: { query: "calendar events" },
            toolKind: "tool_search",
          },
        ],
      },
      {
        assertRequest(request) {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            "tool_search",
            "calendar__search_events",
          ])
          expect(request.tools[1]).toMatchObject({ deferLoading: true })
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "search_1",
            toolSearch: {
              tools: [{ name: "calendar__search_events" }],
            },
          })
        },
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "calendar_1",
            name: "calendar__search_events",
            input: { query: "planning" },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "calendar_1",
            content: [{ type: "text", text: "planning" }],
          })
        },
        content: [{ type: "text", text: "found it" }],
      },
    ])
    const runtime = await createRuntime(provider.stream, registry, {
      modelContextWindowTokens: 100_000,
    })
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "find it" } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(provider.callCount).toBe(3)
  })

  it("pins each response to one Step and refreshes definitions before the next sample", async () => {
    const registry = createToolRegistry([])
    const versionOne = {
      ...identifiedDeferredTool("version one"),
      inputSchema: {
        type: "object",
        properties: { legacyQuery: { type: "string" } },
        required: ["legacyQuery"],
      },
    }
    const versionTwo = {
      ...identifiedDeferredTool("version two"),
      inputSchema: {
        type: "object",
        properties: { replacementQuery: { type: "string" } },
        required: ["replacementQuery"],
      },
    }
    registry.replaceExternalSource("calendar-server", [versionOne])
    let callCount = 0
    const stream: StreamFn = async function* (request) {
      callCount += 1
      if (callCount === 1) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "search_pinned",
                name: "tool_search",
                input: { query: "calendar events" },
                toolKind: "tool_search",
              },
            ],
          },
        }
        registry.replaceExternalSource("calendar-server", [versionTwo])
        return
      }
      if (callCount === 2) {
        expect(request.tools[1]).toMatchObject({
          description: "version two",
          inputSchema: { required: ["replacementQuery"] },
        })
        expect(request.messages.at(-1)).toMatchObject({
          toolSearch: {
            tools: [
              {
                description: "version one",
                inputSchema: { required: ["legacyQuery"] },
              },
            ],
          },
        })
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "calendar_pinned",
                name: "calendar__search_events",
                input: { legacyQuery: "planning" },
              },
            ],
          },
        }
        return
      }
      if (callCount === 3) {
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          toolCallId: "calendar_pinned",
          content: [{ type: "text", text: "version two" }],
        })
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "done" }],
          },
        }
        return
      }
      expect(request.tools[1]).toMatchObject({
        description: "version two",
        inputSchema: { required: ["replacementQuery"] },
      })
      expect(
        request.messages.find(
          (message) =>
            message.role === "tool" && message.toolCallId === "search_pinned",
        ),
      ).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("version one"),
          }),
        ]),
        toolSearch: {
          tools: [expect.objectContaining({ description: "version one" })],
        },
      })
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "new turn" }],
        },
      }
    }
    const runtime = await createRuntime(stream, registry, {
      modelContextWindowTokens: 100_000,
    })
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "find it" } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    await thread.startIfIdle({ content: { kind: "text", text: "again" } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(callCount).toBe(4)
  })

  it.each([
    { provider: "grok", model: "grok-4.6" },
    { provider: "kimi", model: "k3" },
  ])("routes $provider use_tool through the deferred runtime captured by that Step", async ({
    provider,
    model,
  }) => {
    const registry = createToolRegistry([])
    registry.replaceExternalSource("calendar-server", [
      identifiedDeferredTool("meta result"),
    ])
    const visibleToolSets: string[][] = []
    let callCount = 0
    const stream: StreamFn = async function* (request) {
      callCount += 1
      visibleToolSets.push(request.tools.map(({ name }) => name))
      if (callCount === 1) {
        expect(request.toolWireProtocol).toBe("meta_dispatch")
        expect(request.tools.map(({ name }) => name)).toEqual([
          "tool_search",
          "use_tool",
        ])
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "meta_1",
                name: "use_tool",
                input: {
                  tool_name: "calendar__search_events",
                  tool_input: { query: "planning" },
                },
              },
            ],
          },
        }
        return
      }
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "meta_1",
        content: [{ type: "text", text: "meta result" }],
      })
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    }
    const runtime = await createRuntime(stream, registry, {
      modelContextWindowTokens: 100_000,
    })
    const thread = await runtime.createThread()

    await thread.startIfIdle({
      content: { kind: "text", text: "find it" },
      modelSelection: { provider, model },
    })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(visibleToolSets[1]).toEqual(visibleToolSets[0])
  })

  it("warns once when a Turn uses conservative fallback model metadata", async () => {
    const provider = createFauxProvider(
      ["first", "second"].flatMap((id) => [
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            { type: "tool_call" as const, id, name: "probe", input: {} },
          ],
        },
        { content: [{ type: "text" as const, text: "done" }] },
      ]),
    )
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          toolName: plainToolName("probe"),
          description: "Run a second model step",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute() {
            return { ok: true, output: "step done", content: "step done" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()

    for (const { turnId, text } of [
      { turnId: "turn_fallback_first", text: "continue safely" },
      { turnId: "turn_fallback_second", text: "continue again" },
    ]) {
      await thread.startIfIdle({
        submissionId: turnId,
        content: { kind: "text", text },
        modelSelection: { provider: "future-provider", model: "future-model" },
      })
      const events: SessionEvent[] = []
      for (;;) {
        const event = await thread.nextEvent()
        if (event === undefined)
          throw new Error("Thread ended before completion.")
        events.push(event)
        if (event.type === "turn.completed") break
      }
      const warnings = events.filter(
        (event) =>
          event.type === "runtime.warning" &&
          event.message.includes("future-provider/future-model was not found"),
      )
      expect(warnings).toEqual([
        expect.objectContaining({
          type: "runtime.warning",
          turnId,
          message: expect.stringContaining(
            "future-provider/future-model was not found",
          ),
        }),
      ])
    }
    expect(provider.callCount).toBe(4)
  })

  it("uses a provider ModelsManager for Step capabilities and capacity validation", async () => {
    const fallback = createStaticModelsManager("faux")
    const refresh = vi.fn(async () => undefined)
    const models: ModelsManager = {
      provider: "faux",
      refresh,
      listModels: fallback.listModels,
      resolve(selection) {
        return { ...fallback.resolve(selection), shellToolType: "disabled" }
      },
      validate: fallback.validate,
      capacity() {
        return {
          contextWindowTokens: 12_000,
          maxContextWindowTokens: 12_345,
          effectiveContextWindowPercent: 100,
          contextWindowScope: "input",
        }
      },
    }
    const modelClient: ModelClient = {
      hasProvider: (provider) => provider === "faux",
      models: () => models,
      startTurn() {
        return {
          models,
          stream: async function* (request) {
            expect(request.tools.map(({ name }) => name)).not.toContain(
              "exec_command",
            )
            yield responseEvent("done")
          },
          close() {},
        }
      },
      close() {},
    }
    const runtime = await createRuntime(
      () => {
        throw new Error("fallback stream must not run")
      },
      createToolRegistry(),
      { modelClient },
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(refresh).toHaveBeenCalled()

    const invalid = await createRuntime(
      () => {
        throw new Error("fallback stream must not run")
      },
      createToolRegistry([]),
      { modelClient, modelContextWindowTokens: 12_346 },
    )
    const invalidThread = await invalid.createThread()
    await expect(
      invalidThread.startIfIdle({ content: { kind: "text", text: "run" } }),
    ).rejects.toThrow(
      "model_context_window 12346 exceeds faux/scripted maximum of 12345",
    )
  })

  it("passes the physical rollout ID to tool asset storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-rollout-identity-"))
    const store = new MemoryThreadStore()
    const threadId = "session_logical"
    const rolloutId = "rollout_physical"
    const now = new Date().toISOString()
    await store.createThread({
      id: threadId,
      conversationId: threadId,
      createdAt: now,
      updatedAt: now,
      workingDirectory: root,
      mateId: "mate_live",
      mateRevisionId: "mate_revision_live",
    })
    await store.shutdownThread(threadId)
    store.reidentifyRollout(threadId, rolloutId)

    let toolRolloutId: string | undefined
    const tools = createToolRegistry([
      {
        toolName: plainToolName("capture_rollout"),
        description: "Capture the rollout asset owner.",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute(_value, context) {
          toolRolloutId = context.rolloutId
          return { ok: true, output: {}, content: "captured" }
        },
      },
    ])
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_capture_rollout",
            name: "capture_rollout",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: tools,
          loadProjectInstructions: async () => undefined,
        }),
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    })

    const thread = await manager.resumeThread(threadId)
    if (thread === undefined) throw new Error("Thread was not resumed.")
    await thread.startIfIdle({ content: { kind: "text", text: "capture" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(toolRolloutId).toBe(rolloutId)
  })

  it.each([
    "none",
    "short",
    "long",
  ])("persists a visible read with %s hook context so a later call can edit", async (hookKind) => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_read_value",
            name: "read_file",
            input: { path: "value.txt" },
          },
        ],
      },
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_edit_value",
            name: "edit_file",
            input: {
              path: "value.txt",
              oldString: "value = 1",
              newString: "value = 2",
            },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry(), {
      hookRunner: {
        async dispose() {},
        async run(request) {
          return {
            continue: true,
            additionalContext:
              request.event === HookEvent.PostToolUse && hookKind !== "none"
                ? [
                    hookKind === "short"
                      ? "short hook"
                      : "long hook\n".repeat(6000),
                  ]
                : [],
          }
        },
      },
    })
    const thread = await runtime.createThread()
    const path = join(runtime.root, "value.txt")
    await writeFile(path, "value = 1\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(await readFile(path, "utf8")).toBe("value = 2\n")
    expect(
      thread
        .snapshot()
        .context.history.find(
          (item) =>
            item.item.role === "tool" &&
            item.item.toolCallId === "tool_read_value",
        )?.item,
    ).toMatchObject({
      fileObservations: [
        {
          path: "value.txt",
          kind: "whole_file_read",
          complete: true,
        },
      ],
    })
    const completedItems =
      (await runtime.store.readThread(thread.id))?.rollout.flatMap((entry) =>
        entry.item.type === "item_completed" ? [entry.item.item] : [],
      ) ?? []
    expect(
      completedItems.find(
        (item) => "toolCallId" in item && item.toolCallId === "tool_read_value",
      ),
    ).toMatchObject({
      type: "file_read",
      result: { path: "value.txt", kind: "file" },
    })
    expect(
      completedItems.find(
        (item) => "toolCallId" in item && item.toolCallId === "tool_edit_value",
      ),
    ).toMatchObject({
      type: "file_change",
      changes: [{ path: "value.txt", kind: "update" }],
    })
  })

  it("restores file observations after resume and rejects a stale edit", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_read_before_resume",
            name: "read_file",
            input: { path: "resume.txt" },
          },
        ],
      },
      { content: [{ type: "text", text: "read" }] },
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_stale_edit",
            name: "edit_file",
            input: {
              path: "resume.txt",
              oldString: "before",
              newString: "after",
            },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                toolCallId: "tool_stale_edit",
                isError: true,
                content: [
                  {
                    type: "text",
                    text: expect.stringContaining(
                      "file_changed_since_observation",
                    ),
                  },
                ],
              }),
            ]),
          )
        },
        content: [{ type: "text", text: "stale" }],
      },
    ])
    const tools = createToolRegistry()
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    const path = join(runtime.root, "resume.txt")
    await writeFile(path, "before\n")
    await thread.startIfIdle({ content: { kind: "text", text: "read" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await runtime.manager.shutdown()
    await writeFile(path, "changed externally\n")

    const resumedManager = new ThreadManager({
      store: runtime.store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: tools,
          loadProjectInstructions: async () => undefined,
        }),
    })
    cleanups.push(() => resumedManager.shutdown())
    const resumed = await resumedManager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Thread was not resumed.")
    await resumed.startIfIdle({ content: { kind: "text", text: "edit" } })
    await nextLifecycleEvent(resumed)
    await nextLifecycleEvent(resumed)

    expect(await readFile(path, "utf8")).toBe("changed externally\n")
  })

  it("edits through an exact current anchor when read and edit share a model call", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_same_read",
            name: "read_file",
            input: { path: "same-call.txt" },
          },
          {
            type: "tool_call",
            id: "tool_same_edit",
            name: "edit_file",
            input: {
              path: "same-call.txt",
              oldString: "one",
              newString: "two",
            },
          },
        ],
      },
      {
        assertRequest(request) {
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                toolCallId: "tool_same_edit",
                content: [
                  {
                    type: "text",
                    text: expect.stringContaining("Updated same-call.txt"),
                  },
                ],
              }),
            ]),
          )
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry())
    const thread = await runtime.createThread()
    const path = join(runtime.root, "same-call.txt")
    await writeFile(path, "one\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(await readFile(path, "utf8")).toBe("two\n")
  })

  it("removes truncated read grants without blocking an exact edit", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_truncated_read",
            name: "read_file",
            input: { path: "truncated.txt" },
          },
        ],
      },
      {
        assertRequest(request) {
          const read = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "tool_truncated_read",
          )
          expect(read).toMatchObject({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Read preview truncated"),
              }),
            ]),
          })
          expect(read).not.toHaveProperty("fileObservations")
        },
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_edit_after_truncation",
            name: "edit_file",
            input: {
              path: "truncated.txt",
              oldString: "one",
              newString: "changed",
            },
          },
        ],
      },
      {
        assertRequest(request) {
          const edit = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "tool_edit_after_truncation",
          )
          expect(edit).toMatchObject({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Updated truncated.txt"),
              }),
            ]),
          })
          expect(edit).not.toHaveProperty("isError", true)
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const runtime = await createRuntime(provider.stream, createToolRegistry(), {
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleToolResultLines: 1,
      }),
    })
    const thread = await runtime.createThread()
    const path = join(runtime.root, "truncated.txt")
    await writeFile(path, "one\ntwo\n")

    await thread.startIfIdle({ content: { kind: "text", text: "update" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(thread.agentStatus).toEqual({ completed: "done" })
    expect(provider.callCount).toBe(3)
    expect(await readFile(path, "utf8")).toBe("changed\ntwo\n")
  })

  it("delivers committed tool history before the next model stream", async () => {
    const provider = createFauxProvider([
      {
        snapshots: ["calling tool"],
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_order",
            name: "echo",
            input: { text: "hello" },
          },
        ],
      },
      {
        snapshots: ["final answer"],
        content: [{ type: "text", text: "final answer" }],
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          toolName: plainToolName("echo"),
          description: "Echo text",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute(value) {
            return { ok: true, output: value as never, content: "hello" }
          },
        },
      ]),
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "use echo" } })
    const events: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) throw new Error("Session ended before the Turn.")
      events.push(event)
      if (event.type === "turn.completed") break
    }

    const toolResultAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" && item.item.item.role === "tool",
        ),
    )
    const finalStreamAt = events.findIndex(
      (event) =>
        event.type === "model.stream" && event.delta === "final answer",
    )
    expect(toolResultAt).toBeGreaterThan(-1)
    expect(finalStreamAt).toBeGreaterThan(toolResultAt)
  })

  it("delivers permission events between the tool call and its result", async () => {
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_permission_order",
            name: "approved",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const permissionGate = createPermissionGate()
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([
        {
          toolName: plainToolName("approved"),
          description: "Requires approval",
          inputSchema: { type: "object" },
          effect: "mutate",
          approvalRequirement: {
            kind: "approval",
            action: "command_execution",
          },
          async execute() {
            return { ok: true, output: {}, content: "approved" }
          },
        },
      ]),
      { permissionGate, approvalPolicy: "auto_file_tools" },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    const pending = await waitForValue(() => permissionGate.list(thread.id)[0])
    permissionGate.resolve({
      sessionId: thread.id,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })

    const events: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) throw new Error("Session ended before the Turn.")
      events.push(event)
      if (event.type === "turn.completed") break
    }
    const toolCallAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" &&
            item.item.item.role === "assistant" &&
            item.item.item.content.some(
              (block) =>
                block.type === "tool_call" &&
                block.id === "tool_permission_order",
            ),
        ),
    )
    const requestedAt = events.findIndex(
      (event) =>
        event.type === "permission" &&
        event.event.type === "permission.requested",
    )
    const resolvedAt = events.findIndex(
      (event) =>
        event.type === "permission" &&
        event.event.type === "permission.resolved",
    )
    const toolResultAt = events.findIndex(
      (event) =>
        event.type === "rollout.appended" &&
        event.items.some(
          (item) =>
            item.type === "response_item" && item.item.item.role === "tool",
        ),
    )
    expect(toolCallAt).toBeGreaterThan(-1)
    expect(requestedAt).toBeGreaterThan(toolCallAt)
    expect(resolvedAt).toBeGreaterThan(requestedAt)
    expect(toolResultAt).toBeGreaterThan(resolvedAt)
  })

  it("uses a local serial barrier and resumes later parallel calls together", async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const releaseReaders = deferred<void>()
    const writerEntered = deferred<void>()
    const releaseWriter = deferred<void>()
    const fourthEntered = deferred<void>()
    const fifthEntered = deferred<void>()
    const events: string[] = []
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "tool_first", name: "first", input: {} },
          { type: "tool_call", id: "tool_second", name: "second", input: {} },
          { type: "tool_call", id: "tool_writer", name: "writer", input: {} },
          { type: "tool_call", id: "tool_fourth", name: "fourth", input: {} },
          { type: "tool_call", id: "tool_fifth", name: "fifth", input: {} },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages
              .filter((message) => message.role === "tool")
              .map((message) => message.toolCallId),
          ).toEqual([
            "tool_first",
            "tool_second",
            "tool_writer",
            "tool_fourth",
            "tool_fifth",
          ])
        },
        content: [{ type: "text", text: "done" }],
      },
    ])
    const tools = createToolRegistry([
      {
        toolName: plainToolName("first"),
        description: "First observation",
        inputSchema: { type: "object" },
        effect: "observe",
        supportsParallelToolCalls: true,
        approvalRequirement: { kind: "none" },
        async execute() {
          events.push("start:first")
          firstEntered.resolve()
          await releaseReaders.promise
          events.push("end:first")
          return { ok: true, output: "first", content: "first" }
        },
      },
      {
        toolName: plainToolName("second"),
        description: "Second observation",
        inputSchema: { type: "object" },
        effect: "observe",
        supportsParallelToolCalls: true,
        approvalRequirement: { kind: "none" },
        async execute() {
          events.push("start:second")
          secondEntered.resolve()
          await releaseReaders.promise
          events.push("end:second")
          return { ok: true, output: "second", content: "second" }
        },
      },
      scheduledTool("writer", false, events, writerEntered, releaseWriter),
      scheduledTool("fourth", true, events, fourthEntered),
      scheduledTool("fifth", true, events, fifthEntered),
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "observe" } })
    await firstEntered.promise
    await secondEntered.promise
    expect(events).toEqual(["start:first", "start:second"])
    releaseReaders.resolve()
    await writerEntered.promise
    expect(events.at(-1)).toBe("start:writer")
    expect(events).not.toContain("start:fourth")
    expect(events).not.toContain("start:fifth")
    releaseWriter.resolve()
    await fourthEntered.promise
    await fifthEntered.promise
    expect(events.indexOf("start:fourth")).toBeGreaterThan(
      events.indexOf("end:writer"),
    )
    expect(events.indexOf("start:fifth")).toBeGreaterThan(
      events.indexOf("end:writer"),
    )
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(2)
  })

  it("reserves a serial barrier before waiting for its permission", async () => {
    const permissionGate = createPermissionGate()
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const writerEntered = deferred<void>()
    const fourthEntered = deferred<void>()
    const fifthEntered = deferred<void>()
    const events: string[] = []
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "permission_first",
            name: "first",
            input: {},
          },
          {
            type: "tool_call",
            id: "permission_second",
            name: "second",
            input: {},
          },
          {
            type: "tool_call",
            id: "permission_writer",
            name: "writer",
            input: {},
          },
          {
            type: "tool_call",
            id: "permission_fourth",
            name: "fourth",
            input: {},
          },
          {
            type: "tool_call",
            id: "permission_fifth",
            name: "fifth",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const tools = createToolRegistry([
      scheduledTool("first", true, events, firstEntered),
      scheduledTool("second", true, events, secondEntered),
      {
        ...scheduledTool("writer", false, events, writerEntered),
        approvalRequirement: {
          kind: "approval",
          action: "command_execution",
        },
      },
      scheduledTool("fourth", true, events, fourthEntered),
      scheduledTool("fifth", true, events, fifthEntered),
    ])
    const runtime = await createRuntime(provider.stream, tools, {
      permissionGate,
      approvalPolicy: "auto_file_tools",
    })
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "schedule" } })
    const pending = await waitForValue(() => permissionGate.list(thread.id)[0])
    await firstEntered.promise
    await secondEntered.promise
    expect(events).not.toContain("start:fourth")
    expect(events).not.toContain("start:fifth")

    permissionGate.resolve({
      sessionId: thread.id,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })
    await writerEntered.promise
    await fourthEntered.promise
    await fifthEntered.promise
    expect(events.indexOf("start:writer")).toBeLessThan(
      events.indexOf("start:fourth"),
    )
    expect(events.indexOf("start:writer")).toBeLessThan(
      events.indexOf("start:fifth"),
    )
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(2)
  })

  it("waits for tool readiness before the execution lock without losing its barrier", async () => {
    const readerEntered = deferred<void>()
    const releaseReader = deferred<void>()
    const readinessEntered = deferred<void>()
    const releaseReadiness = deferred<void>()
    const writerEntered = deferred<void>()
    const laterEntered = deferred<void>()
    const events: string[] = []
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "ready_reader", name: "reader", input: {} },
          { type: "tool_call", id: "ready_writer", name: "writer", input: {} },
          { type: "tool_call", id: "ready_later", name: "later", input: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ])
    const writer = scheduledTool("writer", false, events, writerEntered)
    const tools = createToolRegistry([
      scheduledTool("reader", true, events, readerEntered, releaseReader),
      {
        ...writer,
        async waitUntilReady() {
          events.push("ready:writer")
          readinessEntered.resolve()
          await releaseReadiness.promise
        },
      },
      scheduledTool("later", true, events, laterEntered),
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "schedule" } })
    await readerEntered.promise
    await readinessEntered.promise
    await Promise.resolve()
    expect(events).toEqual(
      expect.arrayContaining(["start:reader", "ready:writer"]),
    )
    expect(events).not.toContain("end:reader")
    expect(events).not.toContain("start:later")
    releaseReadiness.resolve()
    await Promise.resolve()
    expect(events).not.toContain("start:writer")
    releaseReader.resolve()
    await writerEntered.promise
    await laterEntered.promise
    expect(events.indexOf("start:writer")).toBeLessThan(
      events.indexOf("start:later"),
    )
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(2)
  })

  it("interrupts a readiness implementation that ignores its abort signal", async () => {
    const readinessEntered = deferred<void>()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "stuck_ready", name: "stuck", input: {} },
        ],
      },
    ])
    const tools = createToolRegistry([
      {
        ...scheduledTool("stuck", false, [], deferred<void>()),
        async waitUntilReady() {
          readinessEntered.resolve()
          await new Promise<void>(() => undefined)
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "wait" } })
    await readinessEntered.promise
    await thread.interrupt("test")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.interrupted")
  })

  it("closes a force-aborted model Turn session once and starts the next Turn fresh", async () => {
    const streamEntered = deferred<void>()
    const closes: number[] = []
    let sessions = 0
    const modelClient: ModelClient = {
      hasProvider: (provider) => provider === "faux",
      models: () => createStaticModelsManager("faux"),
      startTurn() {
        const index = sessions
        sessions += 1
        closes[index] = 0
        return {
          models: createStaticModelsManager("faux"),
          stream() {
            if (index !== 0) {
              return (async function* () {
                yield responseEvent("fresh Turn")
              })()
            }
            const iterator: AsyncIterableIterator<ModelStreamEvent> = {
              [Symbol.asyncIterator]() {
                return iterator
              },
              async next() {
                streamEntered.resolve()
                await new Promise<void>(() => undefined)
                return { done: true, value: undefined }
              },
              async return() {
                await new Promise<void>(() => undefined)
                return { done: true, value: undefined }
              },
            }
            return iterator
          },
          close() {
            closes[index] = (closes[index] ?? 0) + 1
          },
        }
      },
      close() {},
    }
    const runtime = await createRuntime(
      () => {
        throw new Error("fallback stream must not run")
      },
      createToolRegistry([]),
      { modelClient },
    )
    const thread = await runtime.createThread()

    await thread.startIfIdle({ content: { kind: "text", text: "wait" } })
    await streamEntered.promise
    await thread.interrupt("test")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.interrupted")
    expect(closes).toEqual([1])

    await thread.startIfIdle({ content: { kind: "text", text: "again" } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(sessions).toBe(2)
    expect(closes).toEqual([1, 1])
  })

  it("consumes steering in the active task and aborts the underlying stream", async () => {
    const firstCallEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let calls = 0
    const stream: StreamFn = async function* (request) {
      calls += 1
      if (calls === 1) {
        firstCallEntered.resolve()
        await releaseFirst.promise
        yield responseEvent("first")
        return
      }
      expect(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (block) =>
                block.type === "text" && block.text === "steer while running",
            ),
        ),
      ).toBe(true)
      yield responseEvent("after steering")
    }
    const runtime = await createRuntime(stream)
    const thread = await runtime.createThread()
    const started = await thread.startIfIdle({
      content: { kind: "text", text: "start" },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await firstCallEntered.promise
    await expect(
      thread.steer(
        { content: { kind: "text", text: "steer while running" } },
        started.turnId,
      ),
    ).resolves.toMatchObject({ type: "steered" })
    releaseFirst.resolve()
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.completed")
    expect(calls).toBe(2)

    const aborting = createFauxProvider([{ waitForAbort: true }])
    const abortRuntime = await createRuntime(aborting.stream)
    const abortThread = await abortRuntime.createThread()
    await abortThread.startIfIdle({
      content: { kind: "text", text: "wait" },
    })
    await abortThread.interrupt("test")
    expect((await nextLifecycleEvent(abortThread))?.type).toBe("turn.started")
    expect((await nextLifecycleEvent(abortThread))?.type).toBe(
      "turn.interrupted",
    )
    expect(
      (await abortRuntime.store.readThread(abortThread.id))?.rollout.some(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      ),
    ).toBe(true)
  })

  it("does not record steering rejected by its prompt hook", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    const runtime = await createRuntime(
      async function* (request) {
        calls += 1
        if (calls === 1) {
          entered.resolve()
          await release.promise
        } else {
          expect(JSON.stringify(request.messages)).not.toContain(
            "blocked steer",
          )
        }
        yield responseEvent(calls === 1 ? "first" : "done")
      },
      createToolRegistry([]),
      {
        hookRunner: {
          async dispose() {},
          async run(request) {
            return {
              continue:
                request.event !== HookEvent.UserPromptSubmit ||
                request.payload.prompt !== "blocked steer",
              additionalContext: [],
            }
          },
        },
      },
    )
    const thread = await runtime.createThread()
    const started = await thread.startIfIdle({
      content: { kind: "text", text: "start" },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await entered.promise
    await thread.steer(
      { content: { kind: "text", text: "blocked steer" } },
      started.turnId,
    )
    release.resolve()
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(calls).toBe(2)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "user" &&
          item.item.item.content.some(
            (block) => block.type === "text" && block.text === "blocked steer",
          ),
      ),
    ).toBe(false)
  })

  it("applies a steered model to later Turns while the active Turn stays frozen", async () => {
    const firstCallEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let call = 0
    const stream: StreamFn = async function* (request) {
      call += 1
      if (call === 1) {
        expect(request.target.model).toBe("model-a")
        firstCallEntered.resolve()
        await releaseFirst.promise
      } else if (call === 2) {
        expect(request.target.model).toBe("model-a")
      } else {
        expect(request.target.model).toBe("model-b")
      }
      yield responseEvent(`response ${String(call)}`)
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      model: "model-a",
    })
    const thread = await runtime.createThread()
    const started = await thread.startIfIdle({
      content: { kind: "text", text: "start" },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await firstCallEntered.promise
    await expect(
      thread.steer(
        {
          content: { kind: "text", text: "use B later" },
          modelSelection: { provider: "faux", model: "model-b" },
        },
        started.turnId,
      ),
    ).resolves.toMatchObject({ type: "steered" })
    releaseFirst.resolve()
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    await thread.startIfIdle({ content: { kind: "text", text: "next" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(thread.snapshot().configuration?.defaultTarget.model).toBe("model-b")

    await thread.shutdownAndWait()
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Thread did not resume.")
    await resumed.startIfIdle({ content: { kind: "text", text: "resumed" } })
    await nextLifecycleEvent(resumed)
    await nextLifecycleEvent(resumed)
    expect(call).toBe(4)
  })

  it("persists usage on failure and completes dangling tool calls on the next Turn", async () => {
    const toolEntered = deferred<void>()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        usage: { inputTokens: 9, outputTokens: 2 },
        content: [
          {
            type: "tool_call",
            id: "tool_wait",
            name: "wait",
            input: {},
          },
        ],
      },
      {
        assertRequest(request) {
          const callIndex = request.messages.findIndex(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) =>
                  block.type === "tool_call" && block.id === "tool_wait",
              ),
          )
          expect(request.messages[callIndex + 1]).toMatchObject({
            role: "tool",
            toolCallId: "tool_wait",
            isError: true,
          })
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
    const tools = createToolRegistry([
      {
        toolName: plainToolName("wait"),
        description: "Wait until interrupted",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        execute(_value, context) {
          toolEntered.resolve()
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
    const runtime = await createRuntime(provider.stream, tools)
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "wait" } })
    await toolEntered.promise
    await thread.interrupt("stop tool")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    let stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 9, outputTokens: 2 } })

    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "fail" } })
    await nextLifecycleEvent(thread)
    expect((await nextLifecycleEvent(thread))?.type).toBe("session.error")
    stored = await runtime.store.readThread(thread.id)
    expect(
      stored?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "failed",
      )?.item,
    ).toMatchObject({
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
  })

  it.each([
    "raw",
    "wrapped",
    "snapshot",
  ])("persists observed usage when interruption wins before the stream closes (%s)", async (mode) => {
    const terminalYielded = deferred<void>()
    const streamMayClose = deferred<void>()
    const stream: StreamFn = async function* (request) {
      if (mode === "snapshot") {
        request.onUsageSnapshot?.({ inputTokens: 7, outputTokens: 2 })
      } else
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "complete" }],
            usage: { inputTokens: 7, outputTokens: 2 },
          },
        }
      terminalYielded.resolve()
      await streamMayClose.promise
    }
    const runtime = await createRuntime(
      mode !== "raw"
        ? createModelRequestStream(stream, { wireApi: "unknown" })
        : stream,
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await terminalYielded.promise
    await thread.interrupt("after terminal")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(
      (await runtime.store.readThread(thread.id))?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 } })
    streamMayClose.resolve()
  })

  it("stops late stream publications and observes iterator cleanup failures", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const runtimeErrors: TurnProcessorOperationalFailure[] = []
    let nextCalls = 0
    const iterator: AsyncIterableIterator<ModelStreamEvent> = {
      [Symbol.asyncIterator]() {
        return iterator
      },
      async next() {
        nextCalls += 1
        entered.resolve()
        await release.promise
        return {
          done: false as const,
          value: { type: "delta" as const, text: "too late" },
        }
      },
      async return() {
        throw new Error("iterator cleanup failed")
      },
    }
    const stream: StreamFn = () => iterator
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      onOperationalFailure(failure) {
        runtimeErrors.push(failure)
      },
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await entered.promise
    await thread.interrupt("hard stop")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    release.resolve()
    await waitForValue(() => runtimeErrors.length === 2)
    await runtime.manager.closeThread(thread.id)
    const trailingEvents: SessionEvent[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event === undefined) break
      trailingEvents.push(event)
    }
    expect(
      trailingEvents.filter((event) => event.type === "model.stream"),
    ).toEqual([])

    expect(runtimeErrors).toEqual([
      {
        operation: "abort-model-stream",
        cause: expect.objectContaining({ message: "iterator cleanup failed" }),
      },
      {
        operation: "close-model-stream",
        cause: expect.objectContaining({ message: "iterator cleanup failed" }),
      },
    ])
    expect(nextCalls).toBe(1)
  })

  it("compacts actor-owned history at the reported context threshold", async () => {
    const oldText = "old context ".repeat(3_000)
    const compactionStarted = deferred<void>()
    const releaseCompaction = deferred<void>()
    let compactionAgentControl: AgentControl | undefined
    let deliverCompactionMessage: (
      request: Parameters<
        import("../../src/runtime/agent-control.ts").AgentControlAdapter["deliverMessage"]
      >[0],
    ) => Promise<void> = async () => {
      throw new Error("runtime is not ready")
    }
    const provider = createFauxProvider([
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-a")
        },
        content: [{ type: "text", text: "first response" }],
      },
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-b")
        },
        content: [{ type: "text", text: oldText }],
        usage: { activeContextTokens: 40_000 },
      },
      {
        assertRequest(request) {
          expect(request.target.model).toBe("model-b")
        },
        content: [{ type: "text", text: "summary checkpoint" }],
      },
      {
        assertRequest(request) {
          const serialized = JSON.stringify(request.messages)
          expect(request.target.model).toBe("model-b")
          expect(serialized).toContain("<context_compacted>")
          expect(serialized).toContain("<model_switch>")
          expect(serialized).toContain("mailbox before compaction")
          expect(serialized).not.toContain(oldText)
        },
        content: [{ type: "text", text: "after compaction" }],
      },
    ])
    const stream: StreamFn = (request) => {
      const isCompaction = provider.callCount === 2
      const source = provider.stream(request)
      if (!isCompaction) return source
      return (async function* () {
        compactionStarted.resolve()
        await releaseCompaction.promise
        yield* source
      })()
    }
    const runtime = await createRuntime(
      stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 60_000,
        modelAutoCompactTokenLimit: 30_000,
        model: "model-a",
      },
      (threadId) => {
        const control = rootOnlyAgentControl(threadId, (request) =>
          deliverCompactionMessage(request),
        )
        compactionAgentControl = control
        return control
      },
    )
    deliverCompactionMessage = async (request) => {
      const target = runtime.manager.getThread(request.sessionId)
      if (target === undefined) throw new Error("missing target thread")
      await target.deliverAgentMessage(request.messageId, request.text)
    }
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    await thread.startIfIdle({
      content: { kind: "text", text: "second" },
      modelSelection: { provider: "faux", model: "model-b" },
    })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    if (compactionAgentControl === undefined) {
      throw new Error("missing compaction agent control")
    }
    await thread.startIfIdle({ content: { kind: "text", text: "third" } })
    await compactionStarted.promise
    await compactionAgentControl
      .bind(thread.id, {
        provider: "faux",
        model: "model-b",
      })
      .sendMessage({
        target: thread.id,
        message: "mailbox before compaction",
      })
    releaseCompaction.resolve()
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(provider.callCount).toBe(4)
    const stored = await runtime.store.readThread(thread.id)
    const compactedAt =
      stored?.rollout.findIndex((entry) => entry.item.type === "compacted") ??
      -1
    expect(compactedAt).toBeGreaterThan(-1)
    expect(stored?.rollout[compactedAt + 1]?.item).toMatchObject({
      type: "token_count",
    })
    expect(stored?.rollout[compactedAt + 2]?.item).toMatchObject({
      type: "item_completed",
      item: { type: "context_compaction", status: "completed" },
    })
    const afterCompletion = stored?.rollout.slice(compactedAt + 3)
    expect(
      afterCompletion?.find(({ item }) => item.type === "world_state")?.item,
    ).toMatchObject({ type: "world_state", full: true })
  })

  it("applies tool-result visibility limits to compaction sources", async () => {
    const hiddenTail = "hidden tool output ".repeat(2_000)
    const oldText = "old context ".repeat(3_000)
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "tool_large_result",
            name: "large_result",
            input: {},
          },
        ],
      },
      {
        assertRequest(request) {
          const result = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "tool_large_result",
          )
          expect(
            result?.role === "tool" && toolContentText(result.content),
          ).toContain("Output truncated")
          expect(
            result?.role === "tool" && toolContentText(result.content),
          ).not.toContain(hiddenTail)
        },
        content: [{ type: "text", text: oldText }],
        usage: { activeContextTokens: 40_000 },
      },
      {
        assertRequest(request) {
          expect(request.compaction === "local").toBe(true)
          const serialized = JSON.stringify(request.messages)
          expect(serialized).toContain("Output truncated")
          expect(serialized).not.toContain(hiddenTail)
        },
        content: [{ type: "text", text: "summary" }],
      },
      { content: [{ type: "text", text: "after compaction" }] },
    ])
    const tools = createToolRegistry([
      {
        toolName: plainToolName("large_result"),
        description: "Return a large result",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          return {
            ok: true,
            output: {},
            content: `visible first line\n${hiddenTail}`,
          }
        },
      },
    ])
    const runtime = await createRuntime(provider.stream, tools, {
      modelContextWindowTokens: 60_000,
      modelAutoCompactTokenLimit: 30_000,
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleToolResultLines: 1,
      }),
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "second" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(provider.callCount).toBe(4)
  })

  it("lets the provider admit fresh input despite a conservative local estimate", async () => {
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "accepted" }] },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      { modelContextWindowTokens: 100 },
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: { kind: "text", text: "too large for the local estimate" },
    })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    expect(thread.agentStatus).toEqual({ completed: "accepted" })
  })

  it("estimates the complete durable history when the provider omits usage", async () => {
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "large history ".repeat(200) }] },
      {
        assertRequest(request) {
          expect(request.compaction).toBe("local")
        },
        content: [{ type: "text", text: "checkpoint" }],
      },
      { content: [{ type: "text", text: "continued" }] },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 100,
      },
    )
    const thread = await runtime.createThread()

    for (const text of ["first", "second"]) {
      await thread.startIfIdle({ content: { kind: "text", text } })
      await nextLifecycleEvent(thread)
      await nextLifecycleEvent(thread)
    }

    expect(provider.callCount).toBe(3)
    expect(thread.agentStatus).toEqual({ completed: "continued" })
  })

  it.each([
    "terminal",
    "thrown",
    "code",
  ])("marks %s provider overflow for compaction on the next Turn", async (failure) => {
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "older context ".repeat(2000) }],
        usage: { activeContextTokens: 1000 },
      },
      failure !== "thrown"
        ? {
            failure: {
              kind: "invalid_request",
              stage: "model_event",
              provider: "test",
              wireApi: "unknown",
              providerCode: "context_length_exceeded",
              message:
                failure === "code"
                  ? "Input rejected"
                  : "context length exceeded",
            },
          }
        : { throwBefore: new Error("context length exceeded") },
      {
        assertRequest(request) {
          expect(request.compaction === "local").toBe(true)
        },
        content: [{ type: "text", text: "checkpoint" }],
      },
      {
        content: [{ type: "text", text: "continued" }],
        usage: { activeContextTokens: 100 },
      },
    ])
    const runtime = await createRuntime(
      provider.stream,
      createToolRegistry([]),
      {
        modelContextWindowTokens: 60_000,
        executionPolicy: createSessionExecutionPolicy({}),
      },
    )
    const thread = await runtime.createThread()
    for (const text of ["first", "overflow"]) {
      await thread.startIfIdle({ content: { kind: "text", text } })
      await nextLifecycleEvent(thread)
      await nextLifecycleEvent(thread)
    }
    expect(provider.callCount).toBe(2)
    expect(thread.snapshot().context.activeContextTokens).toBe(60_000)
    expect(thread.agentStatus).toEqual({
      errored:
        failure === "code" ? "Input rejected" : "context length exceeded",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "continued" })
    expect(thread.snapshot().context.activeContextTokens).toBe(100)
  })

  it("shrinks overflowed local compaction by removing the oldest input and retaining later history", async () => {
    let normalCalls = 0
    let compactionCalls = 0
    const operationalFailures: TurnProcessorOperationalFailure[] = []
    const compactionRequests: ModelRequest[] = []
    const stream: StreamFn = async function* (request) {
      const compacting = request.compaction === "local"
      if (compacting) {
        compactionCalls += 1
        compactionRequests.push({
          ...request,
          messages: structuredClone(request.messages),
        })
        if (compactionCalls === 1) {
          throw new Error("provider context length exceeded")
        }
        yield responseEvent("short checkpoint")
        return
      }
      normalCalls += 1
      const text = normalCalls <= 2 ? "a".repeat(15_000) : "b".repeat(35_000)
      yield responseEvent(
        normalCalls === 4 ? "done" : text,
        normalCalls === 3 ? 70_000 : 20_000,
      )
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      modelContextWindowTokens: 100_000,
      modelAutoCompactTokenLimit: 60_000,
      onOperationalFailure(failure) {
        operationalFailures.push(failure)
      },
    })
    const thread = await runtime.createThread()
    for (const text of ["one", "two", "three", "four"]) {
      await thread.startIfIdle({ content: { kind: "text", text } })
      await nextLifecycleEvent(thread)
      await nextLifecycleEvent(thread)
    }

    expect(compactionCalls).toBe(2)
    expect(
      compactionRequests.map((request) =>
        request.messages.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((block) =>
                block.type === "text" ? [block.text] : [],
              )
            : [],
        ),
      ),
    ).toEqual([
      [
        "one",
        expect.stringContaining("<environment>"),
        "two",
        "three",
        expect.stringContaining("Write a concise checkpoint"),
      ],
      [
        expect.stringContaining("<environment>"),
        "two",
        "three",
        expect.stringContaining("Write a concise checkpoint"),
      ],
    ])
    for (const request of compactionRequests) {
      expect(
        request.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((block) =>
                block.type === "text" ? [block.text] : [],
              )
            : [],
        ),
      ).toEqual(["a".repeat(15_000), "a".repeat(15_000), "b".repeat(35_000)])
    }
    expect(compactionRequests[1]?.messages.length).toBeLessThan(
      compactionRequests[0]?.messages.length ?? 0,
    )
    expect(normalCalls).toBe(4)
    expect(operationalFailures).toEqual([])
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.some(
        (entry) => entry.item.type === "compacted",
      ),
    ).toBe(true)
  })

  it("hard-aborts a stalled compaction stream and keeps observed usage", async () => {
    const compactionStalled = deferred<void>()
    const never = deferred<void>()
    let normalCalls = 0
    let returnCalls = 0
    const stream: StreamFn = (request) => {
      const compacting = request.compaction === "local"
      if (!compacting) {
        return (async function* () {
          normalCalls += 1
          yield responseEvent("old".repeat(12_000), 40_000)
        })()
      }
      let nextCalls = 0
      const iterator: AsyncIterableIterator<ModelStreamEvent> = {
        [Symbol.asyncIterator]() {
          return iterator
        },
        async next() {
          nextCalls += 1
          if (nextCalls === 1) {
            return {
              done: false as const,
              value: {
                type: "response" as const,
                response: {
                  stopReason: ModelStopReason.EndTurn,
                  content: [{ type: "text" as const, text: "checkpoint" }],
                  usage: { inputTokens: 6, outputTokens: 1 },
                },
              },
            }
          }
          compactionStalled.resolve()
          await never.promise
          return { done: true as const, value: undefined }
        },
        async return() {
          returnCalls += 1
          return { done: true as const, value: undefined }
        },
      }
      return iterator
    }
    const runtime = await createRuntime(stream, createToolRegistry([]), {
      modelContextWindowTokens: 60_000,
      modelAutoCompactTokenLimit: 30_000,
    })
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "first" } })
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)
    await thread.startIfIdle({ content: { kind: "text", text: "second" } })
    await compactionStalled.promise
    await thread.interrupt("stop compaction")
    await nextLifecycleEvent(thread)
    await nextLifecycleEvent(thread)

    expect(returnCalls).toBeGreaterThanOrEqual(1)
    expect(normalCalls).toBe(1)
    expect(
      (await runtime.store.readThread(thread.id))?.rollout.find(
        (entry) =>
          entry.item.type === "turn_completed" &&
          entry.item.outcome === "interrupted",
      )?.item,
    ).toMatchObject({ usage: { inputTokens: 6, outputTokens: 1 } })
  })
})

it("injects explicit skills once per input and expands steering before the next model request", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const stream: StreamFn = async function* (request) {
    calls++
    const skills = request.messages.filter(
      (message) =>
        message.role === "user" && message.context?.type === "skill_invocation",
    )
    expect(skills).toHaveLength(calls === 1 ? 1 : 2)
    expect(JSON.stringify(skills)).toContain("FIRST BODY")
    if (calls === 1) {
      entered.resolve()
      await release.promise
    } else expect(JSON.stringify(skills)).toContain("SECOND BODY")
    yield responseEvent(calls === 1 ? "first" : "done")
  }
  const runtime = await createRuntime(stream)
  for (const [name, body] of [
    ["first", "FIRST BODY"],
    ["second", "SECOND BODY"],
  ]) {
    const dir = join(runtime.root, ".agents", "skills", name ?? "")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test workflow\n---\n${body}`,
    )
  }
  const thread = await runtime.createThread()
  const started = await thread.startIfIdle({
    content: { kind: "text", text: "$first" },
  })
  if (started.type !== "started") throw new Error("Turn did not start")
  await entered.promise
  await thread.steer(
    { content: { kind: "text", text: "$second" } },
    started.turnId,
  )
  release.resolve()
  await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
  expect(calls).toBe(2)
  const persisted = await runtime.store.readThread(thread.id)
  expect(
    persisted?.rollout.filter(
      ({ item }) =>
        item.type === "response_item" &&
        item.item.item.role === "user" &&
        item.item.item.context?.type === "skill_invocation",
    ),
  ).toHaveLength(2)
})

it.each([
  "none",
  "bytes",
  "lines",
])("persists tool images and bounds %s hook context for the next model step", async (hookKind) => {
  const hookText =
    hookKind === "bytes"
      ? "x".repeat(70_000)
      : hookKind === "lines"
        ? "hook line\n".repeat(3000)
        : undefined
  const assetsRoot = await mkdtemp(join(tmpdir(), "yakitori-media-history-"))
  cleanups.push(() => rm(assetsRoot, { recursive: true, force: true }))
  const assets = createRolloutAssets(assetsRoot, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(assetsRoot, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
    "base64",
  )
  const provider = createFauxProvider([
    {
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "call_image",
          name: "view_image",
          input: { path: "screen.png" },
        },
      ],
    },
    {
      assertRequest(request) {
        const image = request.messages.find(
          (message) =>
            message.role === "tool" && message.toolCallId === "call_image",
        )
        expect(image).toMatchObject({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image",
              data: png.toString("base64"),
            }),
          ]),
        })
      },
      content: [{ type: "text", text: "Image inspected" }],
    },
  ])
  const runtime = await createRuntime(provider.stream, createToolRegistry(), {
    rolloutAssets: assets,
    hookRunner: {
      async dispose() {},
      async run(request) {
        return {
          continue: true,
          additionalContext:
            request.event === HookEvent.PostToolUse && hookText !== undefined
              ? [hookText]
              : [],
        }
      },
    },
  })
  await writeFile(join(runtime.root, "screen.png"), png)
  const thread = await runtime.createThread()
  await thread.startIfIdle({
    content: { kind: "text", text: "inspect screenshot" },
  })
  await nextLifecycleEvent(thread)
  const completed = await nextLifecycleEvent(thread)
  expect(completed?.type).toBe("turn.completed")
  expect(provider.callCount).toBe(2)
  const stored = await runtime.store.readThread(thread.id)
  const record = stored?.rollout.find(
    (record) =>
      record.item.type === "response_item" &&
      record.item.item.item.role === "tool" &&
      record.item.item.item.toolCallId === "call_image",
  )
  if (
    record?.item.type !== "response_item" ||
    record.item.item.item.role !== "tool"
  )
    throw new Error("Missing durable image result")
  const toolResult = record.item.item.item
  expect(
    Buffer.byteLength(toolContentText(toolResult.content)),
  ).toBeLessThanOrEqual(50 * 1024)
  expect(
    toolContentText(toolResult.content).split("\n").length,
  ).toBeLessThanOrEqual(2000)
  expect(toolContentText(toolResult.content)).toContain(
    "Read image: screen.png",
  )
  if (hookText !== undefined) {
    const path = toolContentText(toolResult.content).match(
      /saved to (.+?)\. Use/,
    )?.[1]
    if (path === undefined) throw new Error("Missing hook recovery path")
    expect(await readFile(path, "utf8")).toBe(
      `<hook_context>\n${hookText}\n</hook_context>`,
    )
  }
  const image = toolResult.content.filter(
    (block) => block.type === "image",
  )?.[0]
  if (image?.file === undefined) throw new Error("Missing durable image asset")
  expect(image.data).toBeUndefined()
  const reopened = createRolloutAssets(assetsRoot, {
    withMutationLease: async (_id, mutate) => mutate(),
  })
  expect(await reopened.read(image.file)).toEqual(png)
})

it("reprojects persisted MCP PDFs when switching between image, text, and native-document providers", async () => {
  const assetsRoot = await mkdtemp(join(tmpdir(), "yakitori-pdf-history-"))
  cleanups.push(() => rm(assetsRoot, { recursive: true, force: true }))
  const assets = createRolloutAssets(assetsRoot, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(assetsRoot, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const bytes = pdfFixture(["Retained PDF"])
  const tool: RuntimeTool = {
    toolName: plainToolName("pdf_source"),
    description: "Read the remote PDF",
    inputSchema: { type: "object" },
    effect: "observe",
    approvalRequirement: { kind: "none" },
    execute: (_input, context) =>
      mcpResult(
        {
          content: [
            { type: "text", text: "before PDF" },
            {
              type: "resource",
              resource: {
                uri: "mcp://report",
                mimeType: "application/pdf",
                blob: bytes.toString("base64"),
              },
            },
            { type: "text", text: "after PDF" },
          ],
        },
        context,
      ),
  }
  const provider = createFauxProvider([
    {
      stopReason: ModelStopReason.ToolUse,
      content: [
        { type: "tool_call", id: "call_pdf", name: "pdf_source", input: {} },
      ],
    },
    {
      assertRequest(request) {
        expect(
          request.messages.find((message) => message.role === "tool"),
        ).toMatchObject({
          content: [
            { type: "text", text: "before PDF" },
            { type: "text", text: "[Document attached]" },
            { type: "text", text: expect.stringContaining("Rendered pages 1") },
            {
              type: "image",
              mediaType: "image/jpeg",
              data: expect.any(String),
            },
            { type: "text", text: "after PDF" },
          ],
        })
      },
      content: [{ type: "text", text: "Image inspected" }],
    },
    {
      assertRequest(request) {
        const result = request.messages.find(
          (message) => message.role === "tool",
        )
        expect(result).toMatchObject({
          content: [
            { type: "text", text: "before PDF" },
            { type: "text", text: "[Document attached]" },
            { type: "text", text: expect.stringContaining("Retained PDF") },
            { type: "text", text: "after PDF" },
          ],
        })
      },
      content: [{ type: "text", text: "Text inspected" }],
    },
    {
      assertRequest(request) {
        expect(
          request.messages.find((message) => message.role === "tool"),
        ).toMatchObject({
          content: [
            { type: "text", text: "before PDF" },
            { type: "text", text: "[Document attached]" },
            { type: "document", data: bytes.toString("base64") },
            { type: "text", text: "after PDF" },
          ],
        })
      },
      content: [{ type: "text", text: "Native PDF inspected" }],
    },
  ])
  const selections = [
    {
      provider: "faux",
      model: "scripted",
      inputModalities: ["text", "image"],
      nativePdf: false,
    },
    {
      provider: "future-provider",
      model: "text-only",
      inputModalities: ["text"],
      nativePdf: false,
    },
    {
      provider: "native-pdf-connection",
      model: "native-pdf-test",
      inputModalities: ["text", "image"],
      nativePdf: true,
    },
  ] as const
  const client = createProviderRegistry(
    Object.fromEntries(
      selections.map((selection) => [
        selection.provider,
        createModelProvider({
          info: {
            id: selection.provider,
            wireApi: "faux",
            capabilities: {
              remoteCompaction: false,
              nativePdf: selection.nativePdf,
            },
            retry: { maxAttempts: 1 },
          },
          models: createConfiguredModelsManager({
            provider: selection.provider,
            models: [
              {
                id: selection.model,
                inputModalities: selection.inputModalities,
              },
            ],
          }),
          stream: provider.stream,
        }),
      ]),
    ),
  ).createClient()
  const runtime = await createRuntime(
    provider.stream,
    createToolRegistry([tool]),
    {
      modelClient: client,
      rolloutAssets: assets,
      modelContextWindowTokens: 100_000,
    },
  )
  const thread = await runtime.createThread()
  for (const { provider, model } of selections) {
    await thread.startIfIdle({
      content: { kind: "text", text: "Read the report" },
      modelSelection: { provider, model },
    })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    const completed = await nextLifecycleEvent(thread)
    expect(completed, JSON.stringify(completed)).toMatchObject({
      type: "turn.completed",
    })
  }
  expect(provider.callCount).toBe(4)
  const durable = thread
    .snapshot()
    .context.history.find(
      ({ item }) => item.role === "tool" && item.toolCallId === "call_pdf",
    )?.item
  expect(durable).toMatchObject({
    role: "tool",
    content: [
      { type: "text", text: "before PDF" },
      { type: "text", text: "[Document attached]" },
      { type: "document", file: expect.any(Object) },
      { type: "text", text: "after PDF" },
    ],
  })
  if (durable?.role !== "tool") throw new Error("Missing durable PDF")
  expect(
    durable.content.filter((block) => block.type === "document")?.[0]?.data,
  ).toBeUndefined()
  expect(durable.content.filter((block) => block.type === "image")).toEqual([])
})

it("uses the Turn's native PDF capability for tool reads, retries, history, and compaction", async () => {
  const assetsRoot = await mkdtemp(join(tmpdir(), "yakitori-native-pdf-"))
  cleanups.push(() => rm(assetsRoot, { recursive: true, force: true }))
  const assets = createRolloutAssets(assetsRoot, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(assetsRoot, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const bytes = pdfFixture(
    Array.from({ length: 11 }, (_, page) => `Page ${page + 1}`),
  )
  const provider = "anthropic-work"
  const model = "claude-sonnet-4-6"
  const requests: ModelRequest[] = []
  const stream: StreamFn = async function* (request) {
    requests.push(request)
    if (requests.length === 1) {
      yield {
        type: "output_item",
        itemId: "read_pdf",
        content: [
          {
            type: "tool_call",
            id: "call_pdf",
            name: "read_document",
            input: { path: "report.pdf" },
          },
        ],
      }
      yield {
        type: "failure",
        failure: {
          kind: "stream_disconnected",
          stage: "response_body",
          provider,
          wireApi: "anthropic_messages",
          message: "Disconnected after the completed tool call",
        },
      }
      return
    }
    yield responseEvent(
      request.compaction === "local" ? "PDF checkpoint" : "PDF inspected",
    )
  }
  const client = createProviderRegistry({
    [provider]: createModelProvider({
      info: {
        id: provider,
        wireApi: "anthropic_messages",
        capabilities: { remoteCompaction: false, nativePdf: true },
        retry: { maxAttempts: 2, sleep: async () => {}, random: () => 0 },
      },
      models: createConfiguredModelsManager({
        provider,
        catalogProvider: "anthropic",
        wireApi: "anthropic_messages",
        models: [{ id: model }],
      }),
      stream,
    }),
  }).createClient()
  const runtime = await createRuntime(
    stream,
    createToolRegistry([createReadDocumentTool()]),
    {
      provider,
      model,
      modelClient: client,
      rolloutAssets: assets,
    },
  )
  await writeFile(join(runtime.root, "report.pdf"), bytes)
  const thread = await runtime.createThread()
  for (const text of ["Read the report", "Review the same report"]) {
    await thread.startIfIdle({ content: { kind: "text", text } })
    expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
    expect(await nextLifecycleEvent(thread)).toMatchObject({
      type: "turn.completed",
    })
  }
  const result = thread
    .snapshot()
    .context.history.find(
      ({ item }) => item.role === "tool" && item.toolCallId === "call_pdf",
    )?.item
  expect(result).toMatchObject({
    content: expect.arrayContaining([
      expect.objectContaining({ file: expect.any(Object) }),
    ]),
  })
  if (result?.role !== "tool") throw new Error("Missing retained PDF")
  expect(
    result.content.filter((block) => block.type === "document")?.[0]?.data,
  ).toBeUndefined()
  await thread.compact("compact-pdf")
  expect((await nextLifecycleEvent(thread))?.type).toBe("turn.started")
  const completed = await nextLifecycleEvent(thread)
  expect(completed, JSON.stringify(completed)).toMatchObject({
    type: "turn.completed",
  })
  expect(requests).toHaveLength(4)
  expect(requests[1]?.attempt?.number).toBe(2)
  expect(requests[3]?.compaction).toBe("local")
  for (const request of requests.slice(1)) {
    expect(request.target.provider).toBe(provider)
    const result = request.messages.find((message) => message.role === "tool")
    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("(11 pages)"),
        }),
        expect.objectContaining({
          type: "document",
          data: bytes.toString("base64"),
        }),
      ]),
    })
    expect(result?.content.filter((block) => block.type === "image")).toEqual(
      [],
    )
  }
  expect(JSON.stringify(thread.snapshot().context.history)).toContain(
    "PDF checkpoint",
  )
})

it("keeps a Turn's model directory and transport together across provider replacement during refresh", async () => {
  const refreshEntered = deferred<void>()
  const releaseRefresh = deferred<void>()
  const assetsRoot = await mkdtemp(join(tmpdir(), "yakitori-provider-refresh-"))
  cleanups.push(() => rm(assetsRoot, { recursive: true, force: true }))
  const assets = createRolloutAssets(assetsRoot, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(assetsRoot, "rollouts", id), { recursive: true })
      return mutate()
    },
  })
  const bytes = pdfFixture(Array.from({ length: 11 }, () => "Retained report"))
  const oldTransport = createFauxProvider([
    {
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "call_pdf",
          name: "read_document",
          input: { path: "report.pdf" },
        },
      ],
    },
    { content: [{ type: "text", text: "old transport" }] },
  ])
  const newTransport = createFauxProvider([
    { content: [{ type: "text", text: "new transport" }] },
  ])
  const oldModels = createConfiguredModelsManager({
    provider: "personal",
    models: [
      {
        id: "pdf-model",
        inputModalities: ["text", "image"],
        contextWindowTokens: 100_000,
      },
    ],
  })
  const registry = createProviderRegistry({
    personal: createModelProvider({
      info: {
        id: "personal",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false, nativePdf: true },
        retry: { maxAttempts: 1 },
      },
      models: {
        ...oldModels,
        async refresh() {
          refreshEntered.resolve()
          await releaseRefresh.promise
        },
      },
      stream: oldTransport.stream,
    }),
  })
  const runtime = await createRuntime(
    oldTransport.stream,
    createToolRegistry([createReadDocumentTool()]),
    {
      provider: "personal",
      model: "pdf-model",
      modelClient: registry.createClient(),
      rolloutAssets: assets,
    },
  )
  await writeFile(join(runtime.root, "report.pdf"), bytes)
  const thread = await runtime.createThread()
  await thread.startIfIdle({
    content: { kind: "text", text: "Read the report" },
  })
  await refreshEntered.promise
  registry.replace({
    personal: createModelProvider({
      info: {
        id: "personal",
        wireApi: "openai_chat_completions",
        capabilities: { remoteCompaction: false, nativePdf: false },
        retry: { maxAttempts: 1 },
      },
      models: createConfiguredModelsManager({
        provider: "personal",
        models: [
          {
            id: "pdf-model",
            inputModalities: ["text"],
            contextWindowTokens: 100_000,
          },
        ],
      }),
      stream: newTransport.stream,
    }),
  })
  releaseRefresh.resolve()
  await expect
    .poll(() => thread.agentStatus)
    .toEqual({ completed: "old transport" })
  expect(oldTransport.callCount).toBe(2)
  expect(newTransport.callCount).toBe(0)
  expect(
    oldTransport.requests[1]?.messages.find(
      (message) => message.role === "tool",
    ),
  ).toMatchObject({
    content: expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("(11 pages)"),
      }),
      expect.objectContaining({ data: bytes.toString("base64") }),
    ]),
  })
  await thread.startIfIdle({ content: { kind: "text", text: "Continue" } })
  await expect
    .poll(() => thread.agentStatus)
    .toEqual({ completed: "new transport" })
  expect(newTransport.callCount).toBe(1)
  const result = newTransport.requests[0]?.messages.find(
    (message) => message.role === "tool",
  )
  expect(result?.content.filter((block) => block.type === "document")).toEqual(
    [],
  )
  expect(result?.content.filter((block) => block.type === "image")).toEqual([])
})

it("closes the captured Turn when its model directory cannot refresh", async () => {
  let closes = 0
  let sampled = false
  const provider = createModelProvider({
    info: {
      id: "faux",
      wireApi: "faux",
      capabilities: { remoteCompaction: false },
    },
    models: {
      ...createStaticModelsManager("faux"),
      async refresh() {
        throw new Error("Model directory refresh failed")
      },
    },
    stream: async function* () {
      sampled = true
      yield responseEvent("unexpected")
    },
  })
  const registry = createProviderRegistry({
    faux: {
      ...provider,
      startTurn(policy) {
        const turn = provider.startTurn(policy)
        return {
          ...turn,
          close() {
            closes += 1
          },
        }
      },
    },
  })
  const runtime = await createRuntime(
    () => {
      throw new Error("Fallback must not run")
    },
    createToolRegistry([]),
    { modelClient: registry.createClient() },
  )
  const thread = await runtime.createThread()
  await thread.startIfIdle({ content: { kind: "text", text: "Start" } })
  await expect
    .poll(() => thread.agentStatus)
    .toEqual({ errored: "Model directory refresh failed" })
  expect(sampled).toBe(false)
  expect(closes).toBe(1)
  await runtime.manager.shutdown()
  expect(closes).toBe(1)
})

it.each([
  false,
  true,
])("warms only during tool execution and accounts preparation without history (cancelled: %s)", async (cancelled) => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const warmed = deferred<void>()
  const events: string[] = []
  let warmups = 0
  const provider = createFauxProvider([
    {
      usage: { inputTokens: 10, outputTokens: 2 },
      stopReason: ModelStopReason.ToolUse,
      content: [
        { type: "tool_call", id: "slow-call", name: "slow", input: {} },
      ],
    },
    {
      usage: { inputTokens: 4, outputTokens: 1 },
      content: [{ type: "text", text: "done" }],
    },
  ])
  const registry = createProviderRegistry({
    faux: createModelProvider({
      info: {
        id: "faux",
        wireApi: "faux",
        capabilities: { remoteCompaction: false },
      },
      createTurnTransport() {
        return {
          stream: provider.stream,
          warmup: async function* (request) {
            warmups += 1
            await entered.promise
            expect(events).toEqual(["start:slow"])
            // Never prepare a dangling in-flight tool call. Existing tool pairs
            // in the immutable prefix must remain complete and ordered.
            expect(JSON.stringify(request.messages)).not.toContain("slow-call")
            const openCalls = new Set<string>()
            for (const message of request.messages) {
              if (message.role === "assistant") {
                for (const block of message.content)
                  if (block.type === "tool_call") openCalls.add(block.id)
              } else if (message.role === "tool") {
                expect(openCalls.delete(message.toolCallId)).toBe(true)
              }
            }
            expect(openCalls.size).toBe(0)
            request.onUsageSnapshot?.({
              inputTokens: 100,
              outputTokens: 0,
              cacheReadInputTokens: 80,
            })
            warmed.resolve()
            if (cancelled) {
              await new Promise<void>((resolve) =>
                request.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              )
              yield { type: "cancelled" }
            } else {
              yield {
                type: "response",
                response: {
                  stopReason: ModelStopReason.EndTurn,
                  content: [],
                  usage: {
                    inputTokens: 100,
                    outputTokens: 0,
                    cacheReadInputTokens: 80,
                  },
                },
              }
            }
          },
          close() {},
        }
      },
    }),
  })
  const runtime = await createRuntime(
    provider.stream,
    createToolRegistry([scheduledTool("slow", true, events, entered, release)]),
    { modelClient: registry.createClient() },
  )
  const thread = await runtime.createThread()
  await thread.startIfIdle({ content: { kind: "text", text: "go" } })
  await warmed.promise
  release.resolve()
  await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
  expect(warmups).toBe(1)
  expect(events).toEqual(["start:slow", "end:slow"])
  expect(
    thread
      .snapshot()
      .context.history.filter(({ item }) => item.role === "assistant"),
  ).toHaveLength(2)
  const stored = await runtime.store.readThread(thread.id)
  expect(
    stored?.rollout.find(({ item }) => item.type === "turn_completed")?.item,
  ).toMatchObject({
    usage: { inputTokens: 114, outputTokens: 3, cacheReadInputTokens: 80 },
  })
})

async function createRuntime(
  stream: StreamFn,
  toolRegistry = createToolRegistry([]),
  options: Omit<Partial<TurnProcessorOptions>, "stream" | "toolRegistry"> = {},
  agentControlFactory?: (threadId: string) => AgentControl,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-live-turn-"))
  const store = new MemoryThreadStore()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: (stored) =>
      createTurnProcessor({
        stream,
        toolRegistry,
        loadProjectInstructions: async () => undefined,
        ...options,
        ...(agentControlFactory === undefined
          ? {}
          : { agentControl: agentControlFactory(stored.metadata.id) }),
      }),
  })
  cleanups.push(async () => {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    manager,
    root,
    store,
    createThread: () =>
      manager.createThread({
        workingDirectory: root,
        mateId: "mate_live",
        mateRevisionId: "mate_revision_live",
      }),
  }
}

async function nextLifecycleEvent(thread: {
  nextEvent(): Promise<SessionEvent | undefined>
}): Promise<SessionEvent | undefined> {
  for (;;) {
    const event = await thread.nextEvent()
    if (
      event === undefined ||
      (event.type !== "rollout.appended" &&
        event.type !== "model.stream" &&
        event.type !== "item.started" &&
        event.type !== "permission" &&
        event.type !== "runtime.warning")
    ) {
      return event
    }
  }
}

function responseEvent(
  text: string,
  activeContextTokens?: number,
): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: ModelStopReason.EndTurn,
      content: [{ type: "text", text }],
      ...(activeContextTokens === undefined
        ? {}
        : { usage: { activeContextTokens } }),
    },
  }
}

function rootOnlyAgentControl(
  rootSessionId: string,
  deliverMessage: import("../../src/runtime/agent-control.ts").AgentControlAdapter["deliverMessage"] = async () => {},
  rolloutBudget?: RolloutBudgetConfig,
): AgentControl {
  return createAgentControl({
    rootSessionId,
    ...(rolloutBudget === undefined ? {} : { rolloutBudget }),
    adapter: {
      async createChild() {
        throw new Error("unused")
      },
      async runChild() {
        throw new Error("unused")
      },
      async ensureLoaded() {},
      async getStatus() {
        return "running"
      },
      async failChild(_sessionId, message) {
        return { errored: message }
      },
      async completionDeliveryId(sessionId) {
        return `agent_completion_${sessionId}`
      },
      async interruptChild() {},
      deliverMessage,
      async rollbackChild() {},
      captureForkContext() {
        return undefined
      },
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function scheduledTool(
  name: string,
  supportsParallelToolCalls: boolean,
  events: string[],
  entered: ReturnType<typeof deferred<void>>,
  release?: ReturnType<typeof deferred<void>>,
): RuntimeTool {
  return {
    toolName: plainToolName(name),
    description: `${name} scheduling probe`,
    inputSchema: { type: "object" },
    effect: supportsParallelToolCalls ? "observe" : "mutate",
    supportsParallelToolCalls,
    approvalRequirement: { kind: "none" },
    async execute() {
      events.push(`start:${name}`)
      entered.resolve()
      await release?.promise
      events.push(`end:${name}`)
      return { ok: true, output: name, content: name }
    },
  }
}

function identifiedDeferredTool(content: string): RuntimeTool {
  return {
    toolName: { namespace: "calendar", name: "search_events" },
    exposure: "deferred",
    description: content,
    inputSchema: { type: "object" },
    effect: "observe",
    approvalRequirement: { kind: "none" },
    async execute() {
      return { ok: true, output: { content }, content }
    },
  }
}
