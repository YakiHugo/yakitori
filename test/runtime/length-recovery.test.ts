import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type ModelStreamEvent,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import {
  createTurnProcessor,
  type TurnProcessorOptions,
} from "../../src/runtime/turn-processor.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const workspace = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => workspace.path,
}))
const managers: ThreadManager[] = []
beforeEach(async () => {
  workspace.path = await mkdtemp(join(tmpdir(), "yakitori-length-recovery-"))
})
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await rm(workspace.path, { recursive: true, force: true })
})

describe("bounded length recovery", () => {
  it("retries a truncated local checkpoint against unchanged input and installs only the complete summary", async () => {
    let samples = 0
    const compactionInputs: Pick<ModelRequest, "messages" | "system">[] = []
    const runtime = await createRetryingCompactionRuntime(
      async function* (request) {
        if (request.compaction === "local") {
          compactionInputs.push({
            messages: structuredClone(request.messages),
            system: structuredClone(request.system),
          })
          yield {
            type: "response",
            response: {
              stopReason:
                compactionInputs.length === 1
                  ? ModelStopReason.Length
                  : ModelStopReason.EndTurn,
              content: [
                {
                  type: "text",
                  text:
                    compactionInputs.length === 1
                      ? "An unusable partial checkpoint"
                      : "The complete task checkpoint.",
                },
              ],
              usage: {
                inputTokens: 20,
                outputTokens: compactionInputs.length === 1 ? 5 : 7,
              },
            },
          }
          return
        }
        samples += 1
        if (samples === 2) {
          expect(JSON.stringify(request.messages)).toContain(
            "The complete task checkpoint.",
          )
          expect(JSON.stringify(request.messages)).not.toContain(
            "An unusable partial checkpoint",
          )
        }
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [
              {
                type: "text",
                text: samples === 1 ? "Old assistant state" : "Finished.",
              },
            ],
            usage:
              samples === 1
                ? {
                    inputTokens: 100,
                    outputTokens: 10,
                    activeContextTokens: 59_000,
                  }
                : {
                    inputTokens: 30,
                    outputTokens: 4,
                    activeContextTokens: 100,
                  },
          },
        }
      },
    )
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Original request." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({
        completed: "Old assistant state",
      })
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Continue." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({
        completed: "Finished.",
      })
    expect(compactionInputs).toHaveLength(2)
    expect(compactionInputs[1]).toEqual(compactionInputs[0])
    expect(JSON.stringify(compactionInputs)).not.toContain(
      "An unusable partial checkpoint",
    )
    expect(JSON.stringify(compactionInputs)).not.toContain(
      "Your previous answer was cut off",
    )
    const stored = await runtime.store.readThread(runtime.thread.id)
    const checkpoints = stored?.rollout.filter(
      ({ item }) => item.type === "compacted",
    )
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints?.[0]?.item).toMatchObject({
      type: "compacted",
      summary: "The complete task checkpoint.",
    })
    expect(JSON.stringify(checkpoints)).not.toContain(
      "An unusable partial checkpoint",
    )
    expect(stored?.rollout.at(-1)?.item).toMatchObject({
      type: "turn_completed",
      outcome: "completed",
      usage: { inputTokens: 70, outputTokens: 16 },
    })
  })

  it("keeps live history and accounts for every exhausted local checkpoint attempt", async () => {
    let samples = 0
    const compactionInputs: ModelRequest["messages"][] = []
    const runtime = await createRetryingCompactionRuntime(
      async function* (request) {
        if (request.compaction === "local") {
          compactionInputs.push(structuredClone(request.messages))
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.Length,
              content: [{ type: "text", text: "Unusable partial checkpoint" }],
              usage: { inputTokens: 20, outputTokens: 5 },
            },
          }
          return
        }
        samples += 1
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "Old assistant state" }],
            usage: { activeContextTokens: 59_000 },
          },
        }
      },
    )
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Original request." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({
        completed: "Old assistant state",
      })
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Continue." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toHaveProperty("errored")
    expect(samples).toBe(1)
    expect(compactionInputs).toHaveLength(3)
    expect(compactionInputs[1]).toEqual(compactionInputs[0])
    expect(compactionInputs[2]).toEqual(compactionInputs[0])
    const history = JSON.stringify(runtime.thread.snapshot().context.history)
    expect(history).toContain("Old assistant state")
    expect(history).not.toContain("Unusable partial checkpoint")
    const stored = await runtime.store.readThread(runtime.thread.id)
    expect(stored?.rollout.some(({ item }) => item.type === "compacted")).toBe(
      false,
    )
    expect(stored?.rollout).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          type: "item_completed",
          item: expect.objectContaining({
            type: "context_compaction",
            status: "failed",
          }),
        }),
      }),
    )
    expect(stored?.rollout.at(-1)?.item).toMatchObject({
      type: "turn_completed",
      outcome: "failed",
      usage: { inputTokens: 60, outputTokens: 15 },
    })
  })

  it("keeps pre-compaction answer fragments in the completed answer after reload", async () => {
    let samples = 0
    let compactions = 0
    const runtime = await createRuntime(async function* (request) {
      if (request.compaction === "local") {
        compactions += 1
        yield response("A task checkpoint.")
        return
      }
      samples += 1
      if (samples === 1) {
        yield truncated("First ", "context")
      } else {
        expect(JSON.stringify(request.messages)).not.toContain("First ")
        expect(JSON.stringify(request.messages)).toContain("A task checkpoint.")
        yield response("second.")
      }
    })
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({ completed: "First second." })
    expect(compactions).toBe(1)
    expect(samples).toBe(2)
    expect(
      JSON.stringify(runtime.thread.snapshot().context.history),
    ).not.toContain("First ")
    const stored = await runtime.store.readThread(runtime.thread.id)
    expect(stored?.rollout.at(-1)?.item).toMatchObject({
      type: "turn_completed",
      outcome: "completed",
      completion: { answerItemIds: expect.any(Array) },
    })
    await runtime.manager.shutdown()
    const resumedManager = new ThreadManager({
      store: runtime.store,
      createTurnProcessor: () =>
        createTurnProcessor({ stream: runtime.stream }),
    })
    managers.push(resumedManager)
    const resumed = await resumedManager.resumeThread(runtime.thread.id)
    expect(resumed?.agentStatus).toEqual({ completed: "First second." })
  })

  it("finishes with the partial answer when a checkpoint still cannot fit", async () => {
    let samples = 0
    let compactions = 0
    const runtime = await createRuntime(
      async function* (request) {
        if (request.compaction === "local") {
          compactions += 1
          yield response("X".repeat(8_000))
          return
        }
        samples += 1
        yield truncated("Usable partial answer", "context")
      },
      { modelContextWindowTokens: 1_000 },
    )
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({
        completed: "Usable partial answer",
        reason: "truncated",
      })
    expect(samples).toBe(1)
    expect(compactions).toBe(1)
    const rollout =
      (await runtime.store.readThread(runtime.thread.id))?.rollout ?? []
    expect(
      rollout.filter(({ item }) => item.type === "compacted"),
    ).toHaveLength(1)
    expect(rollout.at(-1)?.item).toMatchObject({
      type: "turn_completed",
      outcome: "completed",
      completion: { reason: "truncated" },
    })
  })

  it("admits buffered steering instead of ending when the checkpoint exceeds its limit", async () => {
    const terminalYielded = deferred()
    const closeInitialStream = deferred()
    let samples = 0
    let compactions = 0
    const runtime = await createRuntime(
      async function* (request) {
        if (request.compaction === "local") {
          compactions += 1
          yield response("X".repeat(8_000))
          return
        }
        samples += 1
        if (samples === 1) {
          yield truncated("Previous partial answer", "context")
          terminalYielded.resolve()
          await closeInitialStream.promise
        } else {
          expect(request.messages).toContainEqual({
            role: "user",
            content: [{ type: "text", text: "Answer my new question." }],
          })
          yield response("The new answer.")
        }
      },
      { modelContextWindowTokens: 1_000 },
    )
    const started = await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain." }],
      },
    })
    if (started.type !== "started") throw new Error("Turn did not start.")
    await terminalYielded.promise
    try {
      await expect(
        runtime.thread.steer(
          {
            content: {
              kind: "parts" as const,
              parts: [
                { type: "text" as const, text: "Answer my new question." },
              ],
            },
          },
          started.turnId,
        ),
      ).resolves.toMatchObject({ type: "steered" })
    } finally {
      closeInitialStream.resolve()
    }
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({ completed: "The new answer." })
    expect(samples).toBe(2)
    expect(compactions).toBe(1)
    const stored = await runtime.store.readThread(runtime.thread.id)
    expect(
      stored?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "user" &&
          item.item.item.content.some(
            (block) =>
              block.type === "text" && block.text === "Answer my new question.",
          ),
      ),
    ).toBe(true)
  })

  it("does not replenish continuation budget across compaction and tool rounds", async () => {
    let samples = 0
    let compactions = 0
    let effects = 0
    const toolRegistry = createToolRegistry([
      {
        toolName: plainToolName("lookup"),
        description: "Read current status",
        inputSchema: { type: "object" },
        effect: "observe",
        approvalRequirement: { kind: "none" },
        async execute() {
          effects += 1
          return {
            ok: true,
            output: "Current status",
            content: "Current status",
          }
        },
      },
    ])
    const runtime = await createRuntime(
      async function* (request) {
        if (request.compaction === "local") {
          compactions += 1
          yield response("A task checkpoint.")
          return
        }
        samples += 1
        if (samples === 1) yield truncated("Previous ", "context")
        else if (samples === 2)
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.ToolUse,
              content: [
                {
                  type: "tool_call",
                  id: "lookup_1",
                  name: "lookup",
                  input: {},
                },
              ],
            },
          }
        else if (samples === 3) yield truncated("Final ", "context")
        else if (samples === 4) yield truncated("answer")
        else yield response("Unexpected extra continuation.")
      },
      { toolRegistry },
    )
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Read and explain." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({ completed: "Final answer", reason: "truncated" })
    expect(samples).toBe(4)
    expect(compactions).toBe(2)
    expect(effects).toBe(1)
    expect(
      (await runtime.store.readThread(runtime.thread.id))?.rollout.at(-1)?.item,
    ).toMatchObject({
      type: "turn_completed",
      metrics: { modelCalls: 6, toolCalls: 1 },
      completion: { reason: "truncated" },
    })
  })

  it("preserves durable partial text when the user cancels its continuation", async () => {
    const continuationEntered = deferred()
    let samples = 0
    const runtime = await createRuntime(async function* (request) {
      samples += 1
      if (samples === 1) {
        yield truncated("Saved partial text")
      } else if (samples === 2) {
        continuationEntered.resolve()
        if (request.signal === undefined)
          throw new Error("Missing cancellation signal.")
        if (!request.signal.aborted)
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            })
          })
        yield { type: "cancelled" }
      } else {
        expect(request.messages).toContainEqual({
          role: "assistant",
          content: [{ type: "text", text: "Saved partial text" }],
        })
        yield response("Resumed.")
      }
    })
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain." }],
      },
    })
    await continuationEntered.promise
    await runtime.thread.interrupt("Cancel continuation")
    await expect.poll(() => runtime.thread.agentStatus).toBe("interrupted")
    expect(
      (await runtime.store.readThread(runtime.thread.id))?.rollout.at(-1)?.item,
    ).toMatchObject({
      type: "turn_completed",
      outcome: "interrupted",
    })
    expect(JSON.stringify(runtime.thread.snapshot().context.history)).toContain(
      "Saved partial text",
    )
    await runtime.thread.startIfIdle({
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Continue." }],
      },
    })
    await expect
      .poll(() => runtime.thread.agentStatus)
      .toEqual({ completed: "Resumed." })
    expect(samples).toBe(3)
  })
})

