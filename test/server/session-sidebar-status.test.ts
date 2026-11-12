import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import { SqliteThreadSearchProjection } from "../../src/core/sqlite-thread-search-projection.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createUserQuestionsTool } from "../../src/runtime/tools/user-questions.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"
import {
  createElicitationBroker,
  createSessionInteractions,
} from "../../src/server/user-interactions.ts"
import {
  createTestProcessor,
  initializeConnection,
  openTestConnection,
} from "./rpc/testkit.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000091"
const createdAt = "2026-11-12T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function prompt(turnId: string, questionId?: string): RolloutItem {
  return {
    type: "response_item",
    item: {
      id: `input_${turnId}`,
      turnId,
      createdAt,
      item: { role: "user", content: [{ type: "text", text: "Continue" }] },
      ...(questionId === undefined
        ? {}
        : { submissionMetadata: { metadata: { userQuestionId: questionId } } }),
    },
  }
}

function start(turnId: string): RolloutItem {
  return {
    type: "turn_started",
    turnId,
    inputItemId: `input_${turnId}`,
    source: "human",
    purpose: "message",
  }
}

function question(toolCallId: string): RolloutItem {
  return {
    type: "item_completed",
    turnId: "turn_question",
    item: {
      type: "dynamic_tool_call",
      itemId: `item_${toolCallId}`,
      toolCallId,
      name: "request_user_input_async",
      input: { questions: [{ title: "Where?" }] },
      requiresPermission: false,
      resultItemId: `result_${toolCallId}`,
      content: { kind: "text", text: "Questions presented." },
      output: { kind: "user_questions", questions: [{ title: "Where?" }] },
    },
  }
}

async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-sidebar-status-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function persistedHandlers(items: readonly RolloutItem[]) {
  const root = await rootDirectory()
  const writer = new JsonlThreadStore({ root })
  await writer.createThread({
    id: sessionId,
    conversationId: sessionId,
    createdAt,
    updatedAt: createdAt,
  })
  await writer.persistThread(sessionId, "turn_start")
  await writer.appendItems(sessionId, items)
  await writer.shutdownThread(sessionId)
  const store = new JsonlThreadStore({ root })
  await store.initialize()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => {
      throw new Error("Sidebar reads must not load the runtime.")
    },
  })
  const inputQueue = new InputQueue(":memory:")
  const handlers = createThreadServerHandlers({ manager, store, inputQueue })
  cleanups.push(async () => {
    await handlers.close()
    await manager.shutdown()
    inputQueue.close()
  })
  return { handlers, store }
}

