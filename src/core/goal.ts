export const GoalStatus = {
  Active: "active",
  Paused: "paused",
  Blocked: "blocked",
  UsageLimited: "usage_limited",
  BudgetLimited: "budget_limited",
  Complete: "complete",
} as const
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus]

export type ThreadGoal = Readonly<{
  id: string
  threadId: string
  objective: string
  status: GoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: string
  updatedAt: string
  inputId?: string
}>

export function createGoalId(): string {
  return `goal_${globalThis.crypto.randomUUID()}`
}

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
