import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import {
  type CreateThreadMetadata,
  PersistContext,
  type ThreadStore,
} from "../../src/core/thread-store.ts"
import { readUsageHistory } from "../../src/core/usage-history.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe.each(["jsonl", "memory"] as const)("%s actual spent", (kind) => {
  it("keeps truncated turn and title usage through repeated reverts without counting inherited copies twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-spent-"))
    roots.push(root)
    const store: ThreadStore =
      kind === "jsonl"
        ? new JsonlThreadStore({ root })
        : new MemoryThreadStore()
    const id = "session_spent"
    await store.createThread(metadata(id))
    await store.persistThread(id, PersistContext.TurnStart)
    await store.appendItems(id, [
      ...turn("retained", 10, 2),
      ...turn("discarded", 20, 4),
      titleUsage("original", 7),
    ])
    await store.shutdownThread(id)
    expect((await store.readUsageSummary()).totals).toEqual({
      turns: 2,
      inputTokens: 37,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    })
    const first = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_discarded",
      expectedRolloutId: id,
    })
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(37)
    expect(
      (await store.searchThreads({ searchTerm: "discarded", limit: 10 }))
        .matches,
    ).toEqual([])
    await store.appendItems(id, [
      ...turn("replacement", 30, 6),
      titleUsage("replacement", 5),
    ])
    const prepared = await store.prepareFork({
      sourceThreadId: id,
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared,
      target: { ...metadata("session_fork"), parentThreadId: id },
    })
    await store.shutdownThread("session_fork")
    await store.shutdownThread(id)
    const second = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_retained",
      expectedRolloutId: first.thread.metadata.rolloutId,
    })
    expect(second.thread.rollout).toHaveLength(1)
    expect((await store.readUsageSummary()).totals).toEqual({
      turns: 3,
      inputTokens: 72,
      outputTokens: 14,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    })
    await store.shutdownThread(id)

    if (kind === "jsonl") {
      const history = await readUsageHistory(
        second.thread.metadata,
        join(root, "rollouts"),
      )
      const physicalRecords = history.rollout.map(
        ({ rolloutId, seq }) => `${rolloutId}:${seq}`,
      )
      expect(new Set(physicalRecords).size).toBe(physicalRecords.length)
      expect(
        history.rollout
          .filter(({ item }) => item.type === "turn_completed")
          .map(({ item }) => item.type === "turn_completed" && item.turnId),
      ).toEqual(["turn_retained", "turn_discarded", "turn_replacement"])
      const fork = await store.readThreadMetadata("session_fork")
      if (fork === undefined) throw new Error("Missing fork.")
      const forkHistory = await readUsageHistory(fork, join(root, "rollouts"))
      expect(
        forkHistory.rollout.some(
          ({ item }) =>
            item.type === "turn_completed" && item.turnId === "turn_discarded",
        ),
      ).toBe(false)

      // A projection built by the prefix-only accounting reader must rebuild.
      const oldCache = new DatabaseSync(join(root, "thread-usage.sqlite"))
      oldCache.exec("UPDATE usage_turns SET input_tokens = 0")
      oldCache.exec("PRAGMA user_version = 5")
      oldCache.close()
      const reopened = new JsonlThreadStore({ root })
      const usage = await reopened.readUsageSummary()
      expect(usage.totals.inputTokens).toBe(72)
      expect(usage.totals.outputTokens).toBe(14)
      expect(
        usage.models.map(({ model, inputTokens }) => [model, inputTokens]),
      ).toEqual([
        ["replacement", 30],
        ["discarded", 20],
        ["title", 12],
        ["retained", 10],
      ])
      expect(usage.threads).toMatchObject([
        { threadId: id, inputTokens: 72, turns: 3 },
      ])
      expect((await reopened.readThread(id))?.rollout).toHaveLength(1)
      expect(
        (
          await reopened.searchThreadOccurrences({
            threadId: id,
            searchTerm: "replacement",
            limit: 10,
          })
        )?.occurrences,
      ).toEqual([])

      const cache = new DatabaseSync(join(root, "thread-usage.sqlite"))
      cache.exec("PRAGMA foreign_keys = ON")
      cache.exec("DELETE FROM usage_threads")
      cache.close()
      expect((await reopened.readUsageSummary()).totals.inputTokens).toBe(72)
      await reopened.deleteThread("session_fork")
      expect((await reopened.readUsageSummary()).totals.inputTokens).toBe(72)
    } else {
      await store.deleteThread("session_fork")
      expect((await store.readUsageSummary()).totals.inputTokens).toBe(72)
    }
  })
})

function metadata(id: string): CreateThreadMetadata {
  return {
    id,
    conversationId: id,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
  }
}

function turn(
  name: string,
  inputTokens: number,
  outputTokens: number,
): readonly RolloutItem[] {
  const turnId = `turn_${name}`
  const selection = { provider: "faux", model: name }
  return [
    { type: "turn_started", turnId, inputItemId: `input_${name}` },
    {
      type: "turn_context",
      context: {
        turnId,
        selection,
        configuration: SessionConfiguration.create({
          selection,
          workspaceRoot: "/workspace",
          enabledTools: [],
          approvalPolicy: "always_approve",
          promptCacheKey: turnId,
        }).snapshot,
      },
    },
    {
      type: "response_item",
      item: {
        id: `input_${name}`,
        turnId,
        createdAt: "2026-11-12T00:00:00.000Z",
        item: {
          role: "user",
          content: [{ type: "text", text: name }],
        },
      },
    },
    {
      type: "turn_usage",
      turnId,
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      type: "turn_completed",
      turnId,
      outcome: "completed",
      usage: { inputTokens, outputTokens },
    },
  ]
}

function titleUsage(requestId: string, inputTokens: number): RolloutItem {
  return {
    type: "auxiliary_usage",
    source: "session_title",
    requestId,
    occurredAt: "2026-11-12T00:00:00.000Z",
    provider: "faux",
    model: "title",
    usage: { inputTokens, outputTokens: 1 },
  }
}