describe("authoritative session sidebar status", () => {
  it("reads narrow status over RPC from the cached projection without loading history", async () => {
    const { handlers, store } = await persistedHandlers([
      start("turn_success"),
      { type: "turn_completed", turnId: "turn_success", outcome: "completed" },
      start("turn_failure"),
      { type: "turn_completed", turnId: "turn_failure", outcome: "failed" },
    ])
    vi.spyOn(store, "readThread").mockRejectedValue(
      new Error("Status reads must not load history."),
    )
    vi.spyOn(store, "readDisplayWindow").mockRejectedValue(
      new Error("Status reads must not load display history."),
    )
    const rebuild = vi.spyOn(SqliteThreadSearchProjection.prototype, "rebuild")
    const { processor } = createTestProcessor({ handlers })
    const connection = openTestConnection(processor)
    try {
      await initializeConnection(connection)
      expect(
        await connection.sendRequest("session/status", { sessionId }),
      ).toMatchObject({
        result: { status: "failed", latestCompletionSeq: 3 },
      })
      const result = await handlers.readSessionStatus({ sessionId })
      expect(result).toEqual({
        ok: true,
        value: { status: "failed", latestCompletionSeq: 3 },
      })
      expect(rebuild).not.toHaveBeenCalled()
    } finally {
      await processor.closeConnection(connection.id)
    }
  })

  it("retains a failed latest turn and prior successful completion after reopening without rebuilding on lists", async () => {
    const { handlers, store } = await persistedHandlers([
      start("turn_success"),
      { type: "turn_completed", turnId: "turn_success", outcome: "completed" },
      start("turn_failure"),
      { type: "turn_completed", turnId: "turn_failure", outcome: "failed" },
    ])
    const rebuild = vi.spyOn(SqliteThreadSearchProjection.prototype, "rebuild")
    for (let iteration = 0; iteration < 2; iteration++) {
      expect(await handlers.listSessions()).toMatchObject({
        ok: true,
        value: {
          sessions: [
            { id: sessionId, status: "failed", latestCompletionSeq: 3 },
          ],
        },
      })
    }
    expect(await store.readThreadSummary(sessionId)).toMatchObject({
      latestTurnOutcome: "failed",
      latestCompletionSeq: 3,
    })
    expect(rebuild).not.toHaveBeenCalled()
    expect(await handlers.readSession({ sessionId })).toMatchObject({
      ok: true,
      value: { session: { status: "failed", latestCompletionSeq: 3 } },
    })
  })

  it("keeps old unanswered questions waiting outside the display page until their correlated answers persist", async () => {
    const { handlers, store } = await persistedHandlers([
      start("turn_question"),
      prompt("turn_question"),
      question("ask_first"),
      question("ask_second"),
      { type: "turn_completed", turnId: "turn_question", outcome: "completed" },
      start("turn_latest"),
      prompt("turn_latest"),
      { type: "turn_completed", turnId: "turn_latest", outcome: "failed" },
    ])
    expect(await handlers.readDisplayWindow({ sessionId })).toMatchObject({
      ok: true,
      value: { session: { status: "waiting", latestCompletionSeq: 6 } },
    })
    await store.resumeThread(sessionId)
    await store.appendItems(sessionId, [prompt("unrelated")])
    await store.appendItems(sessionId, [prompt("answer_one", "ask_first")])
    expect(await handlers.listSessions()).toMatchObject({
      ok: true,
      value: { sessions: [{ status: "waiting", latestCompletionSeq: 6 }] },
    })
    await store.appendItems(sessionId, [prompt("answer_two", "ask_second")])
    expect(await handlers.listSessions()).toMatchObject({
      ok: true,
      value: { sessions: [{ status: "failed", latestCompletionSeq: 6 }] },
    })
    await store.appendItems(sessionId, [
      start("turn_interrupted"),
      {
        type: "turn_completed",
        turnId: "turn_interrupted",
        outcome: "interrupted",
      },
    ])
    expect(await handlers.listSessions()).toMatchObject({
      ok: true,
      value: { sessions: [{ status: "idle", latestCompletionSeq: 6 }] },
    })
    await store.shutdownThread(sessionId)
  })

  it("returns idle without a completion watermark for an empty persisted session", async () => {
    const { handlers } = await persistedHandlers([])
    const result = await handlers.listSessions()
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.sessions[0]).toMatchObject({ status: "idle" })
    expect(result.value.sessions[0]).not.toHaveProperty("latestCompletionSeq")
  })

  it("reports active work, permission waits, unanswered questions and answers through live transitions", async () => {
    const root = await rootDirectory()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const stream: StreamFn = async function* () {
      calls++
      if (calls === 1) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "ask_live",
                name: "request_user_input_async",
                input: { questions: [{ title: "Where?" }] },
              },
            ],
          },
        }
        return
      }
      if (calls === 2) {
        entered.resolve()
        await release.promise
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Done" }],
        },
      }
    }
    const store = new JsonlThreadStore({ root: join(root, "state") })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([createUserQuestionsTool()]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const inputQueue = new InputQueue(":memory:")
    const gate = createPermissionGate()
    const changed = vi.fn()
    const handlers = createThreadServerHandlers({
      manager,
      store,
      inputQueue,
      listPendingPermissions: gate.list,
      notifySidebarChanged: changed,
    })
    cleanups.push(async () => {
      release.resolve()
      await manager.shutdown()
      await handlers.close()
      inputQueue.close()
    })
    const created = await handlers.createSession({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.error.message)
    const liveId = created.value.session.id
    const status = async () => {
      const result = await handlers.readSessionStatus({ sessionId: liveId })
      if (!result.ok) throw new Error(result.error.message)
      return result.value.status
    }
    const admitted = await handlers.admitInput({
      sessionId: liveId,
      requestId: "request_sidebar_status",
      content: createUserInput("Ask me"),
    })
    if (!admitted.ok) throw new Error(admitted.error.message)
    await entered.promise
    expect(await status()).toBe("working")
    const permission = gate.request({
      sessionId: liveId,
      turnId: admitted.value.turnId,
      toolCallId: "permission_tool",
      action: "command_execution",
      timeoutMs: 10_000,
    })
    const pending = gate.list(liveId)[0]
    if (pending === undefined) throw new Error("Missing permission")
    expect(await status()).toBe("waiting")
    gate.resolve({
      sessionId: liveId,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })
    await permission
    expect(await status()).toBe("working")
    changed.mockClear()
    release.resolve()
    await expect.poll(status).toBe("waiting")
    await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0)
    const beforeAnswer = await store.readThreadSummary(liveId)
    expect(beforeAnswer?.latestCompletionSeq).toBeGreaterThan(0)
    const broker = createElicitationBroker()
    const interactions = createSessionInteractions(store, handlers, broker)
    changed.mockClear()
    const answer = await interactions.answer({
      sessionId: liveId,
      toolCallId: "ask_live",
      answers: ["Workspace"],
    })
    if (!answer.ok) throw new Error(answer.error.message)
    await expect.poll(status).toBe("idle")
    await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0)
    const afterAnswer = await store.readThreadSummary(liveId)
    expect(afterAnswer?.latestCompletionSeq).toBeGreaterThan(
      beforeAnswer?.latestCompletionSeq ?? 0,
    )
    broker.close()
  })
})
