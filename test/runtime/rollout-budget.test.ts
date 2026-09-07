import { describe, expect, it } from "vitest"
import {
  RolloutBudget,
  RolloutBudgetExceededError,
} from "../../src/runtime/rollout-budget.ts"

describe("root-tree rollout budget", () => {
  it("charges uncached input and output, or authoritative provider units", () => {
    const budget = new RolloutBudget({
      limitTokens: 100,
      reminderAtRemainingTokens: [50],
      prefillTokenWeight: 0.5,
      samplingTokenWeight: 2,
    })
    budget.recordUsage({
      inputTokens: 100,
      cacheReadInputTokens: 80,
      outputTokens: 10,
    })
    expect(budget.pendingReminder("root")?.remainingTokens).toBe(70)
    budget.recordUsage({
      inputTokens: 999,
      outputTokens: 999,
      rolloutBudgetUnits: 5.5,
    })
    expect(budget.pendingReminder("child")?.remainingTokens).toBe(64)
    expect(() => budget.recordUsage({ rolloutBudgetUnits: 64.5 })).toThrow(
      RolloutBudgetExceededError,
    )
    expect(() => budget.assertAvailable()).toThrow(RolloutBudgetExceededError)
  })

  it("delivers crossed thresholds independently to each thread and rearms after compaction", () => {
    const budget = new RolloutBudget({
      limitTokens: 100,
      reminderAtRemainingTokens: [50, 20],
      prefillTokenWeight: 1,
      samplingTokenWeight: 1,
    })
    const first = budget.pendingReminder("root")
    if (first === undefined) throw new Error("missing initial reminder")
    expect(budget.pendingReminder("root")).toEqual(first)
    budget.markDelivered("root", first)
    expect(budget.pendingReminder("root")).toBeUndefined()
    budget.recordUsage({ outputTokens: 60 })
    const rootReminder = budget.pendingReminder("root")
    if (rootReminder === undefined)
      throw new Error("missing threshold reminder")
    expect(rootReminder.remainingTokens).toBe(40)
    budget.markDelivered("root", rootReminder)
    expect(budget.pendingReminder("child")?.remainingTokens).toBe(40)
    budget.rearm("root")
    expect(budget.pendingReminder("root")?.remainingTokens).toBe(40)
  })

  it("has no implicit token quota when unconfigured", () => {
    const budget = new RolloutBudget()
    budget.recordUsage({ outputTokens: Number.MAX_SAFE_INTEGER })
    expect(() => budget.assertAvailable()).not.toThrow()
    expect(budget.pendingReminder("root")).toBeUndefined()
  })
})
