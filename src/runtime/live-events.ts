import type { StartedExecutionItem, TokenUsage } from "../kernel/events.ts"
import type { RuntimePermissionEvent } from "./permission-gate.ts"

export type LiveAssistantDelta = {
  readonly type: "assistant.delta"
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly delta: string
  readonly createdAt: string
}

export type LiveReasoningDelta = {
  readonly type: "reasoning.delta"
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
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

export type LiveSessionError = {
  readonly type: "session.error"
  readonly sessionId: string
  readonly operation: "turn_input" | "interrupt" | "persistence"
  readonly message: string
  readonly createdAt: string
}

export type LiveRuntimeWarning = {
  readonly type: "runtime.warning"
  readonly sessionId: string
  readonly turnId: string
  readonly message: string
  readonly createdAt: string
}

export type LiveSessionEvent =
  | LiveDisplayItemStarted
  | LiveAssistantDelta
  | LiveReasoningDelta
  | LiveSessionUsage
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
    readonly text: string
  }): void
  flush(): void
}

export function suffixDelta(
  previous: string,
  next: string,
): string | undefined {
  if (next === previous || !next.startsWith(previous)) return undefined
  const delta = next.slice(previous.length)
  return delta.length === 0 ? undefined : delta
}

// Providers emit cumulative snapshots. Convert them to suffixes and coalesce
// UI publications without making unfinished model output part of Session
// history. flush() is the in-process barrier used before a terminal Turn event.
export function createCoalescingDeltaPublisher(
  publisher: LiveEventPublisher,
  publicationsPerSecond: number,
  type:
    | LiveAssistantDelta["type"]
    | LiveReasoningDelta["type"] = "assistant.delta",
): DeltaPublisher {
  const minIntervalMs = Math.max(1, Math.floor(1000 / publicationsPerSecond))
  let previousText = ""
  let pending:
    | {
        readonly sessionId: string
        readonly turnId: string
        readonly itemId: string
        readonly delta: string
      }
    | undefined
  let lastPublishedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const publishNow = (input: NonNullable<typeof pending>): void => {
    lastPublishedAt = Date.now()
    publisher.publishTransient({
      type,
      ...input,
      createdAt: new Date().toISOString(),
    })
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
      const delta = suffixDelta(previousText, input.text)
      if (delta === undefined) return
      previousText = input.text

      const now = Date.now()
      if (now - lastPublishedAt >= minIntervalMs) {
        if (pending === undefined) {
          publishNow({ ...input, delta })
        } else {
          pending = { ...input, delta: `${pending.delta}${delta}` }
          flushPending()
        }
        return
      }

      pending =
        pending === undefined
          ? { ...input, delta }
          : { ...input, delta: `${pending.delta}${delta}` }
      if (timer !== undefined) return
      timer = setTimeout(
        () => flushPending(),
        minIntervalMs - (now - lastPublishedAt),
      )
    },
    flush: flushPending,
  }
}
