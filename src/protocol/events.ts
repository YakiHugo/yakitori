import type { ImageAttachment } from "./asset-types.ts"
import type { ModelTextBlock, ModelToolContentBlock } from "./conversation.ts"
import type { ContextExcerpt } from "./input-context.ts"
import type { InputContent } from "./user-input.ts"
export const EventType = {
  SessionCreated: "session.created",
  InputAdmitted: "input.admitted",
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  ItemStarted: "item.started",
  ItemCompleted: "item.completed",
  ContextTokens: "context.tokens",
} as const

export const ForkReason = {
  Undo: "undo",
  Edit: "edit",
} as const

export type ForkReason = (typeof ForkReason)[keyof typeof ForkReason]
export const InputRole = {
  Runtime: "runtime",
  System: "system",
  User: "user",
} as const

export const ItemStatus = {
  Completed: "completed",
  Failed: "failed",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

export type InputRole = (typeof InputRole)[keyof typeof InputRole]

export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type EventMetadata = JsonObject

export type TextContent = Readonly<{
  kind: "text"
  text: string
  attachments?: readonly ImageAttachment[]
  contextAttachments?: readonly ContextExcerpt[]
}>

export type JsonContent = {
  readonly kind: "json"
  readonly value: JsonValue
}

export type ToolResultContent = Readonly<{
  kind: "tool_result"
  parts: readonly ModelToolContentBlock[]
}>

export type ItemContent = TextContent | JsonContent | ToolResultContent

export type KernelError = {
  readonly message: string
  readonly code?: string
  readonly details?: EventMetadata
}

export type TokenUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly activeContextTokens?: number
}

export type TurnLatency = Readonly<{
  // Durations from processor entry, excluding client transport and queue time.
  setupMs: number
  admissionMs?: number
  firstRequestMs?: number
  firstUsefulOutputMs?: number
  firstToolMs?: number
  warmupMs?: number
  warmupOverlapMs?: number
  backgroundCompactionMs: number
  backgroundCompactionOverlapMs: number
  backgroundCompactionsApplied: number
  backgroundCompactionsDiscarded: number
}>

export type TurnMetrics = {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly modelDurationMs: number
  readonly toolDurationMs: number
  readonly averageTimeToFirstTokenMs?: number
  readonly latency?: TurnLatency
}

export type ModelSelection = {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}

export type SessionCreatedEvent = {
  readonly type: typeof EventType.SessionCreated
  readonly data: {
    readonly title?: string
    readonly workingDirectory?: string
    readonly projectId?: string
    readonly mateId?: string
    readonly mateRevisionId?: string
    readonly conversationId?: string
    readonly parentSessionId?: string
    readonly forkedFromInputId?: string
    readonly forkReason?: ForkReason
    readonly historyBase?: SessionHistoryPosition
    readonly metadata?: EventMetadata
  }
}

export type SessionHistoryPosition = {
  readonly sessionId: string
  readonly endSeqExclusive: number
  readonly endByteOffset: number
}

export type InputAdmittedEvent = {
  readonly type: typeof EventType.InputAdmitted
  readonly data: {
    readonly requestId: string
    readonly inputId: string
    readonly role: InputRole
    readonly content: InputContent
    readonly modelSelection?: ModelSelection
    readonly parentInputId?: string
    readonly metadata?: EventMetadata
    // Steered inputs join an active Turn instead of starting one: they are
    // recorded when the Turn next samples and never occupy the input queue.
    readonly steered?: boolean
  }
}

export type TurnStartedEvent = {
  readonly type: typeof EventType.TurnStarted
  readonly data: {
    readonly turnId: string
    readonly inputId: string
    readonly parentTurnId?: string
    readonly metadata?: EventMetadata
  }
}

export type TurnCompletedEvent = {
  readonly type: typeof EventType.TurnCompleted
  readonly data: {
    readonly turnId: string
    readonly outcome: TurnOutcome
    readonly usage?: TokenUsage
    /** Cumulative Session usage at this durable Turn boundary. */
    readonly sessionUsage?: TokenUsage
    readonly metrics?: TurnMetrics
    readonly metadata?: EventMetadata
  }
}

// Sample of the model-visible context window taken after a model response,
// compaction, or an overflow. `capacityTokens` is the effective window of the
// model that produced the sample, so the pair stays self-consistent when the
// selected model later changes. Derived from rollout `token_count` records;
// clients replace their snapshot on each event rather than aggregating.
export type ContextTokensEvent = {
  readonly type: typeof EventType.ContextTokens
  readonly data: {
    readonly turnId: string
    readonly activeContextTokens: number
    readonly capacityTokens?: number
    readonly provider?: string
    readonly model?: string
  }
}

export type TurnCompletion = Readonly<{
  reason?: "truncated" | "refused"
  /** Final answer pieces in continuation order; an empty array means no answer. */
  answerItemIds?: readonly string[]
}>

export type TurnOutcome =
  | (Readonly<{ status: "completed" }> & TurnCompletion)
  | Readonly<{ status: "failed"; error: KernelError }>
  | Readonly<{ status: "cancelled"; reason?: string }>
  | Readonly<{ status: "interrupted"; reason?: string }>

export type CollaborationAction =
  | "spawn"
  | "send_message"
  | "follow_up"
  | "wait"
  | "interrupt"
  | "list"

export type CollaborationReceiver = Readonly<{
  sessionId: string
  path: string
}>
export type FileChangeDiff = Readonly<{
  format: "unified"
  text: string
  truncated: boolean
}>

