import {
  type ImageAttachment,
  isKernelEvent,
  type RuntimeEventEnvelope,
  type StoredEventEnvelope,
  type TokenUsage,
  type ToolExecutionItem,
  type TurnMetrics,
} from "../kernel/events.ts"
import type { LiveSessionEvent } from "../runtime/live-events.ts"
import type {
  ApiPendingInput,
  ApiPendingPermission,
  ApiSessionDetail,
} from "../server/protocol.ts"

export type ExecutionEntry =
  | {
      readonly kind: "user_input"
      readonly inputId: string
      readonly text: string
      readonly attachments?: readonly ImageAttachment[]
      readonly at: string
    }
  | {
      readonly kind: "assistant"
      readonly itemId: string
      readonly turnId: string
      readonly text: string
      readonly status: "streaming" | "completed"
      readonly at: string
    }
  | {
      readonly kind: "reasoning"
      readonly itemId: string
      readonly turnId: string
      readonly text: string
      readonly status: "streaming" | "completed"
      readonly at: string
    }
  | {
      readonly kind: "tool"
      readonly toolCallId: string
      readonly turnId: string
      readonly execution: ToolExecutionItem
      readonly state: string
      readonly output?: unknown
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
      readonly state: "failed" | "cancelled" | "interrupted"
      readonly message: string
    }
  | {
      readonly kind: "context_compacted"
      readonly compactionId: string
      readonly summary: string
      readonly createdAt: string
    }

export type ToolDiff = { readonly text: string; readonly truncated: boolean }

export type CommandResult = {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMs?: number
  readonly cwd?: string
  readonly shell?: string
  readonly warnings?: readonly string[]
  readonly blocked?: { readonly rule: string }
  readonly binary?: {
    readonly stdout: boolean
    readonly stderr: boolean
    readonly stdoutBytes: number
    readonly stderrBytes: number
  }
}

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

export type ExecutionView = {
  readonly entries: readonly ExecutionEntry[]
  readonly activeTurnId?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly workingDirectory?: string
  readonly queuedInputIds: readonly string[]
  readonly lastModel?: { readonly provider: string; readonly model: string }
  readonly lastTurnUsage?: TokenUsage
  readonly lastTurnMetrics?: TurnMetrics
  readonly telemetry: SessionTelemetry
  readonly activeTurnStartedAt?: string
  readonly activeActivity?: ActiveTurnActivity
}

export type ExecutionViewState = {
  readonly entries: readonly ExecutionEntry[]
  readonly activeTurnId: string | undefined
  readonly mateId: string | undefined
  readonly mateRevisionId: string | undefined
  readonly workingDirectory: string | undefined
  readonly lastModel:
    | { readonly provider: string; readonly model: string }
    | undefined
  readonly lastTurnUsage: TokenUsage | undefined
  readonly lastTurnMetrics: TurnMetrics | undefined
  readonly telemetry: SessionTelemetry
  readonly activeTurnStartedAt: string | undefined
  readonly lastSeq: number
  readonly itemEntryIndexes: Readonly<Record<string, number>>
  readonly permissionEntryIndexes: Readonly<Record<string, number>>
  readonly openCompactionItems: Readonly<Record<string, string>>
  readonly queuedInputs: Readonly<Record<string, ApiPendingInput>>
  readonly timeToFirstTokenWeightedMs: number
  readonly timeToFirstTokenSamples: number
}

export type ExecutionViewAction =
  | { readonly type: "snapshot"; readonly session: ApiSessionDetail }
  | { readonly type: "durable"; readonly event: StoredEventEnvelope }
  | { readonly type: "transient"; readonly event: LiveSessionEvent }
  | {
      readonly type: "permission_resolving"
      readonly permissionRequestId: string
      readonly behavior: "allow" | "deny"
    }
  | {
      readonly type: "permission_retry"
      readonly permissionRequestId: string
      readonly behavior: "allow" | "deny"
    }

