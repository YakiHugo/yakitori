export const GoalStatus = {
  Active: "active",
  Paused: "paused",
  Blocked: "blocked",
  UsageLimited: "usage_limited",
  BudgetLimited: "budget_limited",
  Complete: "complete",
} as const
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus]

export function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === GoalStatus.Active ||
    value === GoalStatus.Paused ||
    value === GoalStatus.Blocked ||
    value === GoalStatus.UsageLimited ||
    value === GoalStatus.BudgetLimited ||
    value === GoalStatus.Complete
  )
}

// The composer bar ticks while the goal is active. Paused and stopped goals
// keep the seconds already accumulated.
export function goalElapsedSeconds(input: {
  readonly status?: GoalStatus
  readonly updatedAt?: string
  readonly timeUsedSeconds?: number
  readonly now: number
}): number {
  const base =
    input.timeUsedSeconds !== undefined && input.timeUsedSeconds >= 0
      ? input.timeUsedSeconds
      : 0
  if (input.status !== undefined && input.status !== GoalStatus.Active)
    return base
  if (input.updatedAt === undefined) return base
  const updated = Date.parse(input.updatedAt)
  if (!Number.isFinite(updated)) return base
  return base + Math.max(0, Math.floor((input.now - updated) / 1000))
}
