import type { ModelToolContentBlock } from "./conversation.ts"
import type {
  TokenUsage,
  ToolExecutionItem,
  TurnMetrics,
  TurnOutcome,
} from "./events.ts"
import type { ContextExcerpt } from "./input-context.ts"
import type { ModelFailureKind } from "./model-failure.ts"
import type { ModelOutputPresentation } from "./model-output.ts"
import type { InputDraft } from "./user-input.ts"

export type CitationSource = Readonly<{
  id: string
  label: string
  url?: string
  location?: string
}>

export type ExecutionEntry =
  | Readonly<{
      kind: "agent_input"
      inputId: string
      requestId: string
      sourceSessionId?: string
      steered?: boolean
      text: string
      at: string
    }>
  | {
      readonly kind: "user_input"
      readonly contextAttachments?: readonly ContextExcerpt[]
      readonly inputId: string
      readonly requestId?: string
      readonly questionId?: string
      readonly steered?: boolean
      readonly text: string
      readonly content: InputDraft
      readonly at: string
    }
  | {
      readonly kind: "assistant"
      readonly source?: ModelOutputPresentation["source"]
      readonly purpose?: ModelOutputPresentation["purpose"]
      readonly sources?: readonly CitationSource[]
      readonly itemId: string
      readonly turnId: string
      readonly text: string
      readonly status: "streaming" | "suspended" | "partial" | "completed"
      readonly streamId?: string
      readonly textOffset?: number
      readonly incomplete?: boolean
      readonly at: string
    }
  | {
      readonly kind: "reasoning"
      readonly source?: ModelOutputPresentation["source"]
      readonly representation?: "summary"
      readonly itemId: string
      readonly turnId: string
      readonly text: string
      readonly status: "streaming" | "suspended" | "partial" | "completed"
      readonly streamId?: string
      readonly textOffset?: number
      readonly incomplete?: boolean
      readonly at: string
    }
  | {
      readonly kind: "tool"
      readonly toolCallId: string
      readonly turnId: string
      readonly execution: ToolExecutionItem
      readonly state: string
      readonly output?: unknown
      readonly resultContent?: readonly ModelToolContentBlock[]
      readonly resultText?: string
      readonly resultError?: boolean
      readonly resultErrorMessage?: string
    }
  | {
      readonly kind: "permission"
      readonly permissionRequestId: string
      readonly turnId: string
      readonly toolCallId: string
      readonly action: string
      readonly subject?: string
      readonly reason?: string
      readonly state: "requested" | "resolving" | "resolved"
      readonly behavior?: string
    }
  | {
      readonly kind: "turn_terminal"
      readonly turnId: string
      readonly state:
        | "failed"
        | "cancelled"
        | "interrupted"
        | "truncated"
        | "refused"
      readonly message: string
    }

export type ToolDiff = { readonly text: string; readonly truncated: boolean }

export type SessionTelemetry = {
  readonly turns: number
  readonly steps: number
  readonly modelDurationMs: number
  readonly toolDurationMs: number
  readonly averageTimeToFirstTokenMs?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheWriteInputTokens: number
}

export type ActiveTurnActivity =
  | { readonly kind: "reasoning" }
  | { readonly kind: "responding" }
  | { readonly kind: "waiting_permission"; readonly action: string }
  | { readonly kind: "running_tool"; readonly name: string }
  | { readonly kind: "compacting" }

export type ActiveModelRetry = Readonly<{
  turnId: string
  kind: ModelFailureKind
  nextAttempt: number
  maxAttempts?: number
  delayMs: number
  message: string
}>

export type TurnTiming = Readonly<{
  inputId?: string
  startedAt?: string
  completedAt?: string
  outcome?: TurnOutcome
}>

// Latest model-reported context window sample. `capacityTokens` is the
// effective window of the model that produced the sample, so the pair stays
// consistent across model switches; pre-capacity records fall back to the
// selected model's catalog capacity when provider/model match.
export type ContextTokens = Readonly<{
  activeContextTokens: number
  capacityTokens?: number
  provider?: string
  model?: string
}>

export type TurnActivityPage = number | "unloaded" | "loaded"

export type ExecutionView = Readonly<{
  deferredTurnActivity?: Readonly<Record<string, TurnActivityPage>>
  turnTimings: Readonly<Record<string, TurnTiming>>
  entries: readonly ExecutionEntry[]
  activeTurnId?: string
  mateId?: string
  mateRevisionId?: string
  workingDirectory?: string
  queuedInputIds: readonly string[]
  pendingQuestionIds: readonly string[]
  lastModel?: { readonly provider: string; readonly model: string }
  lastTurnUsage?: TokenUsage
  lastTurnMetrics?: TurnMetrics
  contextTokens?: ContextTokens
  telemetry: SessionTelemetry
  activeTurnStartedAt?: string
  activeActivity?: ActiveTurnActivity
  activeRetry?: ActiveModelRetry
}>