const EMPTY_TELEMETRY: SessionTelemetry = {
  turns: 0,
  steps: 0,
  modelDurationMs: 0,
  toolDurationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
}

export function createExecutionViewState(
  session?: ApiSessionDetail,
): ExecutionViewState {
  const initial: ExecutionViewState = {
    entries: [],
    activeTurnId: undefined,
    mateId: undefined,
    mateRevisionId: undefined,
    workingDirectory: undefined,
    lastModel: undefined,
    lastTurnUsage: undefined,
    lastTurnMetrics: undefined,
    telemetry: EMPTY_TELEMETRY,
    activeTurnStartedAt: undefined,
    lastSeq: 0,
    itemEntryIndexes: {},
    permissionEntryIndexes: {},
    openCompactionItems: {},
    queuedInputs: {},
    timeToFirstTokenWeightedMs: 0,
    timeToFirstTokenSamples: 0,
  }
  return session === undefined
    ? initial
    : reduceExecutionView(initial, { type: "snapshot", session })
}

export function reduceExecutionView(
  state: ExecutionViewState,
  action: ExecutionViewAction,
): ExecutionViewState {
  if (action.type === "snapshot") return applySnapshot(state, action.session)
  if (action.type === "permission_resolving") {
    return updatePermission(state, action.permissionRequestId, {
      state: "resolving",
      behavior: action.behavior,
    })
  }
  if (action.type === "permission_retry") {
    const index = state.permissionEntryIndexes[action.permissionRequestId]
    const current = index === undefined ? undefined : state.entries[index]
    if (
      current?.kind !== "permission" ||
      current.state !== "resolving" ||
      current.behavior !== action.behavior
    ) {
      return state
    }
    return updatePermission(state, action.permissionRequestId, {
      state: "requested",
      behavior: undefined,
    })
  }
  if (action.type === "transient") return applyTransient(state, action.event)
  if (!isKernelEvent(action.event))
    return { ...state, lastSeq: action.event.seq }
  return applyDurable(state, action.event)
}

export function projectExecutionView(state: ExecutionViewState): ExecutionView {
  const activeActivity = projectActiveActivity(state)
  return {
    entries: state.entries,
    ...(state.activeTurnId === undefined
      ? {}
      : { activeTurnId: state.activeTurnId }),
    ...(state.mateId === undefined ? {} : { mateId: state.mateId }),
    ...(state.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: state.mateRevisionId }),
    ...(state.workingDirectory === undefined
      ? {}
      : { workingDirectory: state.workingDirectory }),
    queuedInputIds: Object.keys(state.queuedInputs),
    ...(state.lastModel === undefined ? {} : { lastModel: state.lastModel }),
    ...(state.lastTurnUsage === undefined
      ? {}
      : { lastTurnUsage: state.lastTurnUsage }),
    ...(state.lastTurnMetrics === undefined
      ? {}
      : { lastTurnMetrics: state.lastTurnMetrics }),
    telemetry: state.telemetry,
    ...(state.activeTurnStartedAt === undefined
      ? {}
      : { activeTurnStartedAt: state.activeTurnStartedAt }),
    ...(activeActivity === undefined ? {} : { activeActivity }),
  }
}

