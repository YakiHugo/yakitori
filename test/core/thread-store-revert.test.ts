import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem, StoredThread } from "../../src/core/rollout.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { SqliteThreadUsageProjection } from "../../src/core/sqlite-thread-usage-projection.ts"
import {
  type CreateThreadMetadata,
  PersistContext,
  type ThreadStore,
} from "../../src/core/thread-store.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe.each(["jsonl", "memory"] as const)("%s revert contract", (kind) => {
  it("retains identity and ancestry while replacing the rollout and its writable suffix", async () => {
    const store =
      kind === "jsonl" ? (await jsonlStore()).store : new MemoryThreadStore()
    const id = "session_stable"
    await createThread(store, metadata(id))
    await store.appendItems(id, [...turn("one", 10), ...turn("two", 20)])
    await store.shutdownThread(id)
    const prior = await requiredThread(store, id)
    const result = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_two",
      expectedRolloutId: prior.metadata.rolloutId,
    })

    expect(result.thread.metadata).toEqual({
      ...prior.metadata,
      rolloutId: expect.stringMatching(/^rollout_/),
      previousRolloutId: prior.metadata.rolloutId,
      updatedAt: expect.any(String),
      historyBase: {
        rolloutId: prior.metadata.rolloutId,
        endSeqExclusive: 5,
        endByteOffset: expect.any(Number),
      },
    })
    expect(result.thread.metadata.rolloutId).not.toBe(prior.metadata.rolloutId)
    expect(Date.parse(result.thread.metadata.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(prior.metadata.updatedAt),
    )
    expect(result.historyEndSeqExclusive).toBe(5)
    expect(result.thread.rollout.slice(1)).toEqual(prior.rollout.slice(1, 5))
    expect(await store.listThreadIds()).toEqual([id])

    const appended = await store.appendItems(id, turn("replacement", 30))
    expect(appended.records.map(({ seq }) => seq)).toEqual([5, 6, 7, 8])
    expect(
      appended.records.every(
        (record) =>
          record.threadId === id &&
          record.rolloutId === result.thread.metadata.rolloutId,
      ),
    ).toBe(true)
    await store.shutdownThread(id)
    const head = await requiredThread(store, id)
    await expect(
      store.revertThread({
        threadId: id,
        beforeTurnId: "turn_replacement",
        expectedRolloutId: prior.metadata.rolloutId,
      }),
    ).rejects.toThrow("rollout changed")
    expect(await store.readThread(id)).toEqual(head)
  })

  it("rejects a live writer and supports reverting to an empty prefix", async () => {
    const store =
      kind === "jsonl" ? (await jsonlStore()).store : new MemoryThreadStore()
    const id = "session_empty_prefix"
    await createThread(store, metadata(id))
    await store.appendItems(id, turn("first", 10))
    const input = {
      threadId: id,
      beforeTurnId: "turn_first",
      expectedRolloutId: id,
    }
    const prior = await requiredThread(store, id)
    await expect(store.revertThread(input)).rejects.toThrow("live writer")
    expect(await store.readThread(id)).toEqual(prior)
    await store.shutdownThread(id)
    const result = await store.revertThread(input)
    expect(result.thread.metadata.historyBase).toBeUndefined()
    expect(result.historyEndSeqExclusive).toBeUndefined()
    expect(result.thread.rollout).toHaveLength(1)
    const appended = await store.appendItems(id, turn("new", 20))
    expect(appended.records[0]?.seq).toBe(1)
    await store.shutdownThread(id)
  })
})

