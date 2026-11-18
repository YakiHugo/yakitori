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
  SessionActivityResponse,
  SessionHistoryResponse,
  SessionSubscribeResponse,
} from "../../src/protocol/rpc-methods.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { mapRolloutEvent } from "../../src/server/session-event-projection.ts"
import {
  createTestProcessor,
  deferred,
  flush,
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

async function setup(options: { cold?: boolean; activity?: boolean } = {}) {
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
      filter: (path) => !basename(path).startsWith("thread-search.sqlite"),
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
  it("keeps recent prompts and answers together while completed activity pages separately", async () => {
    const { connection } = await setup({ activity: true })
    const response = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: "transcript",
    })
    if (!("result" in response))
      throw new Error("Expected subscription result.")
    const result = response.result as SessionSubscribeResponse
    const { session, historyBefore } = result
    expect(result).toMatchObject({
      activityTurnIds: ["request_latest"],
    })
    expect(
      result.events?.flatMap((event) =>
        event.type === "input.admitted" ? [event.data.inputId] : [],
      ),
    ).toEqual([
      "input_third",
      "input_fourth",
      "input_old",
      "input_middle",
      "input_latest",
    ])
    expect(
      result.events?.flatMap((event) =>
        event.type === "item.completed" ? [event.data.item.itemId] : [],
      ),
    ).toEqual([
      "answer_third",
      "answer_fourth",
      "answer_old",
      "answer_middle",
      "answer_begin",
      "answer_latest",
    ])
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        data: expect.objectContaining({
          turnId: "request_latest",
          outcome: {
            status: "completed",
            answerItemIds: ["answer_begin", "answer_latest"],
          },
        }),
      }),
    )
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(16 * 1024)
    if (historyBefore === undefined)
      throw new Error("Expected older transcript.")

    const older = await connection.sendRequest("session/history", {
      sessionId,
      before: historyBefore,
      transcript: true,
    })
    if (!("result" in older)) throw new Error("Expected history result.")
    const olderPage = older.result as SessionHistoryResponse
    expect(
      olderPage.events.flatMap((event) =>
        event.type === "input.admitted" ? [event.data.inputId] : [],
      ),
    ).toEqual(["input_first", "input_second"])
    expect(olderPage.historyBefore).toBeUndefined()

    const params = {
      sessionId,
      rolloutId: session.rolloutId,
      turnId: "request_latest",
    }
    const activity = await connection.sendRequest(
      "session/activity/read",
      params,
    )
    if (!("result" in activity)) throw new Error("Expected activity result.")
    const activityPage = activity.result as SessionActivityResponse
    const nextBefore = activityPage.nextBefore
    if (nextBefore === undefined) throw new Error("Expected older activity.")
    const earlier = await connection.sendRequest("session/activity/read", {
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
      await connection.sendRequest("session/activity/read", {
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

  it("embeds the latest display window without replaying its events as notifications", async () => {
    const { connection } = await setup()
    const response = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: true,
    })
    expect(response).toMatchObject({
      result: {
        session: { id: sessionId, seq: 16 },
        historyBefore: 11,
        events: [
          {
            seq: 12,
            type: "input.admitted",
            data: { inputId: "input_latest" },
          },
          { seq: 13, type: "turn.started" },
          { seq: 14, type: "item.completed" },
          { seq: 15, type: "turn.completed" },
        ],
      },
    })
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
    expect(connection.notifications("session/event")).toEqual([])
    expect(
      connection
        .notifications("session/replayComplete")
        .map((frame) => frame.params),
    ).toEqual([{ sessionId, seq: 16 }])
  })

  it("catches up a cached view across prompts outside the latest display window", async () => {
    const { connection } = await setup()
    const response = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 5,
      recent: true,
    })
    expect(response).toMatchObject({
      result: { session: { id: sessionId, seq: 16 } },
    })
    if (!("result" in response))
      throw new Error("Expected subscription result.")
    expect(response.result).not.toHaveProperty("historyBefore")
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
    expect(
      connection.notifications("session/event").map((frame) => frame.params),
    ).toEqual([
      {
        sessionId,
        seq: 7,
        event: expect.objectContaining({
          type: "input.admitted",
          data: expect.objectContaining({ inputId: "input_middle" }),
        }),
      },
      {
        sessionId,
        seq: 8,
        event: expect.objectContaining({ type: "turn.started" }),
      },
      {
        sessionId,
        seq: 9,
        event: expect.objectContaining({ type: "item.completed" }),
      },
      {
        sessionId,
        seq: 10,
        event: expect.objectContaining({ type: "turn.completed" }),
      },
      {
        sessionId,
        seq: 12,
        event: expect.objectContaining({
          type: "input.admitted",
          data: expect.objectContaining({ inputId: "input_latest" }),
        }),
      },
      {
        sessionId,
        seq: 13,
        event: expect.objectContaining({ type: "turn.started" }),
      },
      {
        sessionId,
        seq: 14,
        event: expect.objectContaining({ type: "item.completed" }),
      },
      {
        sessionId,
        seq: 15,
        event: expect.objectContaining({ type: "turn.completed" }),
      },
    ])
    expect(connection.notifications("session/subscriptionError")).toEqual([])
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
    const window = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: true,
    })
    expect(window).toMatchObject({
      result: {
        historyBefore: 11,
        events: [
          { seq: 12, type: "input.admitted" },
          { seq: 13, type: "turn.started" },
          { seq: 14, type: "item.completed" },
          { seq: 15, type: "turn.completed" },
        ],
      },
    })
  })

  it("delivers a commit made after the snapshot exactly once after the replay watermark", async () => {
    const { store, handlers, eventHub, connection } = await setup()
    const captured = deferred<void>()
    const release = deferred<void>()
    const readWindow = handlers.readDisplayWindow.bind(handlers)
    vi.spyOn(handlers, "readDisplayWindow").mockImplementation(
      async (input) => {
        const result = await readWindow(input)
        captured.resolve()
        await release.promise
        return result
      },
    )
    const subscribing = connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: "transcript",
    })
    await captured.promise
    const appended = await store.appendItems(sessionId, [
      {
        type: "turn_started",
        turnId: "request_live",
        inputItemId: "input_live",
      },
    ])
    await store.flushThread(sessionId)
    eventHub.publishDurable(
      appended.records.map((record) => mapRolloutEvent(record, sessionId)),
    )
    release.resolve()
    const response = await subscribing
    expect(response).toMatchObject({ result: { session: { seq: 16 } } })
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/event" &&
        (frame.params as { seq: number }).seq === 17,
    )
    await flush()
    const notifications = connection.frames.filter((frame) => "method" in frame)
    expect(notifications).toEqual([
      {
        method: "session/replayComplete",
        params: { sessionId, seq: 16 },
      },
      {
        method: "session/event",
        params: {
          sessionId,
          seq: 17,
          event: expect.objectContaining({
            seq: 17,
            type: "turn.started",
            data: { turnId: "request_live", inputId: "input_live" },
          }),
        },
      },
    ])
  })

  it("paints a missing-index window and enables live delivery before supplementing authoritative state", async () => {
    const { handlers, eventHub, connection } = await setup({ cold: true })
    const entered = deferred<void>()
    const release = deferred<void>()
    const readStatus = handlers.readInputStatus.bind(handlers)
    const barrierRead = vi
      .spyOn(handlers, "readInputStatus")
      .mockImplementation(async (input) => {
        entered.resolve()
        await release.promise
        return readStatus(input)
      })
    cleanups.push(async () => release.resolve())
    const response = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: true,
    })
    expect(response).toMatchObject({
      result: {
        statePending: true,
        session: { id: sessionId, seq: 17 },
        historyBefore: 11,
        events: [
          { seq: 12, type: "input.admitted" },
          { seq: 13, type: "turn.started" },
          { seq: 14, type: "item.completed" },
          { seq: 15, type: "turn.completed" },
          { seq: 17, type: "context.tokens" },
        ],
      },
    })
    await entered.promise
    expect(barrierRead).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      requestIds: [],
    })
    expect(
      connection
        .notifications("session/replayComplete")
        .map((frame) => frame.params),
    ).toEqual([{ sessionId, seq: 17 }])
    expect(connection.notifications("session/snapshot")).toEqual([])
    eventHub.publishDurable([
      createEventEnvelope({
        sessionId,
        seq: 18,
        event: { type: "turn.started", data: { turnId: "request_live" } },
      }),
    ])
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/event",
    )
    expect(connection.notifications("session/snapshot")).toEqual([])
    release.resolve()
    const supplemented = await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/snapshot",
    )
    expect(supplemented).toEqual({
      method: "session/snapshot",
      params: {
        sessionId,
        snapshot: {
          session: expect.objectContaining({ id: sessionId, seq: 17 }),
          events: [
            expect.objectContaining({
              type: "context.tokens",
              seq: 17,
              data: { turnId: "request_latest", activeContextTokens: 73 },
            }),
          ],
        },
      },
    })
    expect(
      connection.frames
        .filter((frame) => "method" in frame)
        .map((frame) => frame.method),
    ).toEqual(["session/replayComplete", "session/event", "session/snapshot"])
  })

  it.each([
    "unsubscribe",
    "reset",
    "replace",
  ] as const)("suppresses the pending cold-state supplement after %s", async (action) => {
    const { handlers, eventHub, connection } = await setup({ cold: true })
    const entered = deferred<void>()
    const release = deferred<void>()
    const completed = deferred<void>()
    const readStatus = handlers.readInputStatus.bind(handlers)
    vi.spyOn(handlers, "readInputStatus").mockImplementation(async (input) => {
      entered.resolve()
      await release.promise
      try {
        return await readStatus(input)
      } finally {
        completed.resolve()
      }
    })
    cleanups.push(async () => release.resolve())
    const initial = await connection.sendRequest("session/subscribe", {
      sessionId,
      after: 0,
      recent: true,
    })
    expect(initial).toMatchObject({ result: { statePending: true } })
    await entered.promise
    if (action === "unsubscribe") {
      expect(
        await connection.sendRequest("session/unsubscribe", { sessionId }),
      ).toMatchObject({ result: {} })
    } else if (action === "reset") {
      eventHub.resetSession(sessionId)
    } else {
      // The indexed replacement is authoritative while the older independent
      // state read remains blocked.
      await readStatus({ sessionId, requestIds: [] })
      const replacement = await connection.sendRequest("session/subscribe", {
        sessionId,
        after: 0,
        recent: true,
      })
      expect(replacement).toMatchObject({
        result: { session: { id: sessionId, seq: 17 } },
      })
      if (!("result" in replacement))
        throw new Error("Expected replacement subscription.")
      expect(replacement.result).not.toHaveProperty("statePending")
    }
    release.resolve()
    await completed.promise
    await flush()
    expect(connection.notifications("session/snapshot")).toEqual([])
    eventHub.publishDurable([
      createEventEnvelope({
        sessionId,
        seq: 18,
        event: { type: "turn.started", data: { turnId: "request_live" } },
      }),
    ])
    await flush()
    expect(connection.notifications("session/event")).toHaveLength(
      action === "replace" ? 1 : 0,
    )
  })
})