function applySnapshot(
  state: ExecutionViewState,
  session: ApiSessionDetail,
): ExecutionViewState {
  const queuedInputs = Object.fromEntries(
    session.pendingInputs.map((input) => [input.id, input]),
  )
  let next: ExecutionViewState = {
    ...state,
    lastSeq: Math.max(state.lastSeq, session.seq),
    queuedInputs,
    ...(session.activeTurnId === undefined
      ? { activeTurnId: undefined, activeTurnStartedAt: undefined }
      : { activeTurnId: session.activeTurnId }),
    ...(session.mateId === undefined ? {} : { mateId: session.mateId }),
    ...(session.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: session.mateRevisionId }),
    ...(session.workingDirectory === undefined
      ? {}
      : { workingDirectory: session.workingDirectory }),
    ...(session.currentModel === undefined
      ? {}
      : {
          lastModel: {
            provider: session.currentModel.provider,
            model: session.currentModel.model,
          },
        }),
    telemetry: replaceUsage(state.telemetry, session.usage),
  }
  const pendingIds = new Set(
    session.pendingPermissions.map(
      (permission) => permission.permissionRequestId,
    ),
  )
  for (const permissionRequestId of Object.keys(state.permissionEntryIndexes)) {
    if (!pendingIds.has(permissionRequestId)) {
      next = updatePermission(next, permissionRequestId, {
        state: "resolved",
        behavior: undefined,
      })
    }
  }
  for (const permission of session.pendingPermissions)
    next = upsertPermission(next, permission)
  return next
}

function applyTransient(
  state: ExecutionViewState,
  event: LiveSessionEvent,
): ExecutionViewState {
  if (event.type === "item.started") {
    const item = event.item
    if (item.type === "context_compaction") {
      return {
        ...state,
        openCompactionItems: {
          ...state.openCompactionItems,
          [item.itemId]: event.turnId,
        },
      }
    }
    if (item.type === "agent_message" || item.type === "reasoning") {
      return appendItemEntry(state, item.itemId, {
        kind: item.type === "agent_message" ? "assistant" : "reasoning",
        itemId: item.itemId,
        turnId: event.turnId,
        text: "",
        status: "streaming",
        at: event.createdAt,
      })
    }
    return appendItemEntry(
      settleStreamingEntries(state, event.turnId, false),
      item.itemId,
      {
        kind: "tool",
        toolCallId: item.toolCallId,
        turnId: event.turnId,
        execution: item,
        state: "requested",
      },
    )
  }
  if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
    const index = state.itemEntryIndexes[event.itemId]
    const current = index === undefined ? undefined : state.entries[index]
    if (
      index === undefined ||
      (current?.kind !== "assistant" && current?.kind !== "reasoning") ||
      current.turnId !== event.turnId ||
      current.status !== "streaming" ||
      (event.type === "assistant.delta" && current.kind !== "assistant") ||
      (event.type === "reasoning.delta" && current.kind !== "reasoning")
    ) {
      return state
    }
    return {
      ...state,
      entries: replaceAt(state.entries, index, {
        ...current,
        text: `${current.text}${event.delta}`,
      }),
    }
  }
  if (event.type === "session.usage")
    return { ...state, telemetry: replaceUsage(state.telemetry, event.usage) }
  if (event.type === "permission.requested")
    return upsertPermission(state, event)
  if (event.type === "permission.resolved") {
    return updatePermission(state, event.permissionRequestId, {
      state: "resolved",
      behavior: event.outcome,
    })
  }
  return state
}

