import { describe, expect, it } from "vitest"
import type {
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
} from "../../src/core/rollout.ts"
import {
  SqliteThreadUsageProjection,
  type ThreadUsageProjectionStamp,
} from "../../src/core/sqlite-thread-usage-projection.ts"

const stamp: ThreadUsageProjectionStamp = {
  metadataSize: 1,
  metadataMtimeMs: 1,
  rolloutSize: 1,
  rolloutMtimeMs: 1,
}

describe("thread usage projection", () => {
  it("aggregates totals, days, and per-thread rows from turn completions", () => {
    const projection = new SqliteThreadUsageProjection(":memory:")
    projection.rebuild(
      thread("session_a", "first session", [
        turnContext("turn_1", "codex", "gpt-6"),
        turnCompleted("turn_1", "2026-09-20T10:00:00.000Z", {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 60,
        }),
        turnContext("turn_2", "codex", "gpt-6"),
        turnCompleted("turn_2", "2026-09-21T09:00:00.000Z", {
          inputTokens: 300,
          outputTokens: 100,
        }),
      ]),
      stamp,
    )
    projection.rebuild(
      thread("session_b", "second session", [
        turnContext("turn_1", "anthropic", "claude-sonnet"),
        turnCompleted("turn_1", "2026-09-21T11:00:00.000Z", {
          inputTokens: 50,
          outputTokens: 20,
          cacheWriteInputTokens: 10,
        }),
      ]),
      stamp,
    )

    const usage = projection.readUsage()
    expect(usage.totals).toEqual({
      turns: 3,
      inputTokens: 450,
      outputTokens: 160,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 10,
    })
    expect(usage.days).toEqual([
      {
        date: "2026-09-20",
        turns: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 60,
        cacheWriteInputTokens: 0,
      },
      {
        date: "2026-09-21",
        turns: 2,
        inputTokens: 350,
        outputTokens: 120,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 10,
      },
    ])
    expect(
      usage.threads.map((row) => ({
        threadId: row.threadId,
        title: row.title,
        turns: row.turns,
        totalTokens: row.totalTokens,
      })),
    ).toEqual([
      {
        threadId: "session_a",
        title: "first session",
        turns: 2,
        totalTokens: 540,
      },
      {
        threadId: "session_b",
        title: "second session",
        turns: 1,
        totalTokens: 70,
      },
    ])

    projection.delete("session_a")
    expect(projection.readUsage().totals.turns).toBe(1)
  })

  it("tracks currency by file stamp and skips turns without usage", () => {
    const projection = new SqliteThreadUsageProjection(":memory:")
    const stored = thread("session_a", "t", [
      turnCompleted("turn_1", "2026-09-20T10:00:00.000Z", undefined),
    ])
    expect(projection.isCurrent("session_a", stamp)).toBe(false)
    projection.rebuild(stored, stamp)
    expect(projection.isCurrent("session_a", stamp)).toBe(true)
    expect(
      projection.isCurrent("session_a", { ...stamp, rolloutSize: 2 }),
    ).toBe(false)
    expect(projection.readUsage().totals.turns).toBe(0)
  })
})

function thread(
  id: string,
  title: string,
  items: readonly StoredRolloutItem[],
): StoredThread {
  const metadata: ThreadMetadata = {
    id,
    rolloutId: id,
    conversationId: `conversation_${id}`,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    title,
  }
  return {
    metadata,
    rollout: items.map((item) => ({ ...item, threadId: id, rolloutId: id })),
  }
}

let seq = 0

function turnContext(turnId: string, provider: string, model: string) {
  seq += 1
  return {
    seq,
    threadId: "",
    rolloutId: "",
    createdAt: "2026-09-20T10:00:00.000Z",
    item: {
      type: "turn_context" as const,
      context: {
        turnId,
        selection: { provider, model },
        configuration: {} as never,
      },
    },
  } satisfies StoredRolloutItem
}

function turnCompleted(
  turnId: string,
  createdAt: string,
  usage:
    | Readonly<{
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens?: number
        cacheWriteInputTokens?: number
      }>
    | undefined,
) {
  seq += 1
  return {
    seq,
    threadId: "",
    rolloutId: "",
    createdAt,
    item: {
      type: "turn_completed" as const,
      turnId,
      outcome: "completed" as const,
      ...(usage === undefined ? {} : { usage }),
    },
  } satisfies StoredRolloutItem
}
