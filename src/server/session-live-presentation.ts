import type { SessionEvent } from "../core/session-io.ts"
import type { LiveSessionEvent } from "../protocol/live-events.ts"
import { createCoalescingDeltaPublisher } from "../runtime/live-events.ts"

// Both persisted sessions and ephemeral conversations present the same runtime
// events. Storage, permissions and lifetime remain owned by their callers.
export function createSessionLivePresentation(
  publishTransient: (event: LiveSessionEvent) => void,
) {
  const streams = new Map<
    string,
    ReturnType<typeof createCoalescingDeltaPublisher>
  >()
  const flush = () => {
    for (const publisher of streams.values()) publisher.flush()
  }
  const discard = (
    threadId: string,
    turnId: string,
    itemIds: readonly string[],
  ) => {
    flush()
    for (const itemId of itemIds) {
      streams.delete(itemId)
      publishTransient({
        type: "item.discarded",
        sessionId: threadId,
        turnId,
        itemId,
        createdAt: new Date().toISOString(),
      })
    }
  }
  return {
    flush,
    publish(event: SessionEvent) {
      if (event.type === "rollout.appended") {
        flush()
        return
      }
      if (event.type === "model.stream") {
        const reasoning = event.kind === "reasoning"
        let publisher = streams.get(event.itemId)
        if (publisher === undefined) {
          publishTransient({
            type: "item.started",
            sessionId: event.threadId,
            turnId: event.turnId,
            item: {
              type: reasoning ? "reasoning" : "agent_message",
              itemId: event.itemId,
              ...(event.source === undefined ? {} : { source: event.source }),
              ...(event.purpose === undefined
                ? {}
                : { purpose: event.purpose }),
              ...(event.representation === undefined
                ? {}
                : { representation: event.representation }),
            },
            createdAt: new Date().toISOString(),
          })
          publisher = createCoalescingDeltaPublisher(
            { publishTransient },
            30,
            reasoning ? "reasoning.delta" : "assistant.delta",
          )
          streams.set(event.itemId, publisher)
        }
        publisher.publish({
          sessionId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
          ...(event.source === undefined ? {} : { source: event.source }),
          ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
          ...(event.representation === undefined
            ? {}
            : { representation: event.representation }),
        })
      } else if (event.type === "model.output_discarded") {
        discard(event.threadId, event.turnId, event.itemIds)
      } else if (event.type === "item.started") {
        publishTransient({
          type: "item.started",
          sessionId: event.threadId,
          turnId: event.turnId,
          item: event.item,
          createdAt: new Date().toISOString(),
        })
      } else if (event.type === "permission") {
        publishTransient(event.event)
      } else if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        flush()
        streams.clear()
        publishTransient({
          type: "turn.finished",
          sessionId: event.threadId,
          turnId: event.input.submissionId,
          outcome:
            event.type === "turn.failed"
              ? { status: "failed", error: event.error }
              : event.type === "turn.interrupted"
                ? {
                    status: "interrupted",
                    ...(event.reason === undefined
                      ? {}
                      : { reason: event.reason }),
                  }
                : { status: "completed", ...event.completion },
          createdAt: new Date().toISOString(),
        })
      } else if (event.type === "session.error") {
        publishTransient({
          type: "session.error",
          sessionId: event.threadId,
          operation: event.operation,
          message: event.message,
          createdAt: new Date().toISOString(),
        })
      } else if (event.type === "runtime.warning") {
        if (event.code === "model.retry") {
          const ids = event.details?.discardedResponseItemIds
          discard(
            event.threadId,
            event.turnId,
            Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === "string")
              : [],
          )
        }
        publishTransient({
          type: "runtime.warning",
          sessionId: event.threadId,
          turnId: event.turnId,
          message: event.message,
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.details === undefined ? {} : { details: event.details }),
          createdAt: new Date().toISOString(),
        })
      }
    },
  }
}