async function createRetryingCompactionRuntime(stream: StreamFn) {
  const registry = createProviderRegistry({
    openai: createModelProvider({
      info: {
        id: "openai",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
        retry: { maxAttempts: 3, sleep: async () => {} },
      },
      stream,
    }),
  })
  return createRuntime(stream, {
    provider: "openai",
    model: "gpt-6-astra",
    modelClient: registry.createClient(),
    modelContextWindowTokens: 60_000,
    modelAutoCompactTokenLimit: 50_000,
  })
}

async function createRuntime(
  stream: StreamFn,
  options: Omit<Partial<TurnProcessorOptions>, "stream"> = {},
) {
  const store = new MemoryThreadStore()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        toolRegistry: createToolRegistry([]),
        baseInstructions: "Test instructions.",
        modelContextWindowTokens: 100_000,
        loadProjectInstructions: async () => undefined,
        ...options,
      }),
  })
  managers.push(manager)
  const thread = await manager.createThread({
    workingDirectory: workspace.path,
    mateId: "mate_test",
    mateRevisionId: "mate_revision_test",
  })
  return { manager, store, thread, stream }
}

function response(text: string): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: ModelStopReason.EndTurn,
      content: [{ type: "text", text }],
    },
  }
}

function truncated(text: string, lengthReason?: "context"): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: ModelStopReason.Length,
      content: [{ type: "text", text }],
      ...(lengthReason === undefined ? {} : { lengthReason }),
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
