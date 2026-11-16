import type {
  RolloutItem,
  StoredRolloutItem,
  ThreadStatusProjection,
} from "./rollout.ts"

export function isSidebarStatusItem(item: RolloutItem): boolean {
  return item.type === "turn_started" || item.type === "turn_completed"
}

export function advanceThreadStatus(
  previous: ThreadStatusProjection,
  records: readonly StoredRolloutItem[],
): ThreadStatusProjection {
  let latestTurnOutcome = previous.latestTurnOutcome
  let latestCompletionSeq = previous.latestCompletionSeq
  for (const { item, seq } of records) {
    if (item.type === "turn_started") {
      latestTurnOutcome = undefined
    } else if (item.type === "turn_completed") {
      latestTurnOutcome = item.outcome
      if (item.outcome === "completed") latestCompletionSeq = seq + 1
    }
  }
  return {
    ...(latestTurnOutcome === undefined ? {} : { latestTurnOutcome }),
    ...(latestCompletionSeq === undefined ? {} : { latestCompletionSeq }),
  }
}