describe("JSONL stable session history", () => {
  it("keeps repeated reverts, restart, search, usage, paging and inherited assets consistent", async () => {
    const { root, store } = await jsonlStore()
    const id = "session_repeated"
    await createThread(store, metadata(id))
    const assets = createRolloutAssets(root, {
      withMutationLease: (rolloutId, mutate) =>
        store.withRolloutAssetMutation(rolloutId, mutate),
    })
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=",
      "base64",
    )
    const saved = await assets.saveToolFile(
      id,
      "tool_saved",
      "proof.png",
      bytes,
    )
    const first = turn("one", 10)
    const user = first[1]
    if (user?.type !== "response_item")
      throw new Error("Missing fixture user input.")
    const withAsset: RolloutItem = {
      ...user,
      item: {
        ...user.item,
        item: {
          role: "user",
          content: [
            { type: "text", text: "needle one" },
            {
              type: "image",
              mediaType: "image/png",
              file: saved.reference,
              sizeBytes: bytes.length,
            },
          ],
        },
      },
    }
    await store.appendItems(id, [
      ...first.slice(0, 1),
      withAsset,
      ...first.slice(2),
      ...turn("two", 20),
      ...turn("three", 30),
    ])
    await store.shutdownThread(id)
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(60)
    const firstRevert = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_three",
      expectedRolloutId: id,
    })
    expect(firstRevert.historyEndSeqExclusive).toBe(9)
    expect(await pageSequences(store, id)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ])
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(60)
    expect(
      (await store.searchThreads({ searchTerm: "three", limit: 10 })).matches,
    ).toEqual([])
    expect(
      (await store.searchThreads({ searchTerm: "two", limit: 10 })).matches.map(
        ({ summary }) => summary.id,
      ),
    ).toEqual([id])
    const occurrencePage = await store.searchThreadOccurrences({
      threadId: id,
      searchTerm: "needle",
      limit: 1,
    })
    expect(occurrencePage?.occurrences).toHaveLength(1)
    expect(occurrencePage?.nextCursor).toBeDefined()
    if (occurrencePage?.nextCursor === undefined)
      throw new Error("Missing occurrence cursor.")
    const nextOccurrences = await store.searchThreadOccurrences({
      threadId: id,
      searchTerm: "needle",
      limit: 10,
      cursor: occurrencePage.nextCursor,
    })
    expect(nextOccurrences?.occurrences).toHaveLength(1)
    await store.appendItems(id, turn("replacement", 40))
    await store.shutdownThread(id)
    const secondRevert = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_two",
      expectedRolloutId: firstRevert.thread.metadata.rolloutId,
    })
    expect(secondRevert.thread.metadata.rolloutId).not.toBe(
      firstRevert.thread.metadata.rolloutId,
    )
    expect(secondRevert.thread.metadata.historyBase?.rolloutId).toBe(id)
    expect(secondRevert.historyEndSeqExclusive).toBe(5)
    await store.shutdownThread(id)

    const reopened = new JsonlThreadStore({ root })
    const stored = await requiredThread(reopened, id)
    expect(stored.metadata.rolloutId).toBe(
      secondRevert.thread.metadata.rolloutId,
    )
    expect(await pageSequences(reopened, id)).toEqual([[1, 2, 3, 4]])
    expect((await reopened.readUsageSummary()).totals.inputTokens).toBe(100)
    expect(
      (
        await reopened.searchThreads({ searchTerm: "needle", limit: 10 })
      ).matches.map(({ summary }) => summary.id),
    ).toEqual([id])
    expect(
      await reopened.searchThreadOccurrences({
        threadId: id,
        searchTerm: "replacement",
        limit: 10,
      }),
    ).toMatchObject({ occurrences: [] })
    expect(await assets.read(saved.reference)).toEqual(bytes)
    expect(
      await readFile(join(root, "rollouts", id, "rollout.jsonl"), "utf8"),
    ).toContain("needle three")
    expect(await reopened.resumeThread(id)).toEqual(stored)
    await reopened.appendItems(id, turn("after_restart", 50))
    await reopened.shutdownThread(id)
    expect((await reopened.readUsageSummary()).totals.inputTokens).toBe(150)

    await reopened.resumeThread(id)
    await reopened.appendItems(id, turn("discarded", 70))
    await reopened.shutdownThread(id)
    const thirdRevert = await reopened.revertThread({
      threadId: id,
      beforeTurnId: "turn_discarded",
      expectedRolloutId: secondRevert.thread.metadata.rolloutId,
    })
    expect(thirdRevert.thread.metadata.historyBase?.rolloutId).toBe(
      secondRevert.thread.metadata.rolloutId,
    )
    await reopened.shutdownThread(id)
    const nested = new JsonlThreadStore({ root })
    expect(await pageSequences(nested, id)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ])
    expect((await nested.readUsageSummary()).totals.inputTokens).toBe(220)
    expect(await assets.read(saved.reference)).toEqual(bytes)
  })

  it("checks the expected rollout again after preparing the prefix", async () => {
    const { store } = await jsonlStore()
    const id = "session_cas"
    await createThread(store, metadata(id))
    await store.appendItems(id, [...turn("one", 10), ...turn("two", 20)])
    await store.shutdownThread(id)
    const prepareFork = store.prepareFork.bind(store)
    let preparedStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      preparedStarted = resolve
    })
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(store, "prepareFork").mockImplementationOnce(async (input) => {
      const prepared = await prepareFork(input)
      preparedStarted()
      await barrier
      return prepared
    })
    const stale = store.revertThread({
      threadId: id,
      beforeTurnId: "turn_two",
      expectedRolloutId: id,
    })
    await started
    const current = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_two",
      expectedRolloutId: id,
    })
    await store.shutdownThread(id)
    const head = await requiredThread(store, id)
    release()
    await expect(stale).rejects.toThrow("rollout changed")
    expect((await requiredThread(store, id)).metadata.rolloutId).toBe(
      current.thread.metadata.rolloutId,
    )
    expect(await store.readThread(id)).toEqual(head)
  })

  it("rejects another store's live writer without changing its current rollout", async () => {
    const { root, store } = await jsonlStore()
    const id = "session_writer"
    await createThread(store, metadata(id))
    await store.appendItems(id, turn("one", 10))
    const other = new JsonlThreadStore({ root })
    const prior = await requiredThread(store, id)
    await expect(
      other.revertThread({
        threadId: id,
        beforeTurnId: "turn_one",
        expectedRolloutId: id,
      }),
    ).rejects.toThrow("active writer")
    expect(await other.readThread(id)).toEqual(prior)
    await store.shutdownThread(id)
    expect(await readdir(join(root, "locks", "reservations"))).toEqual([])
  })

  it("restores canonical metadata and both projections when publication fails", async () => {
    const { root, store } = await jsonlStore()
    const id = "session_failed_revert"
    await createThread(store, metadata(id))
    await store.appendItems(id, [...turn("one", 10), ...turn("two", 20)])
    await store.shutdownThread(id)
    const prior = await requiredThread(store, id)
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(30)
    vi.spyOn(
      SqliteThreadUsageProjection.prototype,
      "rebuild",
    ).mockImplementationOnce(() => {
      throw new Error("usage projection publication failed")
    })
    await expect(
      store.revertThread({
        threadId: id,
        beforeTurnId: "turn_two",
        expectedRolloutId: id,
      }),
    ).rejects.toThrow("usage projection publication failed")
    expect(await store.readThread(id)).toEqual(prior)
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(30)
    expect(
      (await store.searchThreads({ searchTerm: "two", limit: 10 })).matches,
    ).toHaveLength(1)
    expect(await readdir(join(root, "rollouts"))).toEqual([id])
    expect(await readdir(join(root, "locks", "reservations"))).toEqual([])
    expect(await new JsonlThreadStore({ root }).readThread(id)).toEqual(prior)
    await store.resumeThread(id)
    await store.shutdownThread(id)
  })

  it("preserves existing fork reservations and ordinary explicit fork behavior", async () => {
    const { root, store } = await jsonlStore()
    const id = "session_reserved"
    await createThread(store, metadata(id))
    await store.appendItems(id, [...turn("one", 10), ...turn("two", 20)])
    const prepared = await store.prepareFork({
      sourceThreadId: id,
      boundary: { type: "latest" },
    })
    await store.shutdownThread(id)
    await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_two",
      expectedRolloutId: id,
    })
    const fork = await store.createFork({
      prepared,
      target: { ...metadata("session_explicit"), parentThreadId: id },
    })
    expect(fork.thread.metadata.id).toBe("session_explicit")
    expect(fork.thread.metadata.rolloutId).toBe("session_explicit")
    expect(fork.thread.rollout).toHaveLength(9)
    await store.shutdownThread(id)
    await store.shutdownThread("session_explicit")
    await store.deleteThread(id)
    const reopened = new JsonlThreadStore({ root })
    expect(
      (await requiredThread(reopened, "session_explicit")).rollout,
    ).toHaveLength(9)
  })
})

