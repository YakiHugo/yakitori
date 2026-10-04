import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import type { StreamFn } from "../../src/runtime/model.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import {
  createSessionTitleGenerator,
  KIMI_TITLE_MODEL,
} from "../../src/server/session-title.ts"

it("durably accounts title provider usage without creating a user turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-title-usage-"))
  const store = new JsonlThreadStore({ root })
  const sessionId = "session_title_usage"
  try {
    await store.createThread({
      id: sessionId,
      conversationId: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await store.persistThread(sessionId, "turn_start")
    const generator = createSessionTitleGenerator({
      store,
      availableProviders: ["kimi"],
      stream: async function* () {
        yield {
          type: "response",
          response: {
            stopReason: "end_turn",
            content: [{ type: "text", text: '{"title":"Fix login"}' }],
            usage: {
              inputTokens: 41,
              outputTokens: 7,
              cacheReadInputTokens: 13,
            },
          },
        }
      },
    })
    generator.openSession(sessionId)
    await generator.generate({ sessionId, text: "Fix login" })
    expect((await store.sessionPresentation(sessionId)).title).toBe("Fix login")
    await store.shutdownThread(sessionId)
    const reopened = new JsonlThreadStore({ root })
    const summary = await reopened.readUsageSummary()
    expect(summary.totals).toEqual({
      turns: 0,
      inputTokens: 41,
      outputTokens: 7,
      cacheReadInputTokens: 13,
      cacheWriteInputTokens: 0,
    })
    expect(summary.models).toEqual([
      {
        provider: "kimi",
        model: KIMI_TITLE_MODEL,
        turns: 0,
        inputTokens: 41,
        outputTokens: 7,
        cacheReadInputTokens: 13,
        cacheWriteInputTokens: 0,
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(stream: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-title-attempt-"))
  roots.push(root)
  const store = new JsonlThreadStore({ root })
  const sessionId = "session_title_attempt"
  await store.createThread({
    id: sessionId,
    conversationId: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  await store.persistThread(sessionId, "turn_start")
  const generator = createSessionTitleGenerator({
    store,
    stream,
    availableProviders: ["kimi"],
  })
  generator.openSession(sessionId)
  return { root, store, sessionId, generator }
}

it("counts physical retries once and preserves usage when a user rename wins", async () => {
  let attempts = 0
  const f = await fixture(
    createModelRequestStream(
      async function* (request) {
        attempts++
        request.onUsageSnapshot?.({ inputTokens: 20, outputTokens: 0 })
        request.onUsageSnapshot?.({ outputTokens: 3 })
        if (attempts === 1) {
          yield {
            type: "failure",
            failure: {
              kind: "stream_disconnected",
              stage: "response_body",
              provider: "kimi",
              wireApi: "unknown",
              message: "synthetic disconnect",
            },
          }
          return
        }
        await f.store.updateSessionSidebar({
          type: "session",
          sessionId: f.sessionId,
          title: "User name",
        })
        yield {
          type: "response",
          response: {
            stopReason: "end_turn",
            content: [{ type: "text", text: '{"title":"Generated title"}' }],
            usage: { inputTokens: 20, outputTokens: 3 },
          },
        }
      },
      { wireApi: "unknown", maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    ),
  )
  await Promise.all([
    f.generator.generate({ sessionId: f.sessionId, text: "rename this" }),
    f.generator.generate({ sessionId: f.sessionId, text: "rename this" }),
  ])
  expect(attempts).toBe(2)
  expect((await f.store.sessionPresentation(f.sessionId)).title).toBe(
    "User name",
  )
  expect((await f.store.readUsageSummary()).totals).toMatchObject({
    turns: 0,
    inputTokens: 40,
    outputTokens: 6,
  })
  const records = (await f.store.readThread(f.sessionId))?.rollout.filter(
    (r) => r.item.type === "auxiliary_usage",
  )
  expect(records).toHaveLength(2)
  expect(
    new Set(
      records?.map((r) =>
        r.item.type === "auxiliary_usage" ? r.item.requestId : "",
      ),
    ).size,
  ).toBe(2)
  await f.generator.closeSession(f.sessionId)
  await f.store.shutdownThread(f.sessionId)
})

it.each([
  "failure",
  "cancelled",
  "invalid-title",
  "no-usage",
])("records observed %s usage without requiring a valid title", async (kind) => {
  const f = await fixture(async function* () {
    const usage = { inputTokens: 11, outputTokens: 2 }
    if (kind === "failure")
      yield {
        type: "failure",
        usage,
        failure: {
          kind: "provider_error",
          stage: "response_body",
          provider: "kimi",
          wireApi: "unknown",
          message: "synthetic failure",
        },
      }
    else if (kind === "cancelled") yield { type: "cancelled", usage }
    else
      yield {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [{ type: "text", text: "not JSON" }],
          ...(kind === "no-usage" ? {} : { usage }),
        },
      }
  })
  await f.generator.generate({ sessionId: f.sessionId, text: "title request" })
  expect((await f.store.sessionPresentation(f.sessionId)).title).toBeUndefined()
  expect((await f.store.readUsageSummary()).totals).toMatchObject({
    turns: 0,
    inputTokens: kind === "no-usage" ? 0 : 11,
    outputTokens: kind === "no-usage" ? 0 : 2,
  })
  await f.generator.closeSession(f.sessionId)
  await f.store.shutdownThread(f.sessionId)
})

it("aborts and drains observed usage before closing the writer and fences late admission", async () => {
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const f = await fixture(
    createModelRequestStream(
      async function* (request) {
        request.onUsageSnapshot?.({ inputTokens: 29, outputTokens: 4 })
        markStarted()
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        )
        yield { type: "cancelled" }
      },
      { wireApi: "unknown" },
    ),
  )
  const pending = f.generator.generate({
    sessionId: f.sessionId,
    text: "slow title",
  })
  await started
  await f.generator.closeSession(f.sessionId)
  await f.store.shutdownThread(f.sessionId)
  await pending
  await f.generator.generate({ sessionId: f.sessionId, text: "late event" })
  const reopened = new JsonlThreadStore({ root: f.root })
  expect((await reopened.readUsageSummary()).totals).toMatchObject({
    turns: 0,
    inputTokens: 29,
    outputTokens: 4,
  })
  expect(
    (await reopened.sessionPresentation(f.sessionId)).title,
  ).toBeUndefined()
  expect(
    (await reopened.readThread(f.sessionId))?.rollout.filter(
      (r) => r.item.type === "auxiliary_usage",
    ),
  ).toHaveLength(1)
})

it("rebuilds title accounting without double-counting retries of a stored record or retained fork history", async () => {
  const f = await fixture(async function* () {
    yield {
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [],
        usage: { inputTokens: 41, outputTokens: 7 },
      },
    }
  })
  await f.generator.generate({ sessionId: f.sessionId, text: "forked title" })
  const record = (await f.store.readThread(f.sessionId))?.rollout.find(
    (r) => r.item.type === "auxiliary_usage",
  )
  if (record === undefined) throw new Error("Missing title usage")
  await f.store.appendItems(f.sessionId, [record.item])
  // A subsequent real turn sharing the auxiliary request ID must retain its own count.
  if (record.item.type !== "auxiliary_usage")
    throw new Error("Expected title usage")
  await f.store.appendItems(f.sessionId, [
    {
      type: "turn_completed",
      turnId: record.item.requestId,
      outcome: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  ])
  const prepared = await f.store.prepareFork({
    sourceThreadId: f.sessionId,
    boundary: { type: "latest" },
  })
  await f.store.createFork({
    prepared,
    target: {
      id: "session_title_child",
      conversationId: "session_title_child",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentThreadId: f.sessionId,
    },
  })
  const before = await f.store.readUsageSummary()
  expect(before.totals).toMatchObject({
    turns: 1,
    inputTokens: 51,
    outputTokens: 9,
  })
  await f.generator.closeSession(f.sessionId)
  await f.store.shutdownThread(f.sessionId)
  await f.store.deleteThread(f.sessionId)
  expect((await f.store.readUsageSummary()).totals).toEqual(before.totals)
  await f.store.shutdownThread("session_title_child")
  const cache = new DatabaseSync(join(f.root, "thread-usage.sqlite"))
  cache.exec("PRAGMA user_version = 4")
  cache.close()
  const reopened = new JsonlThreadStore({ root: f.root })
  const summary = await reopened.readUsageSummary()
  expect(summary.totals).toEqual(before.totals)
  expect(summary.unavailableThreads).toBeUndefined()
  expect(summary.models.find((row) => row.provider === "kimi")).toMatchObject({
    model: KIMI_TITLE_MODEL,
    turns: 0,
    inputTokens: 41,
    outputTokens: 7,
  })
  await reopened.deleteThread("session_title_child")
  expect((await reopened.readUsageSummary()).totals).toMatchObject({
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
  })
})

it("rejects malformed auxiliary accounting in both executable and accounting history", async () => {
  const f = await fixture(async function* () {
    yield {
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [],
        usage: { inputTokens: 9 },
      },
    }
  })
  await f.generator.generate({ sessionId: f.sessionId, text: "title" })
  await f.generator.closeSession(f.sessionId)
  await f.store.shutdownThread(f.sessionId)
  const path = join(f.root, "rollouts", f.sessionId, "rollout.jsonl")
  const bytes = await readFile(path, "utf8")
  const corrupt = bytes
    .split("\n")
    .map((line) => {
      if (!line) return line
      const value = JSON.parse(line)
      if (value.item.type === "auxiliary_usage")
        value.item.occurredAt = "invalid timestamp"
      return JSON.stringify(value)
    })
    .join("\n")
  await writeFile(path, corrupt)
  await expect(f.store.readThread(f.sessionId)).rejects.toThrow("invalid item")
  const summary = await f.store.readUsageSummary()
  expect(summary.unavailableThreads).toBe(1)
  expect(summary.totals.inputTokens).toBe(0)
  expect(await readFile(path, "utf8")).toBe(corrupt)
})
