import { appendFileSync } from "node:fs"
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  utimes,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  displayPageBytes,
  displayPageRecords,
} from "../../src/core/display-window.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem, StoredRolloutItem } from "../../src/core/rollout.ts"
import { SqliteThreadHistoryProjection } from "../../src/core/sqlite-thread-history-projection.ts"
import { PersistContext } from "../../src/core/thread-store.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"

const io = vi.hoisted(() => ({
  rolloutOpens: 0,
  fullReads: 0,
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
  beforeReadFile: undefined as ((path: string) => Promise<void>) | undefined,
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === "r") await io.beforeOpen?.(String(args[0]))
      if (String(args[0]).endsWith("rollout.jsonl") && args[1] === "r")
        io.rolloutOpens += 1
      return actual.open(...args)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await io.beforeReadFile?.(String(args[0]))
      if (String(args[0]).endsWith("rollout.jsonl")) io.fullReads += 1
      return actual.readFile(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  io.beforeOpen = undefined
  io.beforeReadFile = undefined
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const createdAt = "2026-11-10T00:00:00.000Z"
const metadata = (id: string) => ({
  id,
  conversationId: id,
  createdAt,
  updatedAt: createdAt,
})
const input = (name: string, text = name): RolloutItem => ({
  type: "response_item",
  item: {
    id: `input_${name}`,
    turnId: `turn_${name}`,
    createdAt,
    item: { role: "user", content: [{ type: "text", text }] },
  },
})
const context = (name: string): RolloutItem => {
  const selection = { provider: "faux", model: `model_${name}` }
  return {
    type: "turn_context",
    context: {
      turnId: `turn_${name}`,
      selection,
      configuration: SessionConfiguration.create({
        selection,
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: name,
      }).snapshot,
    },
  }
}
const turn = (name: string): RolloutItem[] => [
  {
    type: "turn_started",
    turnId: `turn_${name}`,
    inputItemId: `input_${name}`,
  },
  context(name),
  input(name),
  { type: "token_count", turnId: `turn_${name}`, activeContextTokens: 10 },
  { type: "turn_completed", turnId: `turn_${name}`, outcome: "completed" },
]

async function createStore(id = "thread_display") {
  const root = await mkdtemp(join(tmpdir(), "yakitori-display-projection-"))
  roots.push(root)
  const store = new JsonlThreadStore({ root })
  await store.initialize()
  await store.createThread(metadata(id))
  await store.persistThread(id, PersistContext.TurnStart)
  return { root, store, id }
}

function checkpoint(root: string, id: string, projection = "history") {
  const database = new DatabaseSync(join(root, `thread-${projection}.sqlite`))
  try {
    return database
      .prepare(`
      SELECT end_byte_offset, next_seq FROM rollout_checkpoints
      WHERE thread_id = ? AND rollout_id = ?
    `)
      .get(id, id)
  } finally {
    database.close()
  }
}

describe("persisted display projection", () => {
  it("waits for an admitted background history repair to publish before closing", async () => {
    const { root, store, id } = await createStore()
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()

    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    io.beforeOpen = async (path) => {
      if (path !== join(root, "rollouts", id, "rollout.jsonl")) return
      io.beforeOpen = undefined
      blocked.resolve()
      await release.promise
    }
    await store.appendItems(id, turn("saved"))
    await blocked.promise
    const closing = store.close()
    try {
      await expect(store.readThread(id)).rejects.toThrow(
        "Thread store is closed",
      )
    } finally {
      release.resolve()
      await closing
    }
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 6 })
  })

  it("opens persisted history before search initializes its database", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("independent"))
    await store.shutdownThread(id)

    // A metadata-only timestamp change does not invalidate a complete
    // history checkpoint.
    await utimes(join(root, "threads", `${id}.json`), 0, 0)
    const restarted = new JsonlThreadStore({ root })
    const history = await restarted.readDisplayWindow(id, undefined, true)
    expect(history).toMatchObject({ endSeq: 5, projectionReady: true })
    await expect(
      access(join(root, "thread-search.sqlite")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(
      restarted.searchThreads({ searchTerm: "independent", limit: 1 }),
    ).resolves.toMatchObject({ matches: [{ summary: { id } }] })
  })

  it("keeps legacy commentary out of the final answer while its trailing activity is deferred", async () => {
    const { root, store, id } = await createStore()
    const turnId = "turn_parts"
    const commentary: RolloutItem = {
      type: "item_completed",
      turnId,
      item: {
        type: "agent_message",
        itemId: "commentary",
        content: [{ type: "text", text: "I will examine this." }],
      },
    }
    const reasoning: RolloutItem = {
      type: "item_completed",
      turnId,
      item: {
        type: "reasoning",
        itemId: "reasoning",
        text: "Checking the context.",
      },
    }
    await store.appendItems(id, [input("parts"), commentary, reasoning])
    await store.appendItems(id, [
      { type: "turn_completed", turnId, outcome: "completed" },
    ])
    await store.shutdownThread(id)

    const restarted = new JsonlThreadStore({ root })
    const summary = await restarted.readDisplayWindow(id, undefined, true)
    expect(summary?.records.map(({ seq }) => seq)).toEqual([1, 2, 4])
    expect(summary?.records.at(-1)?.item).toMatchObject({
      completion: { answerItemIds: [] },
    })
    expect(summary?.activityTurnIds).toEqual([turnId])
    const activity = await restarted.readDisplayActivity(
      id,
      id,
      turnId,
      Number.MAX_SAFE_INTEGER,
    )
    expect(activity?.records).toEqual([
      expect.objectContaining({ seq: 3, item: reasoning }),
    ])
  })

  it("lists cold summaries without repairing unrelated histories ahead of the selected session", async () => {
    const unrelatedId = "thread_a_unrelated"
    const selectedId = "thread_z_selected"
    const { root, store } = await createStore(unrelatedId)
    await store.appendItems(unrelatedId, turn("unrelated"))
    await store.shutdownThread(unrelatedId)
    await store.createThread(metadata(selectedId))
    await store.persistThread(selectedId, PersistContext.TurnStart)
    await store.appendItems(selectedId, turn("selected"))
    await store.shutdownThread(selectedId)
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database.prepare("DELETE FROM projection_threads").run()
    database.close()
    const restarted = new JsonlThreadStore({ root })
    const listed = await restarted.listThreads()
    expect(listed.threads.map(({ id }) => id).sort()).toEqual([
      unrelatedId,
      selectedId,
    ])
    const selected = await restarted.readInputAdmissions(selectedId, [
      "turn_selected",
    ])
    expect(selected?.records.map(({ seq }) => seq)).toEqual([3])
    expect(selected?.endSeq).toBe(5)
    // The selected read also crosses the projection queue: any unrelated
    // repairs mistakenly queued by listing would have committed by now.
    const projected = new DatabaseSync(join(root, "thread-history.sqlite"))
    try {
      expect(
        projected
          .prepare(
            "SELECT thread_id FROM projection_threads ORDER BY thread_id",
          )
          .all(),
      ).toEqual([{ thread_id: selectedId }])
    } finally {
      projected.close()
    }
  })

  it("searches every unopened durable session on demand after a search projection schema reset", async () => {
    const firstId = "thread_first_unopened"
    const secondId = "thread_second_unopened"
    const { root, store } = await createStore(firstId)
    await store.appendItems(firstId, turn("match_first"))
    await store.shutdownThread(firstId)
    await store.createThread(metadata(secondId))
    await store.persistThread(secondId, PersistContext.TurnStart)
    await store.appendItems(secondId, turn("match_second"))
    await store.shutdownThread(secondId)
    await store.searchThreads({ searchTerm: "match_", limit: 10 })
    const database = new DatabaseSync(join(root, "thread-search.sqlite"))
    database.exec("PRAGMA user_version = 0")
    database.close()
    const restarted = new JsonlThreadStore({ root })
    io.fullReads = 0
    const matches = await restarted.searchThreads({
      searchTerm: "match_",
      limit: 10,
    })
    expect(matches.matches.map(({ summary }) => summary.id).sort()).toEqual([
      firstId,
      secondId,
    ])
    expect(io.fullReads).toBe(0)
    const occurrences = await restarted.searchThreadOccurrences({
      threadId: secondId,
      searchTerm: "match_second",
      limit: 10,
    })
    expect(occurrences?.occurrences.map(({ itemId }) => itemId)).toEqual([
      "input_match_second",
    ])
  })

  it("repairs only the selected Session for a local history search", async () => {
    const unrelatedId = "thread_unrelated_search"
    const selectedId = "thread_selected_search"
    const { root, store } = await createStore(unrelatedId)
    await store.appendItems(unrelatedId, turn("unrelated"))
    await store.shutdownThread(unrelatedId)
    await store.createThread(metadata(selectedId))
    await store.persistThread(selectedId, PersistContext.TurnStart)
    await store.appendItems(selectedId, turn("selected"))
    await store.shutdownThread(selectedId)
    const database = new DatabaseSync(join(root, "thread-search.sqlite"))
    database.exec("PRAGMA user_version = 0")
    database.close()

    const restarted = new JsonlThreadStore({ root })
    const occurrences = await restarted.searchThreadOccurrences({
      threadId: selectedId,
      searchTerm: "selected",
      limit: 10,
    })
    expect(occurrences?.occurrences.map(({ itemId }) => itemId)).toEqual([
      "input_selected",
    ])
    expect(checkpoint(root, selectedId, "search")).toMatchObject({
      next_seq: 6,
    })
    expect(checkpoint(root, unrelatedId, "search")).toBeUndefined()
  })

  it("opens a Session and flushes another while a search repair is paused", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("warm_writer"))
    await store.flushThread(id)
    const coldId = "thread_cold_index"
    await store.createThread(metadata(coldId))
    await store.persistThread(coldId, PersistContext.TurnStart)
    await store.appendItems(coldId, [
      ...Array.from({ length: displayPageRecords }, (_, index) =>
        input(`padding_${index}`),
      ),
      ...turn("late_search_result"),
    ])
    await store.shutdownThread(coldId)
    await store.searchThreads({ searchTerm: "warm_writer", limit: 10 })
    const database = new DatabaseSync(join(root, "thread-search.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(coldId)
    database.close()

    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let opens = 0
    io.beforeOpen = async (path) => {
      if (
        path !== join(root, "rollouts", coldId, "rollout.jsonl") ||
        ++opens !== 3
      )
        return
      // The lineage header and first batch have already been read.
      io.beforeOpen = undefined
      blocked.resolve()
      await release.promise
    }
    const repairing = store.searchThreadOccurrences({
      threadId: coldId,
      searchTerm: "late_search_result",
      limit: 10,
    })
    await blocked.promise

    let searchFinished = false
    const searching = store.searchThreads({
      searchTerm: "late_search_result",
      limit: 10,
    })
    void searching.then(
      () => (searchFinished = true),
      () => (searchFinished = true),
    )
    let flushed = false
    const saving = (async () => {
      await store.appendItems(id, turn("while_cold_indexing"))
      await store.flushThread(id)
      flushed = true
    })()
    const settled = Promise.allSettled([repairing, searching, saving])
    try {
      await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 2_000 })
      expect(searchFinished).toBe(false)
      const window = await store.readDisplayWindow(coldId)
      expect(window?.projectionReady).toBe(true)
      expect(window?.endSeq).toBe(displayPageRecords + 5)
    } finally {
      release.resolve()
      await settled
      await store.shutdownThread(id)
    }
    expect((await repairing)?.occurrences.map(({ itemId }) => itemId)).toEqual([
      "input_late_search_result",
    ])
    expect((await searching).matches.map(({ summary }) => summary.id)).toEqual([
      coldId,
    ])
  })

  it.each([
    "write",
    "search",
  ] as const)("flushes a Session independently of its own cold repair started by %s", async (trigger) => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("old"))
    await store.flushThread(id)
    await store.searchThreads({ searchTerm: "old", limit: 10 })
    const database = new DatabaseSync(
      join(
        root,
        trigger === "search" ? "thread-search.sqlite" : "thread-history.sqlite",
      ),
    )
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()

    const log = join(root, "rollouts", id, "rollout.jsonl")
    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pauseRepair = async () => {
      blocked.resolve()
      await release.promise
    }
    let opens = 0
    io.beforeOpen = async (path) => {
      if (path !== log) return
      if (trigger === "search") {
        io.beforeOpen = undefined
        await pauseRepair()
      } else if (++opens === 2) {
        io.beforeOpen = undefined
        // Hold the background repair after it has read the rollout and
        // checked its size, but before it can publish the final stamp.
        io.beforeReadFile = async (metadataPath) => {
          if (metadataPath !== join(root, "threads", `${id}.json`)) return
          io.beforeReadFile = undefined
          await pauseRepair()
        }
      }
    }
    const repairs =
      trigger === "search"
        ? store.searchThreadOccurrences({
            threadId: id,
            searchTerm: "old",
            limit: 10,
          })
        : store.appendItems(id, turn("starts_background_repair"))
    await blocked.promise
    let flushed = false
    const saving = (async () => {
      await store.appendItems(id, turn("written_before_repair"))
      await store.flushThread(id)
      flushed = true
    })()
    let searchFinished = false
    const search = store.searchThreads({
      searchTerm: "written_before_repair",
      limit: 10,
    })
    void search.then(
      () => {
        searchFinished = true
      },
      () => {
        searchFinished = true
      },
    )
    const settled = Promise.allSettled([repairs, saving, search])
    try {
      await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 2_000 })
      if (trigger === "search") expect(searchFinished).toBe(false)
      expect(await readFile(log, "utf8")).toContain(
        "input_written_before_repair",
      )
    } finally {
      release.resolve()
      await settled
      await store.shutdownThread(id)
    }
    expect((await search).matches[0]?.location?.itemId).toBe(
      "input_written_before_repair",
    )
  })

  it.each([
    "batch",
    "final_metadata",
  ] as const)("restarts selected repair after another store reverts during %s I/O", async (phase) => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [...turn("first"), ...turn("second")])
    await store.shutdownThread(id)
    const other = new JsonlThreadStore({ root })
    await other.initialize()
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()
    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let reads = 0
    const gate = async (path: string) => {
      const matches =
        phase === "batch"
          ? path === join(root, "rollouts", id, "rollout.jsonl")
          : path === join(root, "threads", `${id}.json`)
      if (!matches || ++reads !== 2) return
      io.beforeOpen = undefined
      io.beforeReadFile = undefined
      blocked.resolve()
      await release.promise
    }
    if (phase === "batch") io.beforeOpen = gate
    else io.beforeReadFile = gate
    const repairing = store.readInputAdmissions(id, [
      "turn_first",
      "turn_second",
    ])
    await blocked.promise
    let rolloutId: string
    try {
      const reverted = await other.revertThread({
        threadId: id,
        beforeTurnId: "turn_second",
        expectedRolloutId: id,
      })
      rolloutId = reverted.thread.metadata.rolloutId
      await other.shutdownThread(id)
    } finally {
      release.resolve()
    }
    const repaired = await repairing
    expect(repaired?.metadata.rolloutId).toBe(rolloutId)
    expect(repaired?.records.map(({ seq }) => seq)).toEqual([3])
    expect(repaired?.endSeq).toBe(5)
    const current = await store.readDisplayWindow(id)
    expect(current?.projectionReady).toBe(true)
    expect(current?.metadata.rolloutId).toBe(rolloutId)
    expect(current?.records.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5])
  })

  it("does not replay a writer append already consumed while its projection update waits", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("first"))
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()
    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let opens = 0
    io.beforeOpen = async (path) => {
      if (path !== join(root, "rollouts", id, "rollout.jsonl") || ++opens !== 2)
        return
      io.beforeOpen = undefined
      blocked.resolve()
      await release.promise
    }
    const append = SqliteThreadHistoryProjection.prototype.append
    const projectionErrors: unknown[] = []
    vi.spyOn(
      SqliteThreadHistoryProjection.prototype,
      "append",
    ).mockImplementation(function (
      this: SqliteThreadHistoryProjection,
      ...args
    ) {
      try {
        append.apply(this, args)
      } catch (error) {
        projectionErrors.push(error)
        throw error
      }
    })
    const repairing = store.readInputAdmissions(id, [])
    await blocked.promise
    const written = Promise.withResolvers<void>()
    io.beforeReadFile = async (path) => {
      if (path !== join(root, "threads", `${id}.json`)) return
      io.beforeReadFile = undefined
      written.resolve()
    }
    const appending = store.appendItems(id, turn("during"))
    await written.promise
    release.resolve()
    await Promise.all([repairing, appending])
    await store.shutdownThread(id)
    expect(projectionErrors).toEqual([])
    expect((await store.readThreadSummary(id))?.seq).toBe(10)
    const admissions = await store.readInputAdmissions(id, [
      "turn_first",
      "turn_during",
    ])
    expect(admissions?.records.map(({ seq }) => seq)).toEqual([3, 8])
    expect(admissions?.endSeq).toBe(10)
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 11 })
  })

  it("advances cold coverage across hidden-only tails until an earlier display page is reached", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [
      ...turn("visible"),
      ...Array.from(
        { length: 1_500 },
        (_, index): RolloutItem => ({
          type: "model_context",
          settings: {
            provider: "faux",
            model: `hidden_${index}_${"x".repeat(600)}`,
          },
        }),
      ),
    ])
    await store.shutdownThread(id)
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()
    const release = Promise.withResolvers<void>()
    let reads = 0
    io.beforeReadFile = async (path) => {
      if (path !== join(root, "threads", `${id}.json`) || ++reads !== 2) return
      io.beforeReadFile = undefined
      await release.promise
    }
    let before: number | undefined
    let reachedVisible = false
    try {
      for (let page = 0; page < 5; page += 1) {
        const window = await store.readDisplayWindow(id, before)
        expect(window?.projectionReady).toBe(false)
        const cursor = window?.coverageStartSeq
        expect(cursor).toBeDefined()
        if (before !== undefined) expect(cursor).toBeLessThan(before)
        if (page === 0) {
          expect(window?.records).toEqual([])
          expect(window?.lookbehind).toEqual([])
          expect(window?.hasEarlier).toBe(true)
        }
        if (window?.records.some(({ seq }) => seq === 3)) {
          reachedVisible = true
          break
        }
        before = cursor
      }
    } finally {
      release.resolve()
      await store.readInputAdmissions(id, [])
    }
    expect(reachedVisible).toBe(true)
    expect(
      (await store.readDisplayWindow(id))?.records.map(({ seq }) => seq),
    ).toEqual([1, 2, 3, 4, 5])
  })

  it("finds admitted inputs in an unpublished staged session without execution replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-display-staged-"))
    roots.push(root)
    const store = new JsonlThreadStore({ root })
    await store.initialize()
    const id = "thread_staged"
    await store.createThread(metadata(id))
    await store.appendItems(id, [
      {
        type: "turn_started",
        turnId: "turn_staged",
        inputItemId: "input_staged",
      },
      context("staged"),
      input("staged"),
    ])
    const lookup = await store.readInputAdmissions(id, [
      "turn_staged",
      "turn_missing",
    ])
    expect(lookup?.records.map(({ seq }) => seq)).toEqual([3])
    expect(lookup?.endSeq).toBe(3)
    const events = await store.readThreadEvents(id, { after: -1, limit: 10 })
    expect(events?.records.map(({ seq }) => seq)).toEqual([0, 1, 3])
    expect(events).toMatchObject({ nextAfter: 3, endSeq: 3, hasMore: false })
    await store.shutdownThread(id)
  })

  it("splits one large Turn into bounded pages with owning Turn/model and cache state", async () => {
    const { store, id } = await createStore()
    const rows: RolloutItem[] = [
      ...turn("cached"),
      {
        type: "turn_started",
        turnId: "turn_large",
        inputItemId: "input_large",
      },
      context("large"),
      input("large"),
      ...Array.from(
        { length: 650 },
        (_, index): RolloutItem => ({
          type: "token_count",
          turnId: "turn_large",
          activeContextTokens: index + 20,
        }),
      ),
      {
        type: "model_context",
        settings: { provider: "faux", model: "hidden" },
      },
      { type: "turn_completed", turnId: "turn_large", outcome: "failed" },
    ]
    const appended = await store.appendItems(id, rows)
    await store.shutdownThread(id)
    const page = await store.readDisplayWindow(id)
    expect(page?.records).toHaveLength(200)
    expect(page?.lookbehind.map(({ item }) => item.type)).toEqual([
      "turn_context",
      "turn_completed",
      "turn_started",
      "turn_context",
    ])
    const pages: StoredRolloutItem[][] = []
    let before: number | undefined
    for (;;) {
      const window = await store.readDisplayWindow(id, before)
      if (window === undefined) throw new Error("Missing window")
      expect(window.records.length).toBeLessThanOrEqual(200)
      expect(
        Buffer.byteLength(
          window.records.map((record) => JSON.stringify(record)).join(""),
        ),
      ).toBeLessThanOrEqual(displayPageBytes)
      pages.unshift([...window.records])
      if (!window.hasEarlier) break
      before = window.records[0]?.seq
    }
    expect(pages.flat().map(({ seq }) => seq)).toEqual(
      appended.records
        .filter(({ item }) => item.type !== "model_context")
        .map(({ seq }) => seq),
    )
  })

  it("bounds pages by serialized bytes and lets one oversized record make progress", async () => {
    const { store, id } = await createStore()
    const large = "text".repeat(30_000)
    await store.appendItems(id, [
      {
        type: "turn_started",
        turnId: "turn_bytes",
        inputItemId: "input_bytes",
      },
      input("bytes", large),
      input("oversized", "x".repeat(displayPageBytes + 1)),
      {
        type: "turn_completed",
        turnId: "turn_oversized",
        outcome: "completed",
      },
    ])
    await store.shutdownThread(id)
    const latest = await store.readDisplayWindow(id)
    expect(latest?.records.map(({ seq }) => seq)).toEqual([4])
    const oversized = await store.readDisplayWindow(id, 4)
    expect(oversized?.records.map(({ seq }) => seq)).toEqual([3])
    expect(oversized?.hasEarlier).toBe(true)
    const previous = await store.readDisplayWindow(id, 3)
    expect(previous?.records.map(({ seq }) => seq)).toEqual([1, 2])
  })

  it("reuses SQLite across pages and restarts, then catches up only an appended suffix", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [...turn("first"), ...turn("second")])
    await store.shutdownThread(id)
    const original = checkpoint(root, id)
    const restarted = new JsonlThreadStore({ root })
    await restarted.initialize()
    io.rolloutOpens = 0
    io.fullReads = 0
    await restarted.readDisplayWindow(id)
    await restarted.readDisplayWindow(id, 6)
    await restarted.readThreadEvents(id, { after: -1, limit: 3 })
    await restarted.readInputAdmissions(id, ["turn_first", "turn_absent"])
    expect(io.rolloutOpens).toBe(0)
    expect(io.fullReads).toBe(0)
    const record: StoredRolloutItem = {
      threadId: id,
      rolloutId: id,
      seq: 11,
      createdAt,
      item: input("external"),
    }
    const serialized = `${JSON.stringify(record)}\n`
    const path = join(root, "rollouts", id, "rollout.jsonl")
    await appendFile(path, serialized.slice(0, 40))
    const incomplete = await restarted.readInputAdmissions(id, [
      "turn_external",
    ])
    expect(incomplete).toMatchObject({ records: [], endSeq: 10 })
    expect(checkpoint(root, id)).toEqual(original)
    await appendFile(path, serialized.slice(40))
    const admissions = await restarted.readInputAdmissions(id, [
      "turn_external",
      "turn_absent",
    ])
    expect(admissions?.records.map(({ seq }) => seq)).toEqual([11])
    expect(admissions?.endSeq).toBe(11)
    expect(io.fullReads).toBe(0)
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 12 })
    expect(checkpoint(root, id)).not.toEqual(original)
    io.rolloutOpens = 0
    await restarted.readDisplayWindow(id)
    await restarted.readThreadEvents(id, { after: 5, limit: 100 })
    expect(io.rolloutOpens).toBe(0)
  })

  it("resumes a partially committed repair after restart without applying its prefix twice", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [
      ...turn("first"),
      ...Array.from(
        { length: 500 },
        (_, index): RolloutItem => ({
          type: "model_context",
          settings: { provider: "faux", model: `hidden_${index}` },
        }),
      ),
    ])
    await store.shutdownThread(id)
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()
    const append = SqliteThreadHistoryProjection.prototype.append
    let batches = 0
    const fault = vi
      .spyOn(SqliteThreadHistoryProjection.prototype, "append")
      .mockImplementation(function (
        this: SqliteThreadHistoryProjection,
        ...args
      ) {
        batches += 1
        if (batches === 2)
          throw new Error("simulated process exit between batches")
        append.apply(this, args)
      })
    await expect(store.readInputAdmissions(id, ["turn_first"])).rejects.toThrow(
      "between batches",
    )
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 200 })
    fault.mockRestore()
    const restarted = new JsonlThreadStore({ root })
    await restarted.initialize()
    io.fullReads = 0
    const admissions = await restarted.readInputAdmissions(id, ["turn_first"])
    expect(admissions?.records.map(({ seq }) => seq)).toEqual([3])
    expect(admissions?.endSeq).toBe(505)
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 506 })
    expect(io.fullReads).toBe(0)
    expect(
      (await restarted.searchThreads({ searchTerm: "first", limit: 10 }))
        .matches,
    ).toHaveLength(1)
  })

  it("consumes bytes appended during repair before publishing its canonical watermark", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("first"))
    await store.shutdownThread(id)
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const external = (seq: number, name: string): StoredRolloutItem => ({
      threadId: id,
      rolloutId: id,
      seq,
      createdAt,
      item: input(name),
    })
    await appendFile(path, `${JSON.stringify(external(6, "before_repair"))}\n`)
    const append = SqliteThreadHistoryProjection.prototype.append
    let appended = false
    vi.spyOn(
      SqliteThreadHistoryProjection.prototype,
      "append",
    ).mockImplementation(function (
      this: SqliteThreadHistoryProjection,
      ...args
    ) {
      append.apply(this, args)
      if (!appended && args[1].some(({ seq }) => seq === 6)) {
        appended = true
        appendFileSync(
          path,
          `${JSON.stringify(external(7, "during_repair"))}\n`,
        )
      }
    })
    const result = await store.readInputAdmissions(id, [
      "turn_before_repair",
      "turn_during_repair",
    ])
    expect(result?.records.map(({ seq }) => seq)).toEqual([6, 7])
    expect(result?.endSeq).toBe(7)
    expect(checkpoint(root, id)).toMatchObject({ next_seq: 8 })
    expect((await store.readDisplayWindow(id))?.projectionReady).toBe(true)
  })

  it("initializes GC from headers without opening rollout bodies for global projection repair", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, turn("first"))
    await store.shutdownThread(id)
    await appendFile(
      join(root, "rollouts", id, "rollout.jsonl"),
      "{invalid body\n",
    )
    io.fullReads = 0
    io.rolloutOpens = 0
    const restarted = new JsonlThreadStore({ root })
    await restarted.initialize()
    expect(io.fullReads).toBe(0)
    expect(io.rolloutOpens).toBe(1)
  })

  it("omits provider records durably while advancing bounded event cursors through them", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [
      ...turn("one"),
      {
        type: "model_attempt",
        turnId: "turn_one",
        attempt: {
          origin: {
            callId: "call_one",
            attemptId: "attempt_one",
            attempt: 1,
            provider: "faux",
            model: "scripted",
          },
          wireApi: "test",
          outcome: "completed",
          responseMetadata: {
            provider: "faux",
            model: "scripted",
            wireApi: "openai_responses",
            value: { secret: "provider-only metadata" },
          },
        },
      },
      {
        type: "model_context",
        settings: { provider: "faux", model: "hidden" },
      },
    ])
    await store.shutdownThread(id)
    const first = await store.readThreadEvents(id, { after: -1, limit: 2 })
    expect(first?.records.map(({ seq }) => seq)).toEqual([0, 1])
    expect(first).toMatchObject({ nextAfter: 1, hasMore: true, endSeq: 7 })
    const second = await store.readThreadEvents(id, {
      after: 1,
      through: 7,
      limit: 20,
    })
    expect(second?.records.map(({ seq }) => seq)).toEqual([3, 4, 5])
    expect(second).toMatchObject({ nextAfter: 7, hasMore: false, endSeq: 7 })
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    try {
      expect(
        database
          .prepare(
            "SELECT 1 FROM thread_items WHERE record_json LIKE '%provider-only%'",
          )
          .get(),
      ).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it("repairs a deleted projection incrementally while local opens read a bounded tail", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [
      ...turn("old"),
      ...Array.from(
        { length: 1_500 },
        (_, index): RolloutItem => ({
          type: "model_context",
          settings: {
            provider: "faux",
            model: `padding_${index}_${"x".repeat(500)}`,
          },
        }),
      ),
      ...turn("latest"),
    ])
    await store.shutdownThread(id)
    // Invalidate only this disposable row; JSONL stays intact. The selected
    // read is independent of repair and the next targeted lookup establishes
    // complete coverage through the canonical watermark.
    const database = new DatabaseSync(join(root, "thread-history.sqlite"))
    database
      .prepare("DELETE FROM projection_threads WHERE thread_id = ?")
      .run(id)
    database.close()
    const restarted = new JsonlThreadStore({ root })
    await restarted.initialize()
    io.fullReads = 0
    const latest = await restarted.readDisplayWindow(id)
    expect(latest?.projectionReady).toBe(false)
    expect(latest?.records.map(({ seq }) => seq)).toEqual([
      1506, 1507, 1508, 1509, 1510,
    ])
    const admissions = await restarted.readInputAdmissions(id, [
      "turn_old",
      "turn_missing",
    ])
    expect(admissions?.records.map(({ seq }) => seq)).toEqual([3])
    expect(admissions?.endSeq).toBe(1510)
    expect((await restarted.readDisplayWindow(id))?.projectionReady).toBe(true)
    expect(io.fullReads).toBe(0)
    const reopened = new JsonlThreadStore({ root })
    await reopened.initialize()
    io.rolloutOpens = 0
    expect((await reopened.readDisplayWindow(id))?.records).toEqual(
      latest?.records,
    )
    expect(io.rolloutOpens).toBe(0)
  })

  it("retains fork cutoffs and physical event identities after revert and restart", async () => {
    const { root, store, id } = await createStore()
    await store.appendItems(id, [...turn("one"), ...turn("two")])
    const prepared = await store.prepareFork({
      sourceThreadId: id,
      boundary: { type: "latest" },
    })
    await store.createFork({ prepared, target: metadata("thread_child") })
    await store.appendItems(id, turn("outside"))
    await store.shutdownThread(id)
    await store.shutdownThread("thread_child")
    const reverted = await store.revertThread({
      threadId: "thread_child",
      beforeTurnId: "turn_two",
      expectedRolloutId: "thread_child",
    })
    await store.appendItems("thread_child", turn("replacement"))
    await store.shutdownThread("thread_child")
    const reopened = new JsonlThreadStore({ root })
    await reopened.initialize()
    const page = await reopened.readThreadEvents("thread_child", {
      after: -1,
      limit: displayPageRecords,
    })
    expect(page?.records.map(({ seq }) => seq)).toEqual([
      0, 1, 3, 4, 5, 6, 8, 9, 10,
    ])
    expect(page?.records[1]?.rolloutId).toBe(id)
    expect(page?.records[6]?.rolloutId).toBe(reverted.thread.metadata.rolloutId)
    expect(
      page?.records.some(
        ({ item }) =>
          item.type === "response_item" && item.item.turnId === "turn_outside",
      ),
    ).toBe(false)
    const lookup = await reopened.readInputAdmissions("thread_child", [
      "turn_two",
      "turn_replacement",
    ])
    expect(lookup?.records.map(({ seq }) => seq)).toEqual([8])
    expect(
      await readFile(join(root, "rollouts", id, "rollout.jsonl"), "utf8"),
    ).toContain("outside")
  })
})
