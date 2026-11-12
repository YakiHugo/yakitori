import { parseUserQuestions } from "../protocol/user-interaction.ts"
import type {
  RolloutItem,
  StoredRolloutItem,
  ThreadStatusProjection,
} from "./rollout.ts"

export function isSidebarStatusItem(item: RolloutItem): boolean {
  return (
    item.type === "turn_started" ||
    item.type === "turn_completed" ||
    (item.type === "item_completed" &&
      "toolCallId" in item.item &&
      item.item.name === "request_user_input_async") ||
    (item.type === "response_item" &&
      item.item.item.role === "user" &&
      typeof item.item.submissionMetadata?.metadata?.userQuestionId ===
        "string")
  )
}

// Shared by the durable summary projection and in-memory stores. Only persisted
// correlated answers dismiss questions, matching the transcript question cards.
export function advanceThreadStatus(
  previous: ThreadStatusProjection,
  records: readonly StoredRolloutItem[],
): ThreadStatusProjection {
  let latestTurnOutcome = previous.latestTurnOutcome
  let latestCompletionSeq = previous.latestCompletionSeq
  const unanswered = new Set(previous.unansweredQuestionIds)
  for (const { item, seq } of records) {
    if (item.type === "turn_started") {
      latestTurnOutcome = undefined
    } else if (item.type === "turn_completed") {
      latestTurnOutcome = item.outcome
      if (item.outcome === "completed") latestCompletionSeq = seq + 1
    } else if (
      item.type === "item_completed" &&
      "toolCallId" in item.item &&
      item.item.name === "request_user_input_async" &&
      item.item.error === undefined &&
      parseUserQuestions(item.item.output) !== undefined
    ) {
      unanswered.add(item.item.toolCallId)
    } else if (
      item.type === "response_item" &&
      item.item.item.role === "user"
    ) {
      const questionId = item.item.submissionMetadata?.metadata?.userQuestionId
      if (typeof questionId === "string") unanswered.delete(questionId)
    }
  }
  return {
    ...(latestTurnOutcome === undefined ? {} : { latestTurnOutcome }),
    ...(latestCompletionSeq === undefined ? {} : { latestCompletionSeq }),
    ...(unanswered.size === 0
      ? {}
      : { unansweredQuestionIds: [...unanswered] }),
  }
}
