import type {
  LiveAssistantDelta,
  LiveReasoningDelta,
  LiveSessionEvent,
} from "../protocol/live-events.ts"

export type {
  LiveAssistantDelta,
  LiveDisplayItemDiscarded,
  LiveDisplayItemStarted,
  LiveReasoningDelta,
  LiveRuntimeWarning,
  LiveSessionError,
  LiveSessionEvent,
  LiveSessionUsage,
  LiveTurnFinished,
} from "../protocol/live-events.ts"

export type LiveEventPublisher = {
  publishTransient(event: LiveSessionEvent): void
}

export type DeltaPublisher = {
  publish(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly itemId: string
    readonly delta: string
  }): void
  flush(): void
}

// Coalesce provider deltas for UI publication without making unfinished model
// output part of Session history. flush() is the in-process ordering barrier.
export function createCoalescingDeltaPublisher(
  publisher: LiveEventPublisher,
  publicationsPerSecond: number,
  type:
    | LiveAssistantDelta["type"]
    | LiveReasoningDelta["type"] = "assistant.delta",
): DeltaPublisher {
  const minIntervalMs = Math.max(1, Math.floor(1000 / publicationsPerSecond))
  let pending:
    | {
        readonly sessionId: string
        readonly turnId: string
        readonly itemId: string
        readonly deltas: string[]
      }
    | undefined
  const streamId = crypto.randomUUID()
  let offset = 0
  let lastPublishedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const publishNow = (input: NonNullable<typeof pending>): void => {
    lastPublishedAt = Date.now()
    const delta = input.deltas.join("")
    publisher.publishTransient({
      type,
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId: input.itemId,
      streamId,
      offset,
      delta,
      createdAt: new Date().toISOString(),
    })
    offset += delta.length
  }

  const flushPending = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending === undefined) return
    const next = pending
    pending = undefined
    publishNow(next)
  }

  return {
    publish(input) {
      if (input.delta === "") return

      const now = Date.now()
      if (now - lastPublishedAt >= minIntervalMs) {
        if (pending === undefined) {
          publishNow({ ...input, deltas: [input.delta] })
        } else {
          pending.deltas.push(input.delta)
          flushPending()
        }
        return
      }

      if (pending === undefined) pending = { ...input, deltas: [input.delta] }
      else pending.deltas.push(input.delta)
      if (timer !== undefined) return
      timer = setTimeout(
        () => flushPending(),
        minIntervalMs - (now - lastPublishedAt),
      )
    },
    flush: flushPending,
  }
}
