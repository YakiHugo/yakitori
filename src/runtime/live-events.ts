import type {
  EventMetadata,
  StartedExecutionItem,
  TokenUsage,
  TurnOutcome,
} from "../kernel/events.ts"
import type { RuntimePermissionEvent } from "./permission-gate.ts"

export type LiveAssistantDelta = {
  readonly type: "assistant.delta"
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly streamId: string
  /** Set only on the subscription recovery copy, never persisted. */
  readonly snapshot?: true
  /** UTF-16 offset of this chunk within the display item. */
  readonly offset: number
  readonly delta: string
  readonly createdAt: string
}

export type LiveReasoningDelta = {
  readonly type: "reasoning.delta"
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly streamId: string
  /** Set only on the subscription recovery copy, never persisted. */
  readonly snapshot?: true
  /** UTF-16 offset of this chunk within the display item. */
  readonly offset: number
  readonly delta: string
  readonly createdAt: string
}

export type LiveDisplayItemStarted = {
  readonly type: "item.started"
  readonly sessionId: string
  readonly turnId: string
  readonly item:
    | {
        readonly type: "agent_message"
        readonly itemId: string
      }
    | {
        readonly type: "reasoning"
        readonly itemId: string
      }
    | StartedExecutionItem
  readonly createdAt: string
}

export type LiveSessionUsage = {
  readonly type: "session.usage"
  readonly sessionId: string
  readonly turnId: string
  /** Whole cumulative snapshot. Clients replace rather than aggregate it. */
  readonly usage: TokenUsage
  readonly createdAt: string
}

export type LiveDisplayItemDiscarded = Readonly<{
  type: "item.discarded"
  sessionId: string
  turnId: string
  itemId: string
  createdAt: string
}>

export type LiveTurnFinished = Readonly<{
  type: "turn.finished"
  sessionId: string
  turnId: string
  outcome: TurnOutcome
  createdAt: string
}>

export type LiveSessionError = {
  readonly type: "session.error"
  readonly sessionId: string
  readonly operation: "turn_input" | "interrupt" | "persistence"
  readonly message: string
  readonly code?: string
  readonly details?: EventMetadata
  readonly createdAt: string
}

export type LiveRuntimeWarning = {
  readonly type: "runtime.warning"
  readonly sessionId: string
  readonly turnId: string
  readonly message: string
  readonly code?: string
  readonly details?: EventMetadata
  readonly createdAt: string
}

export type LiveSessionEvent =
  | LiveDisplayItemStarted
  | LiveDisplayItemDiscarded
  | LiveAssistantDelta
  | LiveReasoningDelta
  | LiveSessionUsage
  | LiveTurnFinished
  | LiveSessionError
  | LiveRuntimeWarning
  | RuntimePermissionEvent

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
