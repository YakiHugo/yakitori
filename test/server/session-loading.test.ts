import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { PersistContext } from "../../src/core/thread-store.ts"
import { createEventEnvelope } from "../../src/kernel/events.ts"
import type {
  LiveSessionSnapshot,
  SessionActivityResponse,
} from "../../src/protocol/rpc-methods.ts"
import type { SessionTurnsResponse } from "../../src/protocol/session-turns.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import {
  createTestProcessor,
  initializeConnection,
  openTestConnection,
} from "./rpc/testkit.ts"

const sessionId = "session_00000000-0000-4000-8000-000000000001"
const createdAt = "2026-11-17T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function setup(
  options: { cold?: boolean; activity?: boolean; steering?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-session-loading-"))
  let store = new JsonlThreadStore({ root: join(root, "store") })
  await store.createThread({
    id: sessionId,
    conversationId: "conversation_loading",
    workingDirectory: root,
    createdAt,
    updatedAt: createdAt,
  })
  // Public event sequences include the initial session metadata record:
  // old=2..6, middle=7..11, latest=12..16. Each fifth record is hidden.
  const names = options.activity
    ? ["first", "second", "third", "fourth", "old", "middle", "latest"]
    : ["old", "middle", "latest"]
  const items: RolloutItem[] = names.flatMap((name) => [
    {
      type: "response_item" as const,
      item: {
        id: `input_${name}`,
        turnId: `request_${name}`,
        createdAt,
        item: {
          role: "user" as const,
          content: [{ type: "text" as const, text: `Prompt ${name}` }],
        },
      },
    },
    {
      type: "turn_started" as const,
      turnId: `request_${name}`,
      inputItemId: `input_${name}`,
    },
    {
      type: "item_completed" as const,
      turnId: `request_${name}`,
      item: {
        type: "agent_message" as const,
        itemId: `answer_${name}`,
        content: [{ type: "text" as const, text: `Answer ${name}` }],
      },
    },
    {
      type: "turn_completed" as const,
      turnId: `request_${name}`,
      outcome: "completed" as const,
    },
    {
      type: "model_context" as const,
      settings: { provider: "faux", model: "scripted" },
    },
  ])
  if (options.steering) {
    const start = items.findIndex(
      (item) =>
        item.type === "turn_started" && item.turnId === "request_latest",
    )
    items.splice(start + 1, 0, {
      type: "response_item",
      item: {
        id: "message_steered",
        turnId: "request_steered",
        createdAt,
        item: {
          role: "user",
          content: [
            { type: "text", text: "Steering belongs to the running turn" },
          ],
        },
      },
    })
  }
  if (options.activity) {
    const turnId = "request_latest"
    const answerPiece = (id: string, text: string): RolloutItem => ({
      type: "response_item",
      item: {
        id,
        turnId,
        createdAt,
        item: { role: "assistant", content: [{ type: "text", text }] },
      },
    })
    const completed = items.findIndex(
      (record) =>
        record.type === "item_completed" && record.turnId === "request_latest",
    )
    items.splice(
      completed,
      0,
      answerPiece("answer_begin", "First part. "),
      {
        type: "item_completed",
        turnId,
        item: {
          type: "agent_message",
          itemId: "answer_begin",
          content: [{ type: "text", text: "First part. " }],
        },
      },
      ...Array.from(
        { length: 24 },
        (_, index): RolloutItem => ({
          type: "item_completed",
          turnId: "request_latest",
          item: {
            type: "command_execution",
            itemId: `tool_${index}`,
            toolCallId: `call_${index}`,
            name: "exec_command",
            input: { cmd: "fixture" },
            command: "fixture",
            requiresPermission: false,
            resultItemId: `result_${index}`,
            content: { kind: "text", text: "x".repeat(16 * 1024) },
          },
        }),
      ),
      answerPiece("answer_latest", "Answer latest"),
    )
    const end = items.findIndex(
      (record) => record.type === "turn_completed" && record.turnId === turnId,
    )
    items[end] = {
      type: "turn_completed",
      turnId,
      outcome: "completed",
      completion: { answerItemIds: ["answer_begin", "answer_latest"] },
    }
  }
  if (options.cold)
    items.push({
      type: "token_count",
      turnId: "request_latest",
      activeContextTokens: 73,
    })
  await store.appendItems(sessionId, items)
  await store.persistThread(sessionId, PersistContext.TurnStart)
  await store.flushThread(sessionId)
  if (options.cold) {
    await store.shutdownThread(sessionId)
    await cp(join(root, "store"), join(root, "cold-store"), {
      recursive: true,
      filter: (path) => !basename(path).startsWith("thread-history.sqlite"),
    })
    store = new JsonlThreadStore({ root: join(root, "cold-store") })
  } else {
    await store.readInputAdmissions(sessionId, [])
  }
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => {
      throw new Error("Read-only session loading must not start execution.")
    },
  })
  const handlers = createThreadServerHandlers({
    manager,
    store,
    inputQueueDatabasePath: ":memory:",
  })
  cleanups.push(async () => {
    await handlers.close()
    await manager.shutdown()
    if (!options.cold) await store.shutdownThread(sessionId)
    await rm(root, { recursive: true, force: true })
  })
  vi.spyOn(store, "readThread").mockImplementation(async () => {
    throw new Error("Session loading must not reconstruct the full rollout.")
  })
  const { processor, eventHub } = createTestProcessor({ handlers })
  const connection = openTestConnection(processor)
  cleanups.push(async () => {
    await processor.closeConnection(connection.id)
  })
  await initializeConnection(connection)
  return { store, handlers, eventHub, connection }
}