export type FileChange =
  | Readonly<{ path: string; kind: "add" | "delete"; diff?: FileChangeDiff }>
  | Readonly<{
      path: string
      kind: "update"
      movePath?: string
      diff?: FileChangeDiff
    }>

export type CommandExecutionResult = Readonly<{
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs?: number
  cwd?: string
  shell?: string
  warnings?: ReadonlyArray<string>
  blocked?: Readonly<{ rule: string }>
  binary?: Readonly<{
    stdout: boolean
    stderr: boolean
    stdoutBytes: number
    stderrBytes: number
  }>
}>

export type FileReadResult = Readonly<{
  path: string
  kind: "file" | "directory"
  count?: number
  entries?: ReadonlyArray<string>
  range?: Readonly<{ offset: number; limit: number }>
  empty: boolean
  truncated: boolean
}>

export type FileSearchResult = Readonly<{
  path: string
  outputMode: "content" | "files_with_matches" | "count"
  count: number
  truncated: boolean
  timedOut: boolean
  paths?: ReadonlyArray<string>
  matches?: ReadonlyArray<
    Readonly<{ path: string; line?: number; text?: string; count?: number }>
  >
}>

export type WebFetchResult = Readonly<{
  url: string
  status: number
  truncated: boolean
}>

export type WebSearchResult = Readonly<{
  links: ReadonlyArray<Readonly<{ title: string; url: string }>>
}>

export type McpToolCallResult = Readonly<{
  content: ReadonlyArray<JsonValue>
  structuredContent?: JsonValue
  isError?: boolean
  _meta?: JsonValue
}>

export type AgentMessageExecutionItem = Readonly<{
  type: "agent_message"
  itemId: string
  content: ReadonlyArray<ModelTextBlock>
  providerMetadata?: EventMetadata
}>

export type ReasoningExecutionItem = Readonly<{
  type: "reasoning"
  itemId: string
  text: string
  providerMetadata?: EventMetadata
}>

// Compaction is housekeeping inside a Turn: its start is live-only, while the
// durable checkpoint and completed item let clients recover the final state.
export type ContextCompactionStartedItem = Readonly<{
  type: "context_compaction"
  itemId: string
}>

export type ContextCompactionCompletedItem = Readonly<{
  type: "context_compaction"
  itemId: string
  status: typeof ItemStatus.Completed | typeof ItemStatus.Failed
  error?: KernelError
}>
export type ToolExecutionItemBase = Readonly<{
  itemId: string
  toolCallId: string
  name: string
  input: JsonValue
  requiresPermission: boolean
}>

export type ToolExecutionDescriptor =
  | Readonly<{
      type: "command_execution"
      command: string
      description?: string
      result?: CommandExecutionResult
    }>
  | Readonly<{
      type: "file_change"
      request: Readonly<{
        operation: "edit" | "write" | "apply_patch"
        paths: ReadonlyArray<string>
      }>
      changes: ReadonlyArray<FileChange>
      exact?: boolean
    }>
  | Readonly<{
      type: "file_read"
      path: string
      offset?: number
      limit?: number
      result?: FileReadResult
    }>
  | Readonly<{
      type: "file_search"
      operation: "grep" | "glob"
      pattern: string
      path?: string
      outputMode?: "content" | "files_with_matches" | "count"
      lineNumbers: boolean
      result?: FileSearchResult
    }>
  | Readonly<{
      type: "web_fetch"
      url: string
      result?: WebFetchResult
    }>
  | Readonly<{
      type: "web_search"
      query: string
      result?: WebSearchResult
    }>
  | Readonly<{
      type: "collaboration_tool_call"
      action: CollaborationAction
      description: string
      receivers: ReadonlyArray<CollaborationReceiver>
    }>
  | Readonly<{
      type: "mcp_tool_call"
      server: string
      tool: string
      arguments: JsonValue
      // Server-provided display hint only. Permission decisions use the
      // runtime tool policy and must never trust this value.
      readOnlyHint?: boolean
      result?: McpToolCallResult
    }>
  | Readonly<{ type: "dynamic_tool_call" }>

export type ToolExecutionItem = ToolExecutionItemBase & ToolExecutionDescriptor

// All item starts belong to live delivery. Their durable final items are
// self-contained ItemCompleted facts.
export type StreamedStartedItem = ContextCompactionStartedItem

export type StartedExecutionItem = StreamedStartedItem | ToolExecutionItem

export type ItemStartedEvent = Readonly<{
  type: typeof EventType.ItemStarted
  data: Readonly<{ turnId: string; item: StartedExecutionItem }>
}>

export type CompletedExecutionItem =
  | AgentMessageExecutionItem
  | ReasoningExecutionItem
  | ContextCompactionCompletedItem
  | (ToolExecutionItem &
      Readonly<{
        resultItemId: string
        content: ItemContent
        output?: JsonValue
        error?: KernelError
      }>)

export type ItemCompletedEvent = Readonly<{
  type: typeof EventType.ItemCompleted
  data: Readonly<{
    turnId: string
    item: CompletedExecutionItem
  }>
}>

export type KernelEvent =
  | SessionCreatedEvent
  | InputAdmittedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ItemStartedEvent
  | ItemCompletedEvent
  | ContextTokensEvent

export type EventEnvelopeBase = {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly version: number
  readonly createdAt: string
}

export type EventEnvelope = EventEnvelopeBase & KernelEvent
// Opaque native records advance replay without exposing their payloads.
export type AppSessionEventEnvelope =
  | EventEnvelope
  | (EventEnvelopeBase &
      Readonly<{
        type: "session.cursor"
        data: Readonly<Record<string, never>>
      }>)
