import type { AppSessionEventEnvelope } from "../../src/protocol/events.ts"
import type { SessionTurnsResponse } from "../../src/protocol/session-turns.ts"

export function turnHistoryFixture(
  events: readonly AppSessionEventEnvelope[],
  nextBefore?: number,
): SessionTurnsResponse {
  const end = events.at(-1)
  return {
    view: "summary",
    rolloutId: "rollout_original",
    seq: 100,
    ...(nextBefore === undefined ? {} : { nextBefore }),
    turns:
      end === undefined
        ? []
        : [
            {
              turnId: `turn_fixture_${end.seq}`,
              completionSeq: end.seq + 1,
              completedAt: end.createdAt,
              outcome: "completed",
              activityCount: 0,
              events,
            },
          ],
  }
}