describe("bounded session loading", () => {
  it("starts a live subscription at the captured watermark without completed history", async () => {
    const { connection, eventHub, handlers } = await setup({ cold: true })
    const read = handlers.readLiveSession.bind(handlers)
    vi.spyOn(handlers, "readLiveSession").mockImplementationOnce(
      async (input) => {
        const snapshot = await read(input)
        eventHub.publishDurable([
          createEventEnvelope({
            sessionId,
            seq: 16,
            event: {
              type: "turn.completed",
              data: {
                turnId: "request_latest",
                outcome: { status: "completed" },
              },
            },
          }),
          createEventEnvelope({
            sessionId,
            seq: 18,
            event: {
              type: "turn.started",
              data: { turnId: "request_after_snapshot" },
            },
          }),
        ])
        return snapshot
      },
    )
    const replay = vi.spyOn(handlers, "readSessionEvents")
    const frame = await connection.sendRequest("session/subscribe", {
      sessionId,
    })
    if (!("result" in frame)) throw new Error("Expected live snapshot.")
    const snapshot = frame.result as LiveSessionSnapshot
    expect(snapshot).toMatchObject({ session: { seq: 17 }, watermarkSeq: 17 })
    expect(snapshot).not.toHaveProperty("activeTurn")
    expect(snapshot).not.toHaveProperty("events")
    await connection.waitForFrame(
      (message) => "method" in message && message.method === "session/event",
    )
    expect(
      connection.notifications("session/event").map(({ params }) => params),
    ).toMatchObject([
      { seq: 18, event: { data: { turnId: "request_after_snapshot" } } },
    ])
    expect(replay).not.toHaveBeenCalled()
  })

  it("opens at one cut and keeps a steering request in its owning Turn", async () => {
    const { connection, eventHub, handlers, store } = await setup({
      cold: true,
      steering: true,
    })
    const load = handlers.listCompletedTurns.bind(handlers)
    vi.spyOn(handlers, "listCompletedTurns").mockImplementationOnce(
      async (input) => {
        const result = await load(input)
        eventHub.publishDurable([
          createEventEnvelope({
            sessionId,
            seq: 19,
            event: {
              type: "turn.started",
              data: { turnId: "request_after_history" },
            },
          }),
        ])
        return result
      },
    )
    const open = await connection.sendRequest("session/open", { sessionId })
    expect(open).toMatchObject({
      result: {
        watermarkSeq: 18,
        history: { rolloutId: sessionId, seq: 18, view: "summary" },
      },
    })
    if (!("result" in open)) throw new Error("Expected initial Turn history")
    const snapshot =
      open.result as import("../../src/protocol/rpc-methods.ts").OpenSessionSnapshot
    expect(snapshot.history.turns[0]?.events).toContainEqual(
      expect.objectContaining({
        type: "input.admitted",
        data: expect.objectContaining({
          requestId: "request_steered",
          steered: true,
        }),
      }),
    )
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/event",
    )
    expect(
      connection.notifications("session/event").map(({ params }) => params),
    ).toMatchObject([{ seq: 19, event: { type: "turn.started" } }])
    const status = await connection.sendRequest("session/input/status", {
      sessionId,
      requestIds: ["request_steered"],
    })
    expect(status).toHaveProperty(
      "result.events.0.data.requestId",
      "request_steered",
    )
    expect(
      await store.searchThreadOccurrences({
        threadId: sessionId,
        searchTerm: "Steering belongs",
        limit: 1,
      }),
    ).toMatchObject({
      occurrences: [{ turnId: "request_latest", itemId: "message_steered" }],
    })
  })

  it("lists finished Turns from a cold projection with a rollout-scoped cursor", async () => {
    const { connection } = await setup({ cold: true, activity: true })
    const first = await connection.sendRequest("session/turns/list", {
      sessionId,
      view: "summary",
      limit: 2,
    })
    if (!("result" in first)) throw new Error("Expected Turn list.")
    const summary = first.result as SessionTurnsResponse
    if (summary.view !== "summary") throw new Error("Expected Turn summaries.")
    expect(summary).toMatchObject({
      rolloutId: sessionId,
      contextTokens: { activeContextTokens: 73 },
      nextBefore: 30,
      latestCompletionSeq: 62,
      turns: [
        {
          turnId: "request_latest",
          inputId: "input_latest",
          activityCount: 24,
        },
        { turnId: "request_middle", inputId: "input_middle", activityCount: 0 },
      ],
    })
    const latest = summary.turns[0]
    expect(latest?.events.map(({ type }) => type)).toEqual([
      "input.admitted",
      "turn.started",
      "item.completed",
      "item.completed",
      "turn.completed",
    ])
    expect(latest?.events.at(-1)).toMatchObject({
      data: { outcome: { answerItemIds: ["answer_begin", "answer_latest"] } },
    })
    const beforeNewest = await connection.sendRequest("session/turns/list", {
      sessionId,
      rolloutId: summary.rolloutId,
      view: "summary",
      after: 25,
      through: 30,
      limit: 1,
    })
    expect(beforeNewest).toMatchObject({
      result: {
        seq: 30,
        latestCompletionSeq: 30,
        turns: [{ turnId: "request_middle" }],
        nextBefore: 30,
      },
    })
    expect(beforeNewest).not.toHaveProperty("result.nextAfter")
    expect(beforeNewest).not.toHaveProperty("result.contextTokens")
    const outline = await connection.sendRequest("session/turns/list", {
      sessionId,
      rolloutId: summary.rolloutId,
      view: "outline",
      before: summary.nextBefore,
      limit: 2,
    })
    expect(outline).toMatchObject({
      result: {
        view: "outline",
        turns: [{ turnId: "request_old" }, { turnId: "request_fourth" }],
      },
    })
    if (!("result" in outline)) throw new Error("Expected Turn outline.")
    expect(
      (outline.result as SessionTurnsResponse).turns[0],
    ).not.toHaveProperty("events")
    await expect(
      connection.sendRequest("session/turns/list", {
        sessionId,
        rolloutId: summary.rolloutId,
        view: "outline",
        after: 25,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      result: { turns: [{ turnId: "request_middle" }], nextAfter: 30 },
    })
    await expect(
      connection.sendRequest("session/turns/list", {
        sessionId,
        view: "outline",
        aroundTurnId: "request_middle",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      result: { turns: [{ turnId: "request_middle" }] },
    })
    await expect(
      connection.sendRequest("session/turns/list", {
        sessionId,
        rolloutId: "previous_rollout",
        view: "outline",
        before: summary.nextBefore,
      }),
    ).resolves.toHaveProperty("error")
    await expect(
      connection.sendRequest("session/turns/list", {
        sessionId,
        view: "outline",
        before: 30,
      }),
    ).resolves.toMatchObject({ error: { data: { code: "invalid_input" } } })
  })

  it("resolves a specific tool result by rollout without reading unrelated history", async () => {
    const { connection } = await setup({ activity: true })
    const located = await connection.sendRequest("session/turn/activity", {
      sessionId,
      rolloutId: sessionId,
      turnId: "request_latest",
      aroundItemId: "tool_4",
    })
    expect(located).toMatchObject({
      result: {
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "item.completed",
            data: expect.objectContaining({
              item: expect.objectContaining({ itemId: "tool_4" }),
            }),
          }),
        ]),
      },
    })
    expect(located).toHaveProperty("result.events.length", 1)
  })

  it("pages tool output only on request", async () => {
    const { connection } = await setup({ activity: true })
    const params = {
      sessionId,
      rolloutId: sessionId,
      turnId: "request_latest",
    }
    const activity = await connection.sendRequest(
      "session/turn/activity",
      params,
    )
    if (!("result" in activity)) throw new Error("Expected activity result.")
    const activityPage = activity.result as SessionActivityResponse
    const nextBefore = activityPage.nextBefore
    if (nextBefore === undefined) throw new Error("Expected older activity.")
    const earlier = await connection.sendRequest("session/turn/activity", {
      ...params,
      before: nextBefore,
    })
    if (!("result" in earlier))
      throw new Error("Expected earlier activity result.")
    const earlierPage = earlier.result as SessionActivityResponse
    expect(earlierPage.nextBefore).toBeUndefined()
    expect(
      [...earlierPage.events, ...activityPage.events].flatMap((event) =>
        event.type === "item.completed" ? [event.data.item.itemId] : [],
      ),
    ).toEqual(Array.from({ length: 24 }, (_, index) => `tool_${index}`))
    expect(
      await connection.sendRequest("session/turn/activity", {
        ...params,
        rolloutId: "different_rollout",
      }),
    ).toHaveProperty("error")
  })

  it("reads the queue and skills while full rollout reads are unavailable", async () => {
    const { connection } = await setup()
    expect(
      await connection.sendRequest("session/queue/list", { sessionId }),
    ).toMatchObject({ result: { items: [] } })
    expect(
      await connection.sendRequest("session/skills", { sessionId }),
    ).toMatchObject({ result: { skills: [] } })
  })

  it("pages display events without full-history reads and advances across hidden records", async () => {
    const { handlers } = await setup()
    const first = await handlers.readSessionEvents({
      sessionId,
      after: 0,
      limit: 2,
    })
    expect(first).toMatchObject({
      ok: true,
      value: {
        events: [
          { seq: 1, type: "session.created" },
          { seq: 2, type: "input.admitted" },
        ],
        nextAfter: 2,
      },
    })
    const next = await handlers.readSessionEvents({
      sessionId,
      after: 5,
      through: 11,
      limit: 20,
    })
    expect(next).toMatchObject({
      ok: true,
      value: {
        events: [
          { seq: 7, type: "input.admitted" },
          { seq: 8, type: "turn.started" },
          { seq: 9, type: "item.completed" },
          { seq: 10, type: "turn.completed" },
        ],
      },
    })
    if (!next.ok) throw new Error(next.error.message)
    expect(next.value).not.toHaveProperty("nextAfter")
    const empty = await handlers.readSessionEvents({
      sessionId,
      after: 15,
      through: 16,
      limit: 2,
    })
    expect(empty).toMatchObject({ ok: true, value: { events: [] } })
    if (!empty.ok) throw new Error(empty.error.message)
    expect(empty.value).not.toHaveProperty("nextAfter")
  })

  it("recovers only requested input admissions without expanding the display window", async () => {
    const { connection, store } = await setup()
    vi.spyOn(store, "readThreadEvents").mockImplementation(async () => {
      throw new Error("Input recovery must use the targeted admission read.")
    })
    const response = await connection.sendRequest("session/input/status", {
      sessionId,
      requestIds: ["request_old", "request_missing", "request_old"],
    })
    expect(response).toMatchObject({
      result: {
        seq: 16,
        rolloutId: expect.any(String),
        events: [
          {
            seq: 2,
            type: "input.admitted",
            data: {
              requestId: "request_old",
              inputId: "input_old",
              content: { text: "Prompt old" },
            },
          },
        ],
      },
    })
    const live = await connection.sendRequest("session/subscribe", {
      sessionId,
    })
    expect(live).toMatchObject({ result: { watermarkSeq: 16 } })
    expect(live).not.toHaveProperty("result.activeTurn")
    expect(live).not.toHaveProperty("result.events")
    const page = await connection.sendRequest("session/turns/list", {
      sessionId,
      view: "summary",
      rolloutId: sessionId,
      limit: 1,
      through: 16,
    })
    expect(page).toMatchObject({
      result: {
        seq: 16,
        nextBefore: 15,
        turns: [{ turnId: "request_latest" }],
      },
    })
  })
})