async function jsonlStore() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-revert-"))
  roots.push(root)
  return { root, store: new JsonlThreadStore({ root }) }
}

function metadata(id: string): CreateThreadMetadata {
  return {
    id,
    conversationId: "conversation_original",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: "Original session",
    workingDirectory: "/workspace/original",
    projectId: "project_original",
    parentThreadId: "session_parent",
    forkedFromTurnId: "turn_parent",
    metadata: { custom: "retained" },
  }
}

async function createThread(store: ThreadStore, input: CreateThreadMetadata) {
  await store.createThread(input)
  await store.persistThread(input.id, PersistContext.TurnStart)
}

async function requiredThread(
  store: ThreadStore,
  id: string,
): Promise<StoredThread> {
  const thread = await store.readThread(id)
  if (thread === undefined) throw new Error("Missing fixture thread.")
  return thread
}

function turn(name: string, inputTokens: number): readonly RolloutItem[] {
  const turnId = `turn_${name}`
  const createdAt = "2026-01-01T00:00:00.000Z"
  return [
    { type: "turn_started", turnId, inputItemId: `input_${name}` },
    {
      type: "response_item",
      item: {
        id: `input_${name}`,
        turnId,
        createdAt,
        item: {
          role: "user",
          content: [{ type: "text", text: `needle ${name}` }],
        },
      },
    },
    {
      type: "response_item",
      item: {
        id: `answer_${name}`,
        turnId,
        createdAt,
        item: {
          role: "assistant",
          content: [{ type: "text", text: `answer ${name}` }],
        },
      },
    },
    {
      type: "turn_completed",
      turnId,
      outcome: "completed",
      usage: { inputTokens, outputTokens: 1 },
    },
  ]
}

async function pageSequences(store: ThreadStore, id: string) {
  const pages: number[][] = []
  let beforeSeqExclusive: number | undefined
  while (true) {
    const page = await store.readDisplayWindow(id, beforeSeqExclusive)
    if (page === undefined) throw new Error("Missing display window.")
    pages.unshift(page.records.map(({ seq }) => seq))
    if (!page.hasEarlier) return pages
    beforeSeqExclusive = page.records[0]?.seq
    if (beforeSeqExclusive === undefined) throw new Error("Empty display page.")
  }
}
