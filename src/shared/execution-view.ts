import type {
  ApiPendingInput,
  ApiPendingPermission,
  ApiSessionDetail,
} from "../protocol/application.ts"
import type {
  AppSessionEventEnvelope,
  EventEnvelope,
  HostedToolExecutionItem,
  TokenUsage,
  TurnMetrics,
  TurnOutcome,
} from "../protocol/events.ts"
import type {
  ActiveModelRetry,
  ActiveTurnActivity,
  ContextTokens,
  ExecutionEntry,
  ExecutionView,
  SessionTelemetry,
  TurnActivityPage,
  TurnTiming,
} from "../protocol/execution-view.ts"
import type { LiveSessionEvent } from "../protocol/live-events.ts"
import type { InputContent } from "../protocol/user-input.ts"
import { inputContentText } from "../protocol/user-input.ts"
import {
  parseSessionPlan,
  parseUserQuestions,
} from "../protocol/user-interaction.ts"
import { citationSources } from "./citation-sources.ts"

export type {
  ActiveModelRetry,
  ActiveTurnActivity,
  ContextTokens,
  ExecutionEntry,
  ExecutionView,
  SessionTelemetry,
  ToolDiff,
  TurnActivityPage,
  TurnTiming,
} from "../protocol/execution-view.ts"

type EntryPosition = Readonly<{ seq: number } | { afterSeq: number }>

export type ExecutionViewState = Readonly<{
  deferredTurnActivity: Readonly<Record<string, TurnActivityPage>>
  turnTimings: Readonly<Record<string, TurnTiming>>
  turnPositions: Readonly<Record<string, number>>
  entries: readonly ExecutionEntry[]
  entryPositions: Readonly<Record<string, EntryPosition>>
  activeTurnId: string | undefined
  mateId: string | undefined
  mateRevisionId: string | undefined
  workingDirectory: string | undefined
  lastModel: { readonly provider: string; readonly model: string } | undefined
  lastTurnUsage: TokenUsage | undefined
  lastTurnMetrics: TurnMetrics | undefined
  contextTokens: ContextTokens | undefined
  telemetry: SessionTelemetry
  activeTurnStartedAt: string | undefined
  activeRetry: ActiveModelRetry | undefined
  lastSeq: number
  itemEntryIndexes: Readonly<Record<string, number>>
  permissionEntryIndexes: Readonly<Record<string, number>>
  openCompactionItems: Readonly<Record<string, string>>
  queuedInputs: Readonly<Record<string, ApiPendingInput>>
  // A queued or admitted event confirms that the server owns the request;
  // pending admission recovery acknowledges against this set after replay too.
  admittedRequestIds: Readonly<Record<string, true>>
  // Live answerability is separate from durable question transcript entries.
  pendingQuestionIds: readonly string[]
  completedTurnTelemetry: Readonly<
    Record<string, Readonly<{ usage?: TokenUsage; metrics?: TurnMetrics }>>
  >
  timeToFirstTokenWeightedMs: number
  timeToFirstTokenSamples: number
}>

export type ExecutionViewAction =
  | { readonly type: "snapshot"; readonly session: ApiSessionDetail }
  | { readonly type: "replay_completed"; readonly session: ApiSessionDetail }
  | { readonly type: "stream_unavailable" }
  | {
      readonly type: "input_pending"
      readonly requestId: string
      readonly content: InputContent
      readonly at: string
    }
  | { readonly type: "input_pending_discarded"; readonly requestId: string }
  | {
      readonly type: "durable"
      readonly event: AppSessionEventEnvelope
      readonly replay?: boolean
    }
  | {
      readonly type: "questions_dismissed"
      readonly questionIds: readonly string[]
    }
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

export function executionEntryKey(entry: ExecutionEntry): string {
  switch (entry.kind) {
    case "agent_input":
    case "user_input":
      return entry.inputId
    case "assistant":
    case "reasoning":
    case "plan":
    case "compaction":
    case "hosted_tool":
      return entry.itemId
    case "tool":
      return entry.toolCallId
    case "permission":
      return entry.permissionRequestId
    case "turn_terminal":
      return `${entry.turnId}:${entry.state}`
  }
}