function applyDurable(
  state: ExecutionViewState,
  event: RuntimeEventEnvelope,
): ExecutionViewState {
  let next: ExecutionViewState = { ...state, lastSeq: event.seq }
  switch (event.type) {
    case "session.created":
      return next
    case "input.admitted": {
      const queuedInputs = {
        ...next.queuedInputs,
        [event.data.inputId]: {
          id: event.data.inputId,
          text: event.data.content.text,
          admittedAt: event.createdAt,
        },
      }
      return {
        ...next,
        queuedInputs,
        entries:
          event.data.role === "user"
            ? [
                ...next.entries,
                {
                  kind: "user_input",
                  inputId: event.data.inputId,
                  text: event.data.content.text,
                  attachments: event.data.content.attachments ?? [],
                  at: event.createdAt,
                },
              ]
            : next.entries,
      }
    }
    case "input.cancelled":
      return removeQueuedInput(next, event.data.inputId)
    case "turn.started":
      next = removeQueuedInput(next, event.data.inputId)
      return {
        ...next,
        activeTurnId: event.data.turnId,
        activeTurnStartedAt: event.createdAt,
      }
    case "turn.completed": {
      const metrics = event.data.metrics
      const samples = Math.max(1, metrics?.modelCalls ?? 0)
      const hasTimeToFirstToken =
        metrics?.averageTimeToFirstTokenMs !== undefined
      const timeToFirstTokenWeightedMs =
        next.timeToFirstTokenWeightedMs +
        (hasTimeToFirstToken
          ? (metrics?.averageTimeToFirstTokenMs ?? 0) * samples
          : 0)
      const timeToFirstTokenSamples =
        next.timeToFirstTokenSamples + (hasTimeToFirstToken ? samples : 0)
      const telemetry = replaceUsage(
        {
          ...next.telemetry,
          turns: next.telemetry.turns + 1,
          steps:
            next.telemetry.steps +
            (metrics?.modelCalls ?? 0) +
            (metrics?.toolCalls ?? 0),
          modelDurationMs:
            next.telemetry.modelDurationMs + (metrics?.modelDurationMs ?? 0),
          toolDurationMs:
            next.telemetry.toolDurationMs + (metrics?.toolDurationMs ?? 0),
          ...(timeToFirstTokenSamples === 0
            ? {}
            : {
                averageTimeToFirstTokenMs: Math.round(
                  timeToFirstTokenWeightedMs / timeToFirstTokenSamples,
                ),
              }),
        },
        event.data.sessionUsage,
      )
      next = {
        ...next,
        telemetry,
        timeToFirstTokenWeightedMs,
        timeToFirstTokenSamples,
        ...(event.data.usage === undefined
          ? {}
          : { lastTurnUsage: event.data.usage }),
        ...(metrics === undefined ? {} : { lastTurnMetrics: metrics }),
        ...(next.activeTurnId === event.data.turnId
          ? {
              activeTurnId: undefined,
              activeTurnStartedAt: undefined,
            }
          : {}),
        openCompactionItems: Object.fromEntries(
          Object.entries(next.openCompactionItems).filter(
            ([, turnId]) => turnId !== event.data.turnId,
          ),
        ),
      }
      next = settleStreamingEntries(
        next,
        event.data.turnId,
        event.data.outcome.status !== "completed",
      )
      if (event.data.outcome.status === "completed") return next
      const outcome = event.data.outcome
      return {
        ...next,
        entries: [
          ...next.entries,
          {
            kind: "turn_terminal",
            turnId: event.data.turnId,
            state: outcome.status,
            message:
              outcome.status === "failed"
                ? outcome.error.message
                : (outcome.reason ??
                  (outcome.status === "cancelled"
                    ? "Turn cancelled."
                    : "Turn interrupted.")),
          },
        ],
      }
    }
    case "item.started": {
      const item = event.data.item
      if (item.type === "context_compaction") {
        return {
          ...next,
          openCompactionItems: {
            ...next.openCompactionItems,
            [item.itemId]: event.data.turnId,
          },
        }
      }
      return appendItemEntry(
        settleStreamingEntries(next, event.data.turnId, false),
        item.itemId,
        {
          kind: "tool",
          toolCallId: item.toolCallId,
          turnId: event.data.turnId,
          execution: item,
          state: "requested",
        },
      )
    }
    case "item.completed": {
      const item = event.data.item
      if (item.type === "context_compaction") {
        const { [item.itemId]: _, ...openCompactionItems } =
          next.openCompactionItems
        return {
          ...next,
          openCompactionItems,
        }
      }
      if (item.type === "agent_message" || item.type === "reasoning") {
        const text =
          item.type === "agent_message"
            ? item.content.map((block) => block.text).join("")
            : item.text
        if (text.length === 0) return removeItemEntry(next, item.itemId)
        const entry: ExecutionEntry =
          item.type === "agent_message"
            ? {
                kind: "assistant",
                itemId: item.itemId,
                turnId: event.data.turnId,
                text,
                status: "completed",
                at: event.createdAt,
              }
            : {
                kind: "reasoning",
                itemId: item.itemId,
                turnId: event.data.turnId,
                text,
                status: "completed",
                at: event.createdAt,
              }
        return replaceItemEntry(next, item.itemId, entry)
      }
      return replaceItemEntry(next, item.itemId, {
        kind: "tool",
        toolCallId: item.toolCallId,
        turnId: event.data.turnId,
        execution: item,
        state: item.error === undefined ? "completed" : "failed",
        ...(item.output === undefined ? {} : { output: item.output }),
        resultText:
          item.content.kind === "text"
            ? item.content.text
            : JSON.stringify(item.content.value),
        ...(item.error === undefined
          ? {}
          : { resultError: true, resultErrorMessage: item.error.message }),
      })
    }
    case "context.compacted":
      return {
        ...next,
        entries: [
          ...next.entries,
          {
            kind: "context_compacted",
            compactionId: event.data.compactionId,
            summary: event.data.summary,
            createdAt: event.createdAt,
          },
        ],
      }
    default:
      return next
  }
}

