import type { ModelUsage } from "./model.ts"

export type RolloutBudgetConfig = Readonly<{
  limitTokens: number
  reminderAtRemainingTokens: readonly number[]
  samplingTokenWeight: number
  prefillTokenWeight: number
}>

export type RolloutBudgetReminder = Readonly<{
  remainingTokens: number
  index: number
}>

export class RolloutBudgetExceededError extends Error {
  constructor() {
    super("Session rollout token budget exceeded.")
    this.name = "RolloutBudgetExceededError"
  }
}

// Codex shares accounting across the live root tree. A fresh process starts a
// new budget; this is optional execution policy, not a persisted billing ledger.
export class RolloutBudget {
  #used = 0
  #deliveries = new Map<string, RolloutBudgetReminder>()
  private config: RolloutBudgetConfig | undefined

  constructor(config?: RolloutBudgetConfig) {
    this.config = config
  }

  assertAvailable(): void {
    if (this.config !== undefined && this.#used >= this.config.limitTokens) {
      throw new RolloutBudgetExceededError()
    }
  }

  recordUsage(usage: ModelUsage): void {
    if (this.config === undefined) return
    const units =
      usage.rolloutBudgetUnits ??
      Math.max(0, usage.outputTokens ?? 0) * this.config.samplingTokenWeight +
        Math.max(
          0,
          (usage.inputTokens ?? 0) - (usage.cacheReadInputTokens ?? 0),
        ) *
          this.config.prefillTokenWeight
    if (!Number.isFinite(units) || units < 0) {
      throw new Error("Rollout budget units must be finite and non-negative.")
    }
    this.#used += units
    this.assertAvailable()
  }

  pendingReminder(threadId: string): RolloutBudgetReminder | undefined {
    if (this.config === undefined) return undefined
    const remainingTokens = Math.floor(
      Math.max(0, this.config.limitTokens - this.#used),
    )
    const index = this.config.reminderAtRemainingTokens.filter(
      (threshold) => remainingTokens <= threshold,
    ).length
    const previous = this.#deliveries.get(threadId)
    if (previous !== undefined && previous.index >= index) return undefined
    return { remainingTokens, index }
  }

  markDelivered(threadId: string, reminder: RolloutBudgetReminder): void {
    this.#deliveries.set(threadId, reminder)
  }

  rearm(threadId: string): void {
    this.#deliveries.delete(threadId)
  }
}