export function createExecutionViewState(
  session?: ApiSessionDetail,
): ExecutionViewState {
  const initial: ExecutionViewState = {
    deferredTurnActivity: {},
    entries: [],
    entryPositions: {},
    turnTimings: {},
    turnPositions: {},
    activeTurnId: undefined,
    mateId: undefined,
    mateRevisionId: undefined,
    workingDirectory: undefined,
    lastModel: undefined,
    lastTurnUsage: undefined,
    lastTurnMetrics: undefined,
    contextTokens: undefined,
    telemetry: EMPTY_TELEMETRY,
    activeTurnStartedAt: undefined,
    activeRetry: undefined,
    lastSeq: 0,
    itemEntryIndexes: {},
    permissionEntryIndexes: {},
    openCompactionItems: {},
    queuedInputs: {},
    admittedRequestIds: {},
    pendingQuestionIds: [],
    completedTurnTelemetry: {},
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
  const next = applyExecutionViewAction(state, action)
  let positions: Record<string, EntryPosition> | undefined
  if (action.type === "durable" && action.event.type !== "session.cursor") {
    const key = durableEntryIdentity(action.event)
    if (key !== undefined) {
      const current = next.entryPositions[key]
      const seq =
        current !== undefined && "seq" in current
          ? Math.min(current.seq, action.event.seq)
          : action.event.seq
      if (current === undefined || !("seq" in current) || current.seq !== seq) {
        positions = { ...next.entryPositions, [key]: { seq } }
      }
    }
  }
  if (next.entries !== state.entries) {
    for (const entry of next.entries) {
      const key = executionEntryIdentity(entry)
      if ((positions ?? next.entryPositions)[key] !== undefined) continue
      positions ??= { ...next.entryPositions }
      // Live items have no durable sequence yet. Keep their observed position
      // after the cursor that preceded them until a start/completion anchors it.
      positions[key] = { afterSeq: state.lastSeq }
    }
  }
  return positions === undefined ? next : { ...next, entryPositions: positions }
}

function executionEntryIdentity(entry: ExecutionEntry): string {
  switch (entry.kind) {
    case "assistant":
    case "reasoning":
    case "plan":
    case "compaction":
    case "hosted_tool":
      return `item:${entry.itemId}`
    case "tool":
      return `item:${entry.execution.itemId}`
    case "agent_input":
    case "user_input":
      return `input:${entry.inputId}`
    default:
      return `${entry.kind}:${executionEntryKey(entry)}`
  }
}

function durableEntryIdentity(event: EventEnvelope): string | undefined {
  switch (event.type) {
    case "input.admitted":
      return `input:${event.data.inputId}`
    case "item.started":
    case "item.completed":
      return `item:${event.data.item.itemId}`
    case "turn.completed": {
      const outcome = event.data.outcome
      const terminal =
        outcome.status === "completed" ? outcome.reason : outcome.status
      return terminal === undefined
        ? undefined
        : `turn_terminal:${event.data.turnId}:${terminal}`
    }
    default:
      return undefined
  }
}

function applyExecutionViewAction(
  state: ExecutionViewState,
  action: ExecutionViewAction,
): ExecutionViewState {
  if (action.type === "input_pending") {
    return {
      ...state,
      entries: [
        ...state.entries,
        {
          kind: "user_input",
          inputId: `pending_${action.requestId}`,
          requestId: action.requestId,
          text: inputContentText(action.content),
          content: action.content,
          ...(action.content.references === undefined
            ? {}
            : { contextAttachments: action.content.references }),
          at: action.at,
        },
      ],
    }
  }
  if (action.type === "input_pending_discarded") {
    const entries = state.entries.filter(
      (entry) =>
        entry.kind !== "user_input" ||
        entry.inputId !== `pending_${action.requestId}`,
    )
    return entries.length === state.entries.length
      ? state
      : { ...state, entries, ...indexEntries(entries) }
  }
  if (action.type === "questions_dismissed") {
    return {
      ...state,
      pendingQuestionIds: state.pendingQuestionIds.filter(
        (questionId) => !action.questionIds.includes(questionId),
      ),
    }
  }
  if (action.type === "snapshot") return applySnapshot(state, action.session)
  if (action.type === "replay_completed") {
    // History describes past execution. At the replay boundary, the resident
    // Session decides which task still exists (including an idle Session).
    // Events beyond the snapshot watermark already describe newer live work.
    const next =
      state.lastSeq > action.session.seq
        ? state
        : applySnapshot(state, action.session)
    return reconcileExecution(
      next.activeTurnId === undefined
        ? { ...next, pendingQuestionIds: [] }
        : next,
      true,
    )
  }
  if (action.type === "stream_unavailable") {
    return reconcileExecution(
      {
        ...state,
        activeTurnId: undefined,
        activeTurnStartedAt: undefined,
        activeRetry: undefined,
      },
      false,
    )
  }
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
  if (action.event.type === "session.cursor")
    return { ...state, lastSeq: action.event.seq }
  return applyDurable(state, action.event, action.replay === true)
}

export function prependExecutionHistory(
  state: ExecutionViewState,
  events: readonly AppSessionEventEnvelope[],
): ExecutionViewState {
  let prefix = createExecutionViewState()
  for (const event of events) {
    prefix = reduceExecutionView(prefix, {
      type: "durable",
      event,
      replay: true,
    })
  }
  const entryPositions = { ...prefix.entryPositions }
  for (const [key, position] of Object.entries(state.entryPositions)) {
    const earlier = entryPositions[key]
    if ("seq" in position) {
      entryPositions[key] = {
        seq:
          earlier !== undefined && "seq" in earlier
            ? Math.min(earlier.seq, position.seq)
            : position.seq,
      }
    } else if (earlier === undefined || !("seq" in earlier)) {
      entryPositions[key] = position
    }
  }
  // A refresh can contain later records than an already loaded older page.
  // Canonical order is independent of which request supplied the newest body.
  const entriesById = new Map<string, ExecutionEntry>()
  for (const entry of [...prefix.entries, ...state.entries]) {
    const key = executionEntryIdentity(entry)
    const outcome =
      entry.kind === "tool"
        ? state.turnTimings[entry.turnId]?.outcome
        : undefined
    entriesById.set(
      key,
      entry.kind === "tool" &&
        entry.state === "requested" &&
        outcome !== undefined
        ? {
            ...entry,
            state: outcome.status === "completed" ? "unknown" : "interrupted",
          }
        : entry,
    )
  }
  const entries = [...entriesById.values()].sort((left, right) => {
    const position = (entry: ExecutionEntry) => {
      const known = entryPositions[executionEntryIdentity(entry)]
      return known === undefined
        ? Number.POSITIVE_INFINITY
        : "seq" in known
          ? known.seq
          : known.afterSeq + 0.5
    }
    return position(left) - position(right)
  })
  const completedTurnTelemetry = {
    ...prefix.completedTurnTelemetry,
    ...state.completedTurnTelemetry,
  }
  const turnTimings = { ...state.turnTimings }
  for (const [turnId, timing] of Object.entries(prefix.turnTimings)) {
    turnTimings[turnId] = { ...timing, ...state.turnTimings[turnId] }
  }
  const turnPositions = { ...prefix.turnPositions }
  for (const [turnId, seq] of Object.entries(state.turnPositions)) {
    turnPositions[turnId] = Math.min(turnPositions[turnId] ?? seq, seq)
  }
  return {
    ...state,
    entries,
    entryPositions,
    // Consumers enumerate timings chronologically, including the composer's
    // latest resumable turn. Arrival order changes as older pages are loaded.
    turnTimings: Object.fromEntries(
      Object.entries(turnTimings).sort(
        ([left], [right]) =>
          (turnPositions[left] ?? Number.POSITIVE_INFINITY) -
          (turnPositions[right] ?? Number.POSITIVE_INFINITY),
      ),
    ),
    turnPositions,
    activeTurnStartedAt:
      state.activeTurnId === undefined
        ? undefined
        : (state.activeTurnStartedAt ??
          turnTimings[state.activeTurnId]?.startedAt),
    completedTurnTelemetry,
    ...summarizeTurnTelemetry(completedTurnTelemetry),
    admittedRequestIds: {
      ...prefix.admittedRequestIds,
      ...state.admittedRequestIds,
    },
    ...indexEntries(entries),
  }
}

export function projectExecutionView(state: ExecutionViewState): ExecutionView {
  const activeActivity = projectActiveActivity(state)
  return {
    entries: state.entries,
    ...(Object.keys(state.deferredTurnActivity).length === 0
      ? {}
      : { deferredTurnActivity: state.deferredTurnActivity }),
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
    pendingQuestionIds: state.pendingQuestionIds,
    ...(state.lastModel === undefined ? {} : { lastModel: state.lastModel }),
    ...(state.lastTurnUsage === undefined
      ? {}
      : { lastTurnUsage: state.lastTurnUsage }),
    ...(state.lastTurnMetrics === undefined
      ? {}
      : { lastTurnMetrics: state.lastTurnMetrics }),
    ...(state.contextTokens === undefined
      ? {}
      : { contextTokens: state.contextTokens }),
    telemetry: state.telemetry,
    turnTimings: state.turnTimings,
    ...(state.activeTurnStartedAt === undefined
      ? {}
      : { activeTurnStartedAt: state.activeTurnStartedAt }),
    ...(activeActivity === undefined ? {} : { activeActivity }),
    ...(state.activeRetry === undefined
      ? {}
      : { activeRetry: state.activeRetry }),
  }
}

function applySnapshot(
  state: ExecutionViewState,
  session: ApiSessionDetail,
): ExecutionViewState {
  // Runtime cleanup can outlive the terminal event already included in replay.
  // Such a snapshot must not revive that completed turn.
  const activeTurnId =
    session.activeTurnId !== undefined &&
    state.turnTimings[session.activeTurnId]?.completedAt === undefined
      ? session.activeTurnId
      : undefined
  const queuedInputs = Object.fromEntries(
    session.pendingInputs.map((input) => [input.id, input]),
  )
  let next: ExecutionViewState = {
    ...state,
    lastSeq: Math.max(state.lastSeq, session.seq),
    queuedInputs,
    activeTurnId,
    activeRetry:
      activeTurnId === state.activeRetry?.turnId
        ? state.activeRetry
        : undefined,
    activeTurnStartedAt:
      activeTurnId === undefined
        ? undefined
        : state.turnTimings[activeTurnId]?.startedAt,
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

function reconcileExecution(
  state: ExecutionViewState,
  authoritative: boolean,
): ExecutionViewState {
  const interrupted = new Set(
    authoritative
      ? Object.entries(state.turnTimings)
          .filter(
            ([turnId, timing]) =>
              turnId !== state.activeTurnId && timing.completedAt === undefined,
          )
          .map(([turnId]) => turnId)
      : [],
  )
  let entries = state.entries.flatMap((entry): readonly ExecutionEntry[] => {
    if (!("turnId" in entry) || entry.turnId === state.activeTurnId) {
      if (
        authoritative &&
        (entry.kind === "assistant" || entry.kind === "reasoning") &&
        entry.status === "suspended"
      ) {
        // Absence from a bounded display cache is not proof of discard.
        // Retain visibly partial text, without claiming the connection is down.
        return [{ ...entry, status: "partial" }]
      }
      return authoritative && entry.kind === "tool" && entry.state === "unknown"
        ? [{ ...entry, state: "requested" }]
        : [entry]
    }
    if (entry.kind === "turn_terminal") interrupted.delete(entry.turnId)
    if (
      (entry.kind === "assistant" || entry.kind === "reasoning") &&
      entry.status !== "completed"
    ) {
      if (!authoritative)
        return [{ ...entry, status: "suspended", incomplete: true }]
      return hasStreamOutput(entry) ? [{ ...entry, status: "completed" }] : []
    }
    if (
      entry.kind === "tool" &&
      (entry.state === "requested" || entry.state === "unknown")
    ) {
      // A disconnected subscription cannot tell whether the tool stopped.
      return [{ ...entry, state: authoritative ? "interrupted" : "unknown" }]
    }
    if (entry.kind === "permission" && entry.state !== "resolved") {
      const { behavior: _, ...withoutBehavior } = entry
      return [{ ...withoutBehavior, state: "resolved" }]
    }
    return [entry]
  })
  const terminalEntry = (turnId: string): ExecutionEntry => ({
    kind: "turn_terminal",
    turnId,
    state: "interrupted",
    message: "This turn is no longer running.",
  })
  const lastEntryIndexes = new Map(
    entries.flatMap((entry, index) =>
      "turnId" in entry ? [[entry.turnId, index] as const] : [],
    ),
  )
  for (const turnId of interrupted) {
    if (lastEntryIndexes.has(turnId)) continue
    const inputId = state.turnTimings[turnId]?.inputId
    const index = entries.findIndex(
      (entry) => entry.kind === "user_input" && entry.inputId === inputId,
    )
    if (index !== -1) lastEntryIndexes.set(turnId, index)
  }
  const interruptedAfter = new Map(
    [...interrupted].flatMap((turnId) => {
      const index = lastEntryIndexes.get(turnId)
      return index === undefined ? [] : [[index, turnId] as const]
    }),
  )
  entries = entries.flatMap((entry, index) => {
    const turnId = interruptedAfter.get(index)
    if (turnId !== undefined) {
      interrupted.delete(turnId)
      return [entry, terminalEntry(turnId)]
    }
    return [entry]
  })
  for (const turnId of interrupted) {
    entries.push(terminalEntry(turnId))
  }
  return {
    ...state,
    entries,
    ...indexEntries(entries),
    openCompactionItems: Object.fromEntries(
      Object.entries(state.openCompactionItems).filter(
        ([, turnId]) => turnId === state.activeTurnId,
      ),
    ),
  }
}

function applyTransient(
  state: ExecutionViewState,
  event: LiveSessionEvent,
): ExecutionViewState {
  if (event.type === "item.discarded") {
    const entries = state.entries.filter(
      (entry) =>
        (entry.kind !== "assistant" && entry.kind !== "reasoning") ||
        entry.itemId !== event.itemId ||
        entry.turnId !== event.turnId ||
        entry.status === "completed",
    )
    return { ...state, entries, ...indexEntries(entries) }
  }
  if (event.type === "runtime.warning") {
    if (event.code !== "model.retry" || event.turnId !== state.activeTurnId) {
      return state
    }
    const { kind, nextAttempt, maxAttempts, delayMs } = event.details ?? {}
    switch (kind) {
      case "authentication":
      case "connection_failed":
      case "idle_timeout":
      case "invalid_request":
      case "protocol_error":
      case "provider_error":
      case "rate_limited":
      case "server_error":
      case "stream_disconnected":
        break
      default:
        return state
    }
    if (
      typeof nextAttempt !== "number" ||
      !Number.isSafeInteger(nextAttempt) ||
      nextAttempt < 2 ||
      (maxAttempts !== undefined &&
        (typeof maxAttempts !== "number" ||
          !Number.isSafeInteger(maxAttempts) ||
          maxAttempts < nextAttempt)) ||
      typeof delayMs !== "number" ||
      !Number.isFinite(delayMs) ||
      delayMs < 0
    ) {
      return state
    }
    return {
      ...state,
      activeRetry: {
        turnId: event.turnId,
        kind,
        nextAttempt,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        delayMs,
        message: event.message,
      },
    }
  }
  if (event.type === "turn.finished") {
    state = clearActiveRetry(state, event.turnId)
    if (state.turnTimings[event.turnId]?.completedAt !== undefined) return state
    // Runtime completion can survive a failed history write. Preserve visible
    // output, but leave usage and durable cursors to the persisted events.
    return finishTurn(state, event.turnId, event.outcome, event.createdAt, true)
  }
  if (event.type === "item.started") {
    if (state.turnTimings[event.turnId]?.completedAt !== undefined) return state
    state = clearActiveRetry(state, event.turnId)
    const item = event.item
    if (item.type === "hosted_tool")
      return upsertHostedTool(state, item, event.turnId)
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
      // A replayed start for the same display item must not split its deltas
      // into duplicate transcript entries.
      if (state.itemEntryIndexes[item.itemId] !== undefined) return state
      return appendItemEntry(state, item.itemId, {
        kind: item.type === "agent_message" ? "assistant" : "reasoning",
        itemId: item.itemId,
        turnId: event.turnId,
        text: "",
        ...(item.source === undefined ? {} : { source: item.source }),
        ...(item.type === "agent_message" && item.purpose !== undefined
          ? { purpose: item.purpose }
          : {}),
        ...(item.type === "agent_message" && item.refusal === true
          ? { refusal: true }
          : {}),
        ...(item.type === "reasoning" && item.representation !== undefined
          ? { representation: item.representation }
          : {}),
        status: "streaming",
        at: event.createdAt,
      })
    }
    if (state.itemEntryIndexes[item.itemId] !== undefined) return state
    return appendItemEntry(state, item.itemId, {
      kind: "tool",
      toolCallId: item.toolCallId,
      turnId: event.turnId,
      execution: item,
      state: "requested",
    })
  }
  if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
    if (!Number.isSafeInteger(event.offset) || event.offset < 0) return state
    if (state.turnTimings[event.turnId]?.completedAt !== undefined) return state
    const index = state.itemEntryIndexes[event.itemId]
    const current = index === undefined ? undefined : state.entries[index]
    const kind = event.type === "assistant.delta" ? "assistant" : "reasoning"
    if (current === undefined) {
      // Starts are transient too. A reconnect snapshot can be the first
      // observation of an item, but must not resurrect an inactive turn.
      if (state.activeTurnId !== event.turnId) return state
      return appendItemEntry(
        clearActiveRetry(state, event.turnId),
        event.itemId,
        {
          kind,
          itemId: event.itemId,
          turnId: event.turnId,
          text: event.delta,
          ...(event.source === undefined ? {} : { source: event.source }),
          ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
          ...(event.refusal === true ? { refusal: true } : {}),
          ...(event.representation === undefined
            ? {}
            : { representation: event.representation }),
          streamId: event.streamId,
          textOffset: event.offset,
          incomplete: event.offset > 0,
          status: "streaming",
          at: event.createdAt,
        },
      )
    }
    if (
      index === undefined ||
      current.kind !== kind ||
      current.turnId !== event.turnId ||
      current.status === "completed"
    )
      return state
    const replacedStream =
      current.streamId !== undefined && current.streamId !== event.streamId
    if (replacedStream && !event.snapshot) return state
    const start = current.textOffset ?? 0
    const end = start + current.text.length
    const incomingEnd = event.offset + event.delta.length
    if (
      !replacedStream &&
      incomingEnd <= end &&
      event.offset >= start &&
      current.status === "streaming"
    )
      return state
    let text: string
    let textOffset = start
    if (replacedStream || (event.offset <= start && incomingEnd >= end)) {
      // A subscription snapshot may restore a prefix missed by this client.
      text = event.delta
      textOffset = event.offset
    } else if (event.snapshot && incomingEnd === end) {
      // The cache may retain less prefix than this client. Keep the richer
      // local text while acknowledging that its stream is live again.
      text = current.text
    } else if (incomingEnd <= end) {
      return state
    } else if (event.offset <= end) {
      text = current.text + event.delta.slice(end - event.offset)
    } else {
      // Never join across an unknown gap. Show the contiguous suffix with a
      // partial-text notice until a snapshot or durable completion repairs it.
      text = event.delta
      textOffset = event.offset
    }
    return {
      ...clearActiveRetry(state, event.turnId),
      entries: replaceAt(state.entries, index, {
        ...current,
        text,
        ...(event.source === undefined ? {} : { source: event.source }),
        ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
        ...(event.refusal === true ? { refusal: true } : {}),
        ...(event.representation === undefined
          ? {}
          : { representation: event.representation }),
        streamId: event.streamId,
        textOffset,
        incomplete: textOffset > 0,
        status: "streaming",
      }),
    }
  }

  if (event.type === "permission.requested")
    return upsertPermission(clearActiveRetry(state, event.turnId), event)
  if (event.type === "permission.resolved") {
    return updatePermission(
      clearActiveRetry(state, event.turnId),
      event.permissionRequestId,
      {
        state: "resolved",
        behavior: event.outcome,
      },
    )
  }
  return state
}

function applyDurable(
  state: ExecutionViewState,
  event: EventEnvelope,
  replay: boolean,
): ExecutionViewState {
  let next: ExecutionViewState = { ...state, lastSeq: event.seq }
  if (event.type === "turn.started" || event.type === "turn.completed") {
    const turnId = event.data.turnId
    next = {
      ...next,
      turnPositions: {
        ...next.turnPositions,
        [turnId]: Math.min(next.turnPositions[turnId] ?? event.seq, event.seq),
      },
    }
  }
  switch (event.type) {
    case "session.created":
      return next
    case "input.admitted": {
      if (
        event.data.source === "agent" ||
        event.data.provenance !== undefined
      ) {
        const input: ExecutionEntry = {
          kind: "agent_input",
          inputId: event.data.inputId,
          requestId: event.data.requestId,
          ...(event.data.provenance === undefined
            ? {}
            : { sourceSessionId: event.data.provenance.sourceThreadId }),
          ...(event.data.steered === true ? { steered: true } : {}),
          text: inputContentText(event.data.content),
          at: event.createdAt,
        }
        const existing = next.entries.findIndex(
          (entry) =>
            entry.kind === "agent_input" && entry.inputId === input.inputId,
        )
        return {
          ...next,
          admittedRequestIds: {
            ...next.admittedRequestIds,
            [event.data.requestId]: true,
          },
          entries:
            existing === -1
              ? [...next.entries, input]
              : replaceAt(next.entries, existing, input),
        }
      }
      const pendingIndex = next.entries.findIndex(
        (entry) =>
          entry.kind === "user_input" &&
          (entry.inputId === event.data.inputId ||
            entry.requestId === event.data.requestId),
      )
      const input: ExecutionEntry = {
        kind: "user_input",
        inputId: event.data.inputId,
        requestId: event.data.requestId,
        ...(event.data.steered === true ? { steered: true } : {}),
        ...(typeof event.data.metadata?.userQuestionId === "string"
          ? { questionId: event.data.metadata.userQuestionId }
          : {}),
        text: inputContentText(event.data.content),
        content: event.data.content,
        ...(event.data.content.references === undefined
          ? {}
          : { contextAttachments: event.data.content.references }),
        at: event.createdAt,
      }
      return {
        ...next,
        pendingQuestionIds:
          event.data.role !== "user" || event.data.source === "runtime"
            ? next.pendingQuestionIds
            : typeof event.data.metadata?.userQuestionId === "string"
              ? next.pendingQuestionIds.filter(
                  (questionId) =>
                    questionId !== event.data.metadata?.userQuestionId,
                )
              : [],
        admittedRequestIds: {
          ...next.admittedRequestIds,
          [event.data.requestId]: true,
        },
        entries:
          event.data.role !== "user"
            ? next.entries
            : pendingIndex === -1
              ? [...next.entries, input]
              : replaceAt(next.entries, pendingIndex, input),
      }
    }
    case "turn.started":
      return {
        ...next,
        activeTurnId: event.data.turnId,
        activeTurnStartedAt: event.createdAt,
        activeRetry: undefined,
        turnTimings: {
          ...next.turnTimings,
          [event.data.turnId]: {
            ...(event.data.inputId === undefined
              ? {}
              : { inputId: event.data.inputId }),
            startedAt: event.createdAt,
          },
        },
      }
    case "turn.completed": {
      const completedTurnTelemetry = {
        ...next.completedTurnTelemetry,
        [event.data.turnId]: {
          ...(event.data.usage === undefined
            ? {}
            : { usage: event.data.usage }),
          ...(event.data.metrics === undefined
            ? {}
            : { metrics: event.data.metrics }),
        },
      }
      next = {
        ...next,
        completedTurnTelemetry,
        ...summarizeTurnTelemetry(completedTurnTelemetry),
        lastTurnUsage: event.data.usage,
        lastTurnMetrics: event.data.metrics,
      }
      return finishTurn(
        next,
        event.data.turnId,
        event.data.outcome,
        event.createdAt,
        event.data.outcome.status !== "completed",
      )
    }
    case "context.tokens": {
      return {
        ...next,
        contextTokens: {
          activeContextTokens: event.data.activeContextTokens,
          ...(event.data.capacityTokens === undefined
            ? {}
            : { capacityTokens: event.data.capacityTokens }),
          ...(event.data.provider === undefined
            ? {}
            : { provider: event.data.provider }),
          ...(event.data.model === undefined
            ? {}
            : { model: event.data.model }),
        },
      }
    }
    case "item.started": {
      next = clearActiveRetry(next, event.data.turnId)
      const item = event.data.item
      if (item.type === "hosted_tool")
        return upsertHostedTool(next, item, event.data.turnId)
      if (item.type === "context_compaction") {
        return {
          ...next,
          openCompactionItems: {
            ...next.openCompactionItems,
            [item.itemId]: event.data.turnId,
          },
        }
      }
      if (next.itemEntryIndexes[item.itemId] !== undefined) return next
      return replaceItemEntry(next, item.itemId, {
        kind: "tool",
        toolCallId: item.toolCallId,
        turnId: event.data.turnId,
        execution: item,
        state: "requested",
      })
    }
    case "item.completed": {
      next = clearActiveRetry(next, event.data.turnId)
      const item = event.data.item
      if (item.type === "hosted_tool")
        return upsertHostedTool(next, item, event.data.turnId)
      if (item.type === "context_compaction") {
        const { [item.itemId]: _, ...openCompactionItems } =
          next.openCompactionItems
        return replaceItemEntry({ ...next, openCompactionItems }, item.itemId, {
          kind: "compaction",
          itemId: item.itemId,
          turnId: event.data.turnId,
          status: item.status,
          ...(item.error === undefined
            ? {}
            : { errorMessage: item.error.message }),
        })
      }
      if (item.type === "agent_message" || item.type === "reasoning") {
        const text =
          item.type === "agent_message"
            ? item.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
            : item.text
        const sources =
          item.type === "agent_message" ? citationSources(item.content) : []
        if (
          text.length === 0 &&
          sources.length === 0 &&
          !(item.type === "reasoning" && item.representation === "redacted")
        )
          return removeItemEntry(next, item.itemId)
        const entry: ExecutionEntry =
          item.type === "agent_message"
            ? {
                kind: "assistant",
                ...(item.source === undefined ? {} : { source: item.source }),
                ...(item.content[0]?.purpose === undefined
                  ? {}
                  : { purpose: item.content[0].purpose }),
                ...(item.content[0]?.refusal === true ? { refusal: true } : {}),
                ...(sources.length === 0 ? {} : { sources }),
                itemId: item.itemId,
                turnId: event.data.turnId,
                text,
                status: "completed",
                at: event.createdAt,
              }
            : {
                kind: "reasoning",
                ...(item.source === undefined ? {} : { source: item.source }),
                ...(item.representation === undefined
                  ? {}
                  : { representation: item.representation }),
                ...(item.durationMs === undefined
                  ? {}
                  : { durationMs: item.durationMs }),
                itemId: item.itemId,
                turnId: event.data.turnId,
                text,
                status: "completed",
                at: event.createdAt,
              }
        return replaceItemEntry(next, item.itemId, entry)
      }
      const previousIndex = state.itemEntryIndexes[item.itemId]
      const previous =
        previousIndex === undefined ? undefined : state.entries[previousIndex]
      if (item.name === "update_plan" && item.error === undefined) {
        const plan = parseSessionPlan(item.output)
        if (plan !== undefined)
          return replaceItemEntry(next, item.itemId, {
            kind: "plan",
            itemId: item.itemId,
            turnId: event.data.turnId,
            plan,
          })
      }
      if (
        !replay &&
        item.name === "request_user_input_async" &&
        item.error === undefined &&
        parseUserQuestions(item.output) !== undefined &&
        (previous?.kind !== "tool" ||
          (previous.state !== "completed" && previous.state !== "failed")) &&
        next.turnTimings[event.data.turnId]?.completedAt === undefined &&
        !next.pendingQuestionIds.includes(item.toolCallId)
      ) {
        next = {
          ...next,
          pendingQuestionIds: [...next.pendingQuestionIds, item.toolCallId],
        }
      }
      return replaceItemEntry(next, item.itemId, {
        kind: "tool",
        toolCallId: item.toolCallId,
        turnId: event.data.turnId,
        execution: item,
        state: item.error === undefined ? "completed" : "failed",
        ...(item.output === undefined ? {} : { output: item.output }),
        ...(item.content.kind === "tool_result"
          ? { resultContent: item.content.parts }
          : item.content.kind === "text" && item.content.attachments?.length
            ? {
                resultContent: [
                  { type: "text" as const, text: item.content.text },
                  ...item.content.attachments.map((image) => ({
                    ...image,
                    type: "image" as const,
                  })),
                ],
              }
            : {}),
        resultText:
          item.content.kind === "tool_result"
            ? item.content.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            : item.content.kind === "text"
              ? item.content.text
              : JSON.stringify(item.content.value),
        ...(item.error === undefined
          ? {}
          : { resultError: true, resultErrorMessage: item.error.message }),
      })
    }
    default:
      return next
  }
}

function upsertHostedTool(
  state: ExecutionViewState,
  item: HostedToolExecutionItem,
  turnId: string,
): ExecutionViewState {
  const index = state.itemEntryIndexes[item.itemId]
  const prior = index === undefined ? undefined : state.entries[index]
  return replaceItemEntry(state, item.itemId, {
    kind: "hosted_tool",
    itemId: item.itemId,
    turnId,
    tool:
      prior?.kind === "hosted_tool"
        ? { ...prior.tool, ...item.tool }
        : item.tool,
  })
}

function finishTurn(
  state: ExecutionViewState,
  turnId: string,
  outcome: TurnOutcome,
  completedAt: string,
  preserveText: boolean,
): ExecutionViewState {
  const settled = settleStreamingEntries(state, turnId, preserveText)
  const entries = settled.entries
    .filter(
      (entry) => entry.kind !== "turn_terminal" || entry.turnId !== turnId,
    )
    .map((entry): ExecutionEntry => {
      if (!("turnId" in entry) || entry.turnId !== turnId) return entry
      if (entry.kind === "hosted_tool" && entry.tool.status === "running")
        return { ...entry, tool: { ...entry.tool, status: "interrupted" } }
      if (entry.kind === "tool" && entry.state === "requested") {
        return {
          ...entry,
          state: outcome.status === "completed" ? "unknown" : "interrupted",
        }
      }
      if (entry.kind === "permission" && entry.state !== "resolved") {
        return { ...entry, state: "resolved" }
      }
      return entry
    })
  if (outcome.status === "completed" && outcome.reason !== undefined) {
    entries.push({
      kind: "turn_terminal",
      turnId,
      state: outcome.reason,
      message:
        outcome.reason === "truncated"
          ? "The response reached a generation limit. You can ask to continue."
          : "The response was stopped by a content restriction.",
    })
  } else if (outcome.status !== "completed") {
    entries.push({
      kind: "turn_terminal",
      turnId,
      state: outcome.status,
      message:
        outcome.status === "failed"
          ? outcome.error.message
          : (outcome.reason ??
            (outcome.status === "cancelled"
              ? "Turn cancelled."
              : "Turn interrupted.")),
    })
  }
  return {
    ...clearActiveRetry(settled, turnId),
    pendingQuestionIds: [],
    entries,
    ...indexEntries(entries),
    turnTimings: {
      ...state.turnTimings,
      [turnId]: { ...state.turnTimings[turnId], completedAt, outcome },
    },
    ...(state.activeTurnId === turnId
      ? { activeTurnId: undefined, activeTurnStartedAt: undefined }
      : {}),
    openCompactionItems: Object.fromEntries(
      Object.entries(state.openCompactionItems).filter(
        ([, id]) => id !== turnId,
      ),
    ),
  }
}

function clearActiveRetry(
  state: ExecutionViewState,
  turnId: string,
): ExecutionViewState {
  return state.activeRetry?.turnId === turnId
    ? { ...state, activeRetry: undefined }
    : state
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

function hasStreamOutput(
  entry: Extract<ExecutionEntry, { kind: "assistant" | "reasoning" }>,
): boolean {
  return (
    entry.text.length > 0 ||
    (entry.kind === "reasoning" && entry.representation === "redacted")
  )
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
      entry.status === "completed"
    ) {
      return [entry]
    }
    changed = true
    if (!preserveText || !hasStreamOutput(entry)) return []
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
      entry.kind === "plan" ||
      entry.kind === "compaction" ||
      entry.kind === "hosted_tool" ||
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
    if (
      entry.kind === "reasoning" &&
      entry.status === "streaming" &&
      entry.representation !== "redacted"
    ) {
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

function summarizeTurnTelemetry(
  turns: ExecutionViewState["completedTurnTelemetry"],
): Pick<
  ExecutionViewState,
  "telemetry" | "timeToFirstTokenWeightedMs" | "timeToFirstTokenSamples"
> {
  let telemetry = EMPTY_TELEMETRY
  let timeToFirstTokenWeightedMs = 0
  let timeToFirstTokenSamples = 0
  for (const { usage, metrics } of Object.values(turns)) {
    if (metrics?.averageTimeToFirstTokenMs !== undefined) {
      const samples = Math.max(1, metrics.modelCalls)
      timeToFirstTokenWeightedMs += metrics.averageTimeToFirstTokenMs * samples
      timeToFirstTokenSamples += samples
    }
    telemetry = addUsage(
      {
        ...telemetry,
        turns: telemetry.turns + 1,
        steps:
          telemetry.steps +
          (metrics?.modelCalls ?? 0) +
          (metrics?.toolCalls ?? 0),
        modelDurationMs:
          telemetry.modelDurationMs + (metrics?.modelDurationMs ?? 0),
        toolDurationMs:
          telemetry.toolDurationMs + (metrics?.toolDurationMs ?? 0),
      },
      usage,
    )
  }
  return {
    telemetry: {
      ...telemetry,
      ...(timeToFirstTokenSamples === 0
        ? {}
        : {
            averageTimeToFirstTokenMs: Math.round(
              timeToFirstTokenWeightedMs / timeToFirstTokenSamples,
            ),
          }),
    },
    timeToFirstTokenWeightedMs,
    timeToFirstTokenSamples,
  }
}

function addUsage(
  telemetry: SessionTelemetry,
  usage: TokenUsage | undefined,
): SessionTelemetry {
  if (usage === undefined) return telemetry
  return {
    ...telemetry,
    inputTokens: telemetry.inputTokens + usage.inputTokens,
    outputTokens: telemetry.outputTokens + usage.outputTokens,
    cacheReadInputTokens:
      telemetry.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens:
      telemetry.cacheWriteInputTokens + (usage.cacheWriteInputTokens ?? 0),
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
