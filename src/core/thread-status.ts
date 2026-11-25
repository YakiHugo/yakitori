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
  let activeTurnId = previous.activeTurnId
  let latestTurnOutcome = previous.latestTurnOutcome
  let latestCompletionSeq = previous.latestCompletionSeq
  const displayCounts = {
    ...(previous.displayCounts ?? { inputs: 0, turns: 0, items: 0, tools: 0 }),
  }
  for (const { item, seq } of records) {
    if (item.type === "turn_started") {
      activeTurnId = item.turnId
      latestTurnOutcome = undefined
      displayCounts.turns++
    } else if (item.type === "turn_completed") {
      if (activeTurnId === item.turnId) activeTurnId = undefined
      latestTurnOutcome = item.outcome
      if (item.outcome === "completed") latestCompletionSeq = seq + 1
    } else if (item.type === "item_completed") {
      displayCounts.items++
      if (
        item.item.type !== "agent_message" &&
        item.item.type !== "reasoning" &&
        item.item.type !== "context_compaction"
      )
        displayCounts.tools++
    } else if (
      item.type === "response_item" &&
      item.item.item.role === "user" &&
      item.item.id.startsWith("input_") &&
      item.item.item.context === undefined
    ) {
      displayCounts.inputs++
    }
  }
  return {
    displayCounts,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    ...(latestTurnOutcome === undefined ? {} : { latestTurnOutcome }),
    ...(latestCompletionSeq === undefined ? {} : { latestCompletionSeq }),
  }
}
