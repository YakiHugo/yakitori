import { GoalStatus } from "../protocol/goal.ts"

export { GoalStatus, type ThreadGoal } from "../protocol/goal.ts"

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