function appendItemEntry(
  state: ExecutionViewState,
  itemId: string,
  entry: ExecutionEntry,
): ExecutionViewState {
  return {
    ...state,
    entries: [...state.entries, entry],
    itemEntryIndexes: {
      ...state.itemEntryIndexes,
      [itemId]: state.entries.length,
    },
  }
}

function replaceItemEntry(
  state: ExecutionViewState,
  itemId: string,
  entry: ExecutionEntry,
): ExecutionViewState {
  const index = state.itemEntryIndexes[itemId]
  if (index === undefined) return appendItemEntry(state, itemId, entry)
  return { ...state, entries: replaceAt(state.entries, index, entry) }
}

function removeItemEntry(
  state: ExecutionViewState,
  itemId: string,
): ExecutionViewState {
  const index = state.itemEntryIndexes[itemId]
  if (index === undefined) return state
  const entries = state.entries.filter((_, candidate) => candidate !== index)
  const indexes = indexEntries(entries)
  return {
    ...state,
    entries,
    itemEntryIndexes: indexes.itemEntryIndexes,
    permissionEntryIndexes: indexes.permissionEntryIndexes,
  }
}

function settleStreamingEntries(
  state: ExecutionViewState,
  turnId: string,
  preserveText: boolean,
): ExecutionViewState {
  let changed = false
  const entries = state.entries.flatMap((entry): readonly ExecutionEntry[] => {
    if (
      (entry.kind !== "assistant" && entry.kind !== "reasoning") ||
      entry.turnId !== turnId ||
      entry.status !== "streaming"
    ) {
      return [entry]
    }
    changed = true
    if (!preserveText || entry.text.length === 0) return []
    return [{ ...entry, status: "completed" }]
  })
  if (!changed) return state
  const indexes = indexEntries(entries)
  return {
    ...state,
    entries,
    itemEntryIndexes: indexes.itemEntryIndexes,
    permissionEntryIndexes: indexes.permissionEntryIndexes,
  }
}

function indexEntries(entries: readonly ExecutionEntry[]): {
  readonly itemEntryIndexes: Readonly<Record<string, number>>
  readonly permissionEntryIndexes: Readonly<Record<string, number>>
} {
  const itemEntryIndexes: Record<string, number> = {}
  const permissionEntryIndexes: Record<string, number> = {}
  entries.forEach((entry, index) => {
    if (
      entry.kind === "assistant" ||
      entry.kind === "reasoning" ||
      entry.kind === "tool"
    ) {
      const itemId =
        entry.kind === "tool" ? entry.execution.itemId : entry.itemId
      itemEntryIndexes[itemId] = index
    } else if (entry.kind === "permission") {
      permissionEntryIndexes[entry.permissionRequestId] = index
    }
  })
  return { itemEntryIndexes, permissionEntryIndexes }
}

