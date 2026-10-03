import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { GoalStatus, type ThreadGoal } from "../../src/core/goal.ts"
import { SqliteGoalStore } from "../../src/core/sqlite-goal-store.ts"

const roots: string[] = []
const stores: SqliteGoalStore[] = []
const startedAt = "2026-10-03T00:00:00.000Z"
const later = "2026-10-03T00:00:10.000Z"

function openStore(path = ":memory:"): SqliteGoalStore {
  const store = new SqliteGoalStore(path)
  stores.push(store)
  return store
}

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    id: "goal_original",
    threadId: "thread_original",
    objective: "Finish the requested feature",
    status: GoalStatus.Active,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...overrides,
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("SqliteGoalStore", () => {
  it("persists the current goal and continuation deferral across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-goal-"))
    roots.push(root)
    const path = join(root, "goals.sqlite")
    const first = openStore(path)
    const initial = goal({ tokenBudget: 100, inputId: "input_original" })
    first.save(initial)
    first.setContinuationDeferred(initial.threadId, true)
    first.account(initial.threadId, initial.id, "usage_1", 40, 3, later)
    first.close()

    const resumed = openStore(path)
    expect(resumed.read(initial.threadId)).toEqual({
      ...initial,
      tokensUsed: 40,
      timeUsedSeconds: 3,
      updatedAt: later,
    })
    expect(resumed.isContinuationDeferred(initial.threadId)).toBe(true)
    expect(
      resumed.account(initial.threadId, initial.id, "usage_1", 40, 3, later)
        ?.tokensUsed,
    ).toBe(40)
    resumed.setContinuationDeferred(initial.threadId, false)
    expect(resumed.isContinuationDeferred(initial.threadId)).toBe(false)
  })

  it("charges each event once across independent connections and retains receipts when editing", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-goal-"))
    roots.push(root)
    const path = join(root, "goals.sqlite")
    const first = openStore(path)
    const second = openStore(path)
    const initial = goal()
    first.save(initial)
    first.account(initial.threadId, initial.id, "usage_1", 12, 4, later)
    second.account(initial.threadId, initial.id, "usage_1", 12, 4, later)
    const current = second.read(initial.threadId)
    expect(current).toEqual({
      ...initial,
      tokensUsed: 12,
      timeUsedSeconds: 4,
      updatedAt: later,
    })
    if (current === undefined) throw new Error("Expected the persisted goal.")
    second.save({ ...current, objective: "Finish the clarified feature" })
    first.account(initial.threadId, initial.id, "usage_1", 12, 4, later)
    first.account(initial.threadId, initial.id, "usage_2", 8, 2, later)
    expect(second.read(initial.threadId)).toEqual({
      ...initial,
      objective: "Finish the clarified feature",
      tokensUsed: 20,
      timeUsedSeconds: 6,
      updatedAt: later,
    })
  })

  it("atomically marks a spent budget and charges the current turn's wrap-up", () => {
    const store = openStore()
    const initial = goal({ tokenBudget: 20 })
    store.save(initial)
    expect(
      store.account(initial.threadId, initial.id, "usage_1", 19, 2, later)
        ?.status,
    ).toBe(GoalStatus.Active)
    expect(
      store.account(initial.threadId, initial.id, "usage_2", 1, 1, later),
    ).toEqual({
      ...initial,
      tokensUsed: 20,
      timeUsedSeconds: 3,
      updatedAt: later,
      status: GoalStatus.BudgetLimited,
    })
    expect(
      store.account(initial.threadId, initial.id, "wrap_up", 7, 1, later),
    ).toEqual({
      ...initial,
      tokensUsed: 27,
      timeUsedSeconds: 4,
      updatedAt: later,
      status: GoalStatus.BudgetLimited,
    })
  })

  it("does not charge stopped goals or attribute an old goal's usage to a replacement", () => {
    const store = openStore()
    for (const status of [
      GoalStatus.Paused,
      GoalStatus.Blocked,
      GoalStatus.UsageLimited,
      GoalStatus.Complete,
    ]) {
      const stopped = goal({ status })
      store.save(stopped)
      expect(
        store.account(
          stopped.threadId,
          stopped.id,
          "not_running",
          10,
          2,
          later,
        ),
      ).toEqual(stopped)
    }
    const replacement = goal({ id: "goal_replacement" })
    store.save(replacement)
    expect(
      store.account(
        replacement.threadId,
        "goal_original",
        "late_usage",
        10,
        2,
        later,
      ),
    ).toBeUndefined()
    expect(store.read(replacement.threadId)).toEqual(replacement)
    expect(
      store.account(
        replacement.threadId,
        replacement.id,
        "not_running",
        3,
        1,
        later,
      )?.tokensUsed,
    ).toBe(3)
  })

  it("rolls back both a failed accounting update and its receipt", () => {
    const store = openStore()
    const initial = goal({ tokensUsed: Number.MAX_SAFE_INTEGER - 1 })
    store.save(initial)
    expect(() =>
      store.account(initial.threadId, initial.id, "overflow", 2, 0, later),
    ).toThrow("safe integer")
    expect(store.read(initial.threadId)).toEqual(initial)
    expect(
      store.account(initial.threadId, initial.id, "overflow", 1, 0, later)
        ?.tokensUsed,
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("forks an independent snapshot that defers continuation until explicitly released", () => {
    const store = openStore()
    const initial = goal({
      tokensUsed: 10,
      timeUsedSeconds: 5,
      tokenBudget: 100,
      inputId: "input_original",
    })
    store.save(initial)
    const fork = store.fork(initial.threadId, "thread_fork", later)
    expect(fork).toEqual({
      ...initial,
      id: expect.stringMatching(/^goal_/),
      threadId: "thread_fork",
      createdAt: later,
      updatedAt: later,
    })
    expect(fork?.id).not.toBe(initial.id)
    expect(store.isContinuationDeferred("thread_fork")).toBe(true)
    expect(store.isContinuationDeferred(initial.threadId)).toBe(false)
    expect(store.read(initial.threadId)).toEqual(initial)
    if (fork === undefined) throw new Error("Expected a forked goal.")
    store.account("thread_fork", fork.id, "fork_usage", 4, 2, later)
    expect(store.read("thread_fork")?.tokensUsed).toBe(14)
    expect(store.read(initial.threadId)?.tokensUsed).toBe(10)
    expect(store.fork("missing", "unused", later)).toBeUndefined()
  })

  it("clears receipts and deferrals with the goal, including replacement", () => {
    const store = openStore()
    const initial = goal()
    store.save(initial)
    store.account(initial.threadId, initial.id, "usage_1", 9, 1, later)
    store.setContinuationDeferred(initial.threadId, true)
    store.save(goal({ id: "goal_next" }))
    expect(store.isContinuationDeferred(initial.threadId)).toBe(false)
    store.setContinuationDeferred(initial.threadId, true)
    store.delete(initial.threadId)
    expect(store.read(initial.threadId)).toBeUndefined()
    expect(store.isContinuationDeferred(initial.threadId)).toBe(false)
    store.save(initial)
    expect(
      store.account(initial.threadId, initial.id, "usage_1", 2, 1, later)
        ?.tokensUsed,
    ).toBe(2)
  })
})
