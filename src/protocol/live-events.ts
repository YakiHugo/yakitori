import type {
  EventMetadata,
  StartedExecutionItem,
  TokenUsage,
  TurnOutcome,
} from "./events.ts"
import type { RuntimePermissionEvent } from "./permission-events.ts"

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