function upsertPermission(
  state: ExecutionViewState,
  permission: ApiPendingPermission,
): ExecutionViewState {
  const index = state.permissionEntryIndexes[permission.permissionRequestId]
  const current = index === undefined ? undefined : state.entries[index]
  const resolving =
    current?.kind === "permission" && current.state === "resolving"
  const entry: Extract<ExecutionEntry, { readonly kind: "permission" }> = {
    kind: "permission",
    permissionRequestId: permission.permissionRequestId,
    turnId: permission.turnId,
    toolCallId: permission.toolCallId,
    action: permission.action,
    ...(permission.subject === undefined
      ? {}
      : { subject: permission.subject }),
    ...(permission.reason === undefined ? {} : { reason: permission.reason }),
    state: resolving ? "resolving" : "requested",
    ...(resolving && current.behavior !== undefined
      ? { behavior: current.behavior }
      : {}),
  }
  if (index !== undefined)
    return {
      ...state,
      entries: replaceAt(state.entries, index, entry),
    }
  return {
    ...state,
    entries: [...state.entries, entry],
    permissionEntryIndexes: {
      ...state.permissionEntryIndexes,
      [permission.permissionRequestId]: state.entries.length,
    },
  }
}

function updatePermission(
  state: ExecutionViewState,
  permissionRequestId: string,
  patch: {
    readonly state: "requested" | "resolving" | "resolved"
    readonly behavior: string | undefined
  },
): ExecutionViewState {
  const index = state.permissionEntryIndexes[permissionRequestId]
  const current = index === undefined ? undefined : state.entries[index]
  if (index === undefined || current?.kind !== "permission") return state
  const behavior = patch.behavior
  const { behavior: _, ...withoutBehavior } = current
  return {
    ...state,
    entries: replaceAt(state.entries, index, {
      ...withoutBehavior,
      state: patch.state,
      ...(behavior === undefined ? {} : { behavior }),
    }),
  }
}

function projectActiveActivity(
  state: ExecutionViewState,
): ActiveTurnActivity | undefined {
  const turnId = state.activeTurnId
  if (turnId === undefined) return undefined

  if (Object.values(state.openCompactionItems).includes(turnId)) {
    return { kind: "compacting" }
  }
  let streamingReasoning = false
  let runningTool: Extract<ExecutionEntry, { kind: "tool" }> | undefined
  let streamingAssistant = false
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]
    if (
      entry === undefined ||
      !("turnId" in entry) ||
      entry.turnId !== turnId
    ) {
      continue
    }
    if (entry.kind === "permission" && entry.state !== "resolved") {
      return { kind: "waiting_permission", action: entry.action }
    }
    if (entry.kind === "reasoning" && entry.status === "streaming") {
      streamingReasoning = true
    } else if (
      runningTool === undefined &&
      entry.kind === "tool" &&
      entry.state === "requested"
    ) {
      runningTool = entry
    } else if (
      entry.kind === "assistant" &&
      entry.status === "streaming" &&
      entry.text.length > 0
    ) {
      streamingAssistant = true
    }
  }
  if (streamingReasoning) return { kind: "reasoning" }
  if (runningTool !== undefined) {
    return { kind: "running_tool", name: runningTool.execution.name }
  }
  if (streamingAssistant) return { kind: "responding" }
  return { kind: "reasoning" }
}

function removeQueuedInput(
  state: ExecutionViewState,
  inputId: string,
): ExecutionViewState {
  const { [inputId]: _, ...queuedInputs } = state.queuedInputs
  return { ...state, queuedInputs }
}

function replaceUsage(
  telemetry: SessionTelemetry,
  usage: TokenUsage | undefined,
): SessionTelemetry {
  if (usage === undefined) return telemetry
  return {
    ...telemetry,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
  }
}

function replaceAt<T>(
  values: readonly T[],
  index: number,
  value: T,
): readonly T[] {
  return values.map((current, currentIndex) =>
    currentIndex === index ? value : current,
  )
}
