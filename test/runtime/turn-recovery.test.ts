import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createReadFileTool } from "../../src/runtime/tools/read-file.ts"
import {
  createToolRegistry,
  plainToolName,
  type RuntimeTool,
} from "../../src/runtime/tools/registry.ts"
import { createWriteFileTool } from "../../src/runtime/tools/write-file.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("Turn recovery", () => {
  it.each([
    "completed",
    "disconnected",
    "failed",
  ] as const)("starts and persists a tool before the response is %s, without duplicating effects on resume", async (terminal) => {
    const entered = deferred()
    const release = deferred()
    let executions = 0
    let requests = 0
    const call = {
      type: "tool_call" as const,
      id: "early",
      name: "once",
      input: {},
    }
    const runtime = await fixture(
      async function* (request) {
        requests += 1
        if (requests === 1) {
          expect(request.streamOutputItems).toBe(true)
          yield { type: "output_item", itemId: "fc_early", content: [call] }
          await release.promise
          if (terminal !== "completed") {
            yield {
              type: "failure",
              failure: {
                kind:
                  terminal === "failed"
                    ? "authentication"
                    : "stream_disconnected",
                provider: "faux",
                wireApi: "unknown",
                stage: "response_body",
                message: "Disconnected",
              },
            }
          } else {
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.ToolUse,
                content: [call],
              },
            }
          }
          return
        }
        const calls = request.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((block) => block.type === "tool_call")
            : [],
        )
        expect(calls).toEqual([call])
        expect(
          request.messages.filter((message) => message.role === "tool"),
        ).toEqual([
          expect.objectContaining({ toolCallId: "early", content: "saved" }),
        ])
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "done" }],
          },
        }
      },
      [
        {
          toolName: plainToolName("once"),
          description: "Execute once",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute() {
            executions += 1
            entered.resolve()
            return { ok: true, content: "saved", output: "saved" }
          },
        },
      ],
    )
    const thread = await runtime.createThread()
    try {
      await thread.startIfIdle({ content: { kind: "text", text: "run" } })
      await expect.poll(() => executions).toBe(1)
      await entered.promise
      expect(requests).toBe(1)
      await expect
        .poll(async () =>
          (await runtime.store.readThread(thread.id))?.rollout.some(
            ({ item }) =>
              item.type === "response_item" &&
              item.item.item.role === "tool" &&
              item.item.item.toolCallId === "early",
          ),
        )
        .toBe(true)
    } finally {
      release.resolve()
    }
    if (terminal === "failed") {
      await expect.poll(() => thread.agentStatus).toHaveProperty("errored")
      expect(requests).toBe(1)
      await runtime.manager.closeThread(thread.id)
      const resumed = await runtime.manager.resumeThread(thread.id)
      if (!resumed) throw new Error("Missing thread")
      await resumed.startIfIdle({ content: { kind: "text", text: "continue" } })
      await expect
        .poll(() => resumed.agentStatus)
        .toEqual({ completed: "done" })
    } else
      await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(executions).toBe(1)
    expect(requests).toBe(2)
  })

  it("keeps results from separate streamed items after cancellation and pairs them in the next request", async () => {
    const waiting = deferred()
    const finished = deferred()
    let requests = 0
    const runtime = await fixture(
      async function* (request) {
        requests += 1
        if (requests === 1) {
          yield {
            type: "output_item",
            itemId: "fc_wait",
            content: [
              { type: "tool_call", id: "wait", name: "wait", input: {} },
            ],
          }
          yield {
            type: "output_item",
            itemId: "fc_read",
            content: [
              { type: "tool_call", id: "read", name: "read", input: {} },
            ],
          }
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            else
              request.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              })
          })
          yield { type: "cancelled" }
          return
        }
        const results = request.messages.filter(
          (message) => message.role === "tool",
        )
        expect(results).toHaveLength(2)
        expect(results).toContainEqual(
          expect.objectContaining({ toolCallId: "wait", isError: true }),
        )
        expect(results).toContainEqual(
          expect.objectContaining({ toolCallId: "read", content: "known" }),
        )
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "resumed" }],
          },
        }
      },
      [
        waitingTool(waiting.resolve),
        {
          toolName: plainToolName("read"),
          description: "Read",
          inputSchema: { type: "object" },
          effect: "observe",
          supportsParallelToolCalls: true,
          approvalRequirement: { kind: "none" },
          async execute() {
            finished.resolve()
            return { ok: true, content: "known", output: "known" }
          },
        },
      ],
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "run" } })
    await waiting.promise
    await finished.promise
    await thread.interrupt("stop")
    await expect.poll(() => thread.agentStatus).toBe("interrupted")
    await runtime.manager.closeThread(thread.id)
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (!resumed) throw new Error("Missing thread")
    await resumed.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "resumed" })
  })

  it.each([
    "retry",
    "same response",
  ] as const)("uses only model-visible reads for file replacement after %s", async (continuation) => {
    let requests = 0
    const read = {
      type: "tool_call" as const,
      id: "read",
      name: "read_file",
      input: { path: "existing.txt" },
    }
    const write = {
      type: "tool_call" as const,
      id: "write",
      name: "write_file",
      input: { path: "existing.txt", content: "updated" },
    }
    const runtime = await fixture(
      async function* (request) {
        requests += 1
        if (requests === 1) {
          yield {
            type: "output_item",
            itemId: "fc_read",
            content: [read],
          }
          if (continuation === "same response") {
            yield {
              type: "output_item",
              itemId: "fc_write",
              content: [write],
            }
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.ToolUse,
                content: [read, write],
              },
            }
            return
          }
          yield {
            type: "failure",
            failure: {
              kind: "stream_disconnected",
              provider: "faux",
              wireApi: "unknown",
              stage: "response_body",
              message: "Disconnected after reading",
            },
          }
          return
        }
        if (requests === 2 && continuation === "retry") {
          expect(request.messages).toContainEqual(
            expect.objectContaining({
              role: "tool",
              toolCallId: "read",
              content: expect.stringContaining("original"),
            }),
          )
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.ToolUse,
              content: [write],
            },
          }
          return
        }
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "done" }],
          },
        }
      },
      [createReadFileTool(), createWriteFileTool()],
    )
    await writeFile(join(runtime.root, "existing.txt"), "original")
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "update file" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(await readFile(join(runtime.root, "existing.txt"), "utf8")).toBe(
      continuation === "retry" ? "updated" : "original",
    )
    expect(requests).toBe(continuation === "retry" ? 3 : 2)
    const results = thread
      .snapshot()
      .context.history.flatMap(({ item }) =>
        item.role === "tool" ? [item] : [],
      )
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ toolCallId: "write" })
    if (continuation === "retry")
      expect(results[1]).not.toHaveProperty("isError", true)
    else
      expect(results[1]).toMatchObject({
        isError: true,
        content: expect.stringContaining("file_not_observed"),
      })
  })

  it("replays completed text and an in-flight tool before the model response ends, then completes the same tool card", async () => {
    const entered = deferred()
    const finishTool = deferred()
    const finishStream = deferred()
    let requests = 0
    const intro = { type: "text" as const, text: "Inspecting the file." }
    const call = {
      type: "tool_call" as const,
      id: "read",
      name: "read",
      input: {},
    }
    const runtime = await fixture(
      async function* () {
        requests += 1
        if (requests === 1) {
          yield { type: "delta", itemId: "intro", text: intro.text }
          yield { type: "output_item", itemId: "intro", content: [intro] }
          yield { type: "output_item", itemId: "call", content: [call] }
          await finishStream.promise
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.ToolUse,
              content: [intro, call],
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                activeContextTokens: 120,
              },
            },
          }
        } else
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "done" }],
            },
          }
      },
      [
        {
          toolName: plainToolName("read"),
          description: "Read",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute() {
            entered.resolve()
            await finishTool.promise
            return { ok: true, content: "found", output: "found" }
          },
        },
      ],
    )
    const thread = await runtime.createThread()
    const handlers = createThreadServerHandlers({
      manager: runtime.manager,
      store: runtime.store,
    })
    const replay = async () => {
      const result = await handlers.readSessionEvents({ sessionId: thread.id })
      if (!result.ok) throw new Error(result.body.error.message)
      let state = createExecutionViewState()
      for (const event of result.body.events)
        state = reduceExecutionView(state, { type: "durable", event })
      return projectExecutionView(state)
    }
    try {
      await thread.startIfIdle({ content: { kind: "text", text: "read" } })
      await entered.promise
      const before = await replay()
      expect(
        before.entries.filter((entry) => entry.kind === "assistant"),
      ).toEqual([
        expect.objectContaining({ text: intro.text, status: "completed" }),
      ])
      const tools = before.entries.filter((entry) => entry.kind === "tool")
      expect(tools).toEqual([
        expect.objectContaining({ toolCallId: "read", state: "requested" }),
      ])
      const itemId = tools[0]?.execution.itemId
      finishTool.resolve()
      await expect
        .poll(
          async () =>
            (await replay()).entries.find((entry) => entry.kind === "tool")
              ?.state,
        )
        .toBe("completed")
      const after = await replay()
      expect(after.entries.filter((entry) => entry.kind === "tool")).toEqual([
        expect.objectContaining({
          execution: expect.objectContaining({ itemId }),
          resultText: "found",
          state: "completed",
        }),
      ])
      expect(requests).toBe(1)
    } finally {
      finishTool.resolve()
      finishStream.resolve()
    }
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    const final = await replay()
    expect(
      final.entries
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.text),
    ).toEqual([intro.text, "done"])
    expect(final.contextTokens?.activeContextTokens).toBe(120)
    expect(thread.snapshot().context.contextTokenHistoryAnchorTokens).toBe(100)
    await runtime.manager.closeThread(thread.id)
    const restored = await runtime.manager.resumeThread(thread.id)
    expect(restored?.snapshot().context.activeContextTokens).toBe(120)
    expect(restored?.snapshot().context.contextTokenHistoryAnchorTokens).toBe(
      100,
    )
  })

  it("persists a completed file change while a later tool is pending and retains it after interruption and reload", async () => {
    const waiting = deferred()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: "write",
            name: "write_file",
            input: { path: "result.txt", content: "saved" },
          },
          { type: "tool_call", id: "wait", name: "wait", input: {} },
        ],
      },
      {
        assertRequest(request) {
          expect(
            request.messages.filter((item) => item.role === "tool"),
          ).toEqual([
            expect.objectContaining({ toolCallId: "write" }),
            expect.objectContaining({ toolCallId: "wait", isError: true }),
          ])
          expect(
            request.messages.find(
              (item) => item.role === "tool" && item.toolCallId === "write",
            ),
          ).not.toHaveProperty("isError", true)
        },
        content: [{ type: "text", text: "continued" }],
      },
    ])
    const runtime = await fixture(provider.stream, [
      createWriteFileTool(),
      waitingTool(waiting.resolve),
    ])
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: { kind: "text", text: "write then wait" },
    })
    await waiting.promise
    expect(await readFile(join(runtime.root, "result.txt"), "utf8")).toBe(
      "saved",
    )
    await expect
      .poll(async () => {
        const stored = await runtime.store.readThread(thread.id)
        return stored?.rollout.some(
          ({ item }) =>
            item.type === "item_completed" && item.item.type === "file_change",
        )
      })
      .toBe(true)
    await thread.interrupt("stop pending tool")
    await runtime.manager.closeThread(thread.id)

    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Missing persisted thread")
    await resumed.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "continued" })
    const stored = await runtime.store.readThread(thread.id)
    const changes = stored?.rollout.filter(
      ({ item }) =>
        item.type === "item_completed" && item.item.type === "file_change",
    )
    expect(changes).toHaveLength(1)
    expect(changes?.[0]?.item).toMatchObject({
      item: {
        type: "file_change",
        changes: [{ path: "result.txt", kind: "add" }],
      },
    })
    expect(provider.callCount).toBe(2)
  })

  it("drains successful results after an earlier parallel tool is cancelled", async () => {
    const waiting = deferred()
    const readCompleted = deferred()
    const read = createReadFileTool()
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [
          { type: "tool_call", id: "wait", name: "wait", input: {} },
          {
            type: "tool_call",
            id: "read",
            name: "read_file",
            input: { path: "existing.txt" },
          },
        ],
      },
    ])
    const runtime = await fixture(provider.stream, [
      waitingTool(waiting.resolve),
      {
        ...read,
        async execute(input, context) {
          const result = await read.execute(input, context)
          readCompleted.resolve()
          return result
        },
      },
    ])
    await writeFile(join(runtime.root, "existing.txt"), "known content")
    const thread = await runtime.createThread()
    await thread.startIfIdle({
      content: { kind: "text", text: "read while waiting" },
    })
    await waiting.promise
    await readCompleted.promise
    await thread.interrupt("stop first tool")
    await expect.poll(() => thread.agentStatus).toBe("interrupted")
    const stored = await runtime.store.readThread(thread.id)
    const readResult = stored?.rollout.find(
      ({ item }) =>
        item.type === "response_item" &&
        item.item.item.role === "tool" &&
        item.item.item.toolCallId === "read",
    )?.item
    expect(readResult).toMatchObject({
      type: "response_item",
      item: {
        item: {
          role: "tool",
          toolCallId: "read",
          content: expect.stringContaining("known content"),
        },
      },
    })
    const resultIndex =
      stored?.rollout.findIndex(({ item }) => item === readResult) ?? -1
    const terminalIndex =
      stored?.rollout.findIndex(({ item }) => item.type === "turn_completed") ??
      -1
    expect(resultIndex).toBeGreaterThan(-1)
    expect(terminalIndex).toBeGreaterThan(resultIndex)
  })

  it("retries partial output without committing it, accumulating its byte budget, or repeating completed tools", async () => {
    let executions = 0
    const partial = "x".repeat(100)
    const provider = createFauxProvider([
      {
        stopReason: ModelStopReason.ToolUse,
        content: [{ type: "tool_call", id: "once", name: "once", input: {} }],
      },
      {
        snapshots: [`${partial}\ud83d`],
        reasoningSnapshots: [`${partial}\ud83d`],
        failure: {
          kind: "stream_disconnected",
          provider: "faux",
          wireApi: "unknown",
          stage: "response_body",
          message: "Disconnected",
        },
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      {
        assertRequest(request) {
          expect(JSON.stringify(request.messages)).not.toContain(partial)
          expect(
            request.messages.filter((item) => item.role === "tool"),
          ).toHaveLength(1)
        },
        snapshots: ["y".repeat(110)],
        reasoningSnapshots: ["y".repeat(110)],
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 6, outputTokens: 3 },
      },
    ])
    const runtime = await fixture(
      provider.stream,
      [
        {
          toolName: plainToolName("once"),
          description: "Execute once",
          inputSchema: { type: "object" },
          effect: "observe",
          approvalRequirement: { kind: "none" },
          async execute() {
            executions += 1
            return { ok: true, content: "executed", output: "executed" }
          },
        },
      ],
      111,
    )
    const thread = await runtime.createThread()
    await thread.startIfIdle({ content: { kind: "text", text: "recover" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(executions).toBe(1)
    expect(provider.callCount).toBe(3)
    const stored = await runtime.store.readThread(thread.id)
    expect(JSON.stringify(stored?.rollout)).not.toContain(partial)
    expect(
      stored?.rollout.find(({ item }) => item.type === "turn_completed")?.item,
    ).toMatchObject({ usage: { inputTokens: 11, outputTokens: 5 } })
  })
})

function waitingTool(entered: () => void): RuntimeTool {
  return {
    toolName: plainToolName("wait"),
    description: "Wait until interrupted",
    inputSchema: { type: "object" },
    effect: "observe",
    supportsParallelToolCalls: true,
    approvalRequirement: { kind: "none" },
    execute(_input, context) {
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Stopped", "AbortError")),
          { once: true },
        )
        entered()
      })
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

async function fixture(
  stream: StreamFn,
  tools: RuntimeTool[],
  assistantResponseBytes?: number,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-turn-recovery-"))
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const models = createStaticModelsManager("faux")
  const registry = createProviderRegistry({
    faux: createModelProvider({
      models: {
        ...models,
        resolve(selection) {
          return {
            ...models.resolve(selection),
            fileEditingToolType: "edit_write",
          }
        },
      },
      info: {
        id: "faux",
        wireApi: "unknown",
        capabilities: { remoteCompaction: false },
        retry: { sleep: async () => {}, random: () => 0 },
      },
      stream,
    }),
  })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: registry.createClient(),
        provider: "faux",
        model: "faux",
        toolRegistry: createToolRegistry(tools),
        loadProjectInstructions: async () => undefined,
        executionPolicy: createSessionExecutionPolicy({
          ...(assistantResponseBytes === undefined
            ? {}
            : { assistantResponseBytes }),
        }),
      }),
  })
  cleanups.push(async () => {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    store,
    manager,
    createThread: () =>
      manager.createThread({
        workingDirectory: root,
        mateId: "mate_test",
        mateRevisionId: "revision_test",
      }),
  }
}
