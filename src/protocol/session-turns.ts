import type { AppSessionEventEnvelope, ModelSelection } from "./events.ts"
import type { ContextTokens } from "./execution-view.ts"
import type { SessionCacheExpiry } from "./session-cache-expiry.ts"

export type SessionTurnsParams = Readonly<{
  sessionId: string
  rolloutId?: string
  view: "outline" | "summary"
  // Exclusive completion sequences. Both cursors require their rolloutId.
  before?: number
  after?: number
  // Inclusive display watermark captured by a live subscription.
  through?: number
  // The active Turn at that watermark, if the live snapshot had one.
  activeTurnId?: string
  aroundTurnId?: string
  limit?: number
}>

export type SessionActiveTurn = Readonly<{
  turnId: string
  events: readonly AppSessionEventEnvelope[]
  activityBefore?: number
}>

export type SessionTurnOutline = Readonly<{
  turnId: string
  completionSeq: number
  completedAt: string
  startedAt?: string
  inputId?: string
  outcome: "completed" | "failed" | "interrupted"
  activityCount: number
}>

export type SessionTurnSummary = SessionTurnOutline &
  Readonly<{
    // Display events scoped to this Turn, in ascending sequence order.
    events: readonly AppSessionEventEnvelope[]
  }>

type SessionTurnsState = Readonly<{
  rolloutId: string
  seq: number
  nextBefore?: number
  nextAfter?: number
  latestCompletionSeq?: number
  currentModel?: ModelSelection
  contextTokens?: ContextTokens
  cacheExpiry?: SessionCacheExpiry
}>

export type SessionTurnsResponse = SessionTurnsState &
  (
    | Readonly<{ view: "outline"; turns: readonly SessionTurnOutline[] }>
    | Readonly<{
        view: "summary"
        turns: readonly SessionTurnSummary[]
        activeTurn?: SessionActiveTurn
      }>
  )
