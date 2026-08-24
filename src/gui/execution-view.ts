import {
  type ImageAttachment,
  isKernelEvent,
  type RuntimeEventEnvelope,
  type StoredEventEnvelope,
  type ToolExecutionItem,
  type TokenUsage,
  type TurnMetrics,
} from "../kernel/events.ts"
import type { LiveSessionEvent } from "../runtime/live-events.ts"
import type { ApiSessionDetail } from "../server/protocol.ts"

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
      readonly itemId?: string
      readonly streamId?: string
      readonly text: string
      readonly status: "streaming" | "completed"
      readonly at: string
    }
  | {
      readonly kind: "reasoning"
      readonly itemId?: string
      readonly streamId?: string
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
      readonly state: string
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

export type ToolDiff = {
  readonly text: string
  readonly truncated: boolean
}

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

export type ExecutionView = {
  readonly entries: readonly ExecutionEntry[]
  readonly activeTurnId?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly workingDirectory?: string
  readonly queuedInputIds: readonly string[]
  readonly lastModel?: {
    readonly provider: string
    readonly model: string
  }
  readonly lastTurnUsage?: TokenUsage
  readonly lastTurnMetrics?: TurnMetrics
  readonly telemetry: SessionTelemetry
  readonly activeTurnStartedAt?: string
  readonly activeActivity?: ActiveTurnActivity
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

export type ExecutionViewState = {
  readonly durableEvents: readonly StoredEventEnvelope[]
  readonly snapshots: Readonly<Record<string, StreamSnapshot>>
  readonly reasoningSnapshots: Readonly<Record<string, StreamSnapshot>>
}

type StreamSnapshot = {
  readonly turnId: string
  readonly text: string
  readonly createdAt: string
}

export function createExecutionViewState(): ExecutionViewState {
  return {
    durableEvents: [],
    snapshots: {},
    reasoningSnapshots: {},
  }
}

export function reduceExecutionView(
  state: ExecutionViewState,
  action:
    | {
        readonly type: "durable"
        readonly event: StoredEventEnvelope
      }
    | { readonly type: "transient"; readonly event: LiveSessionEvent },
): ExecutionViewState {
  if (action.type === "transient") {
    const key =
      action.event.type === "assistant.snapshot"
        ? "snapshots"
        : "reasoningSnapshots"
    return {
      ...state,
      [key]: {
        ...state[key],
        [action.event.streamId]: {
          turnId: action.event.turnId,
          text: action.event.text,
          createdAt: action.event.createdAt,
        },
      },
    }
  }

  const durableEvents = [...state.durableEvents, action.event].sort(
    (left, right) => left.seq - right.seq,
  )

  // Drop completed stream bubbles when the durable assistant fact arrives.
  let snapshots = state.snapshots
  let reasoningSnapshots = state.reasoningSnapshots
  const event = knownEvent(action.event)
  if (
    event?.type === "item.completed" &&
    (event.data.item.type === "agent_message" ||
      event.data.item.type === "reasoning") &&
    event.data.item.streamId !== undefined
  ) {
    if (event.data.item.type === "agent_message") {
      const { [event.data.item.streamId]: _, ...rest } = snapshots
      snapshots = rest
    } else {
      const { [event.data.item.streamId]: _, ...rest } = reasoningSnapshots
      reasoningSnapshots = rest
    }
  }
  if (event?.type === "turn.completed") {
    snapshots = Object.fromEntries(
      Object.entries(snapshots).filter(
        ([, snapshot]) => snapshot.turnId !== event.data.turnId,
      ),
    )
    reasoningSnapshots = Object.fromEntries(
      Object.entries(reasoningSnapshots).filter(
        ([, snapshot]) => snapshot.turnId !== event.data.turnId,
      ),
    )
  }

  return {
    durableEvents,
    snapshots,
    reasoningSnapshots,
  }
}

export function projectExecutionView(
  state: ExecutionViewState,
  session?: ApiSessionDetail,
): ExecutionView {
  const entries: ExecutionEntry[] = []
  const tools = new Map<
    string,
    Extract<ExecutionEntry, { readonly kind: "tool" }>
  >()
  const permissions = new Map<
    string,
    Extract<ExecutionEntry, { readonly kind: "permission" }>
  >()
  const streamIdsSeen = new Set<string>()
  const admittedInputIds: string[] = []
  const startedInputIds = new Set<string>()
  const cancelledInputIds = new Set<string>()
  const turnStartedAt = new Map<string, string>()
  const terminalTurnIds = new Set<string>()
  const lastModel:
    | { readonly provider: string; readonly model: string }
    | undefined = session?.currentModel
  let lastTurnUsage: TokenUsage | undefined
  let lastTurnMetrics: TurnMetrics | undefined
  let telemetry: SessionTelemetry = {
    turns: 0,
    steps: 0,
    modelDurationMs: 0,
    toolDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  }
  let timeToFirstTokenWeightedMs = 0
  let timeToFirstTokenSamples = 0

  for (const stored of state.durableEvents) {
    const event = knownEvent(stored)
    if (!event) continue
    if (event.type === "input.admitted") {
      admittedInputIds.push(event.data.inputId)
      if (event.data.role === "user") {
        entries.push({
          kind: "user_input",
          inputId: event.data.inputId,
          text: event.data.content.text,
          attachments: event.data.content.attachments ?? [],
          at: event.createdAt,
        })
      }
      continue
    }
    if (event.type === "input.cancelled") {
      cancelledInputIds.add(event.data.inputId)
      continue
    }
    if (event.type === "turn.started") {
      startedInputIds.add(event.data.inputId)
      turnStartedAt.set(event.data.turnId, stored.createdAt)
      continue
    }
    if (event.type === "turn.completed") {
      terminalTurnIds.add(event.data.turnId)
      if (event.data.usage !== undefined) lastTurnUsage = event.data.usage
      if (event.data.metrics !== undefined) lastTurnMetrics = event.data.metrics
      telemetry = addTerminalTelemetry(
        telemetry,
        event.data.usage,
        event.data.metrics,
      )
      if (event.data.metrics?.averageTimeToFirstTokenMs !== undefined) {
        const samples = Math.max(1, event.data.metrics.modelCalls)
        timeToFirstTokenWeightedMs +=
          event.data.metrics.averageTimeToFirstTokenMs * samples
        timeToFirstTokenSamples += samples
      }
      const outcome = event.data.outcome
      if (outcome.status !== "completed") {
        markPendingPermissionsStale(permissions, entries, event.data.turnId)
        if (outcome.status === "interrupted") {
          for (const tool of tools.values()) {
            if (
              tool.turnId !== event.data.turnId ||
              tool.state !== "requested"
            ) {
              continue
            }
            updateTool(tools, entries, tool.toolCallId, {
              state: "interrupted",
              resultText:
                "Interrupted before a result was recorded. Side effects may be unknown.",
              resultError: true,
            })
          }
        }
        entries.push({
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
        })
      }
      continue
    }
    if (
      event.type === "item.completed" &&
      (event.data.item.type === "agent_message" ||
        event.data.item.type === "reasoning")
    ) {
      const { item } = event.data
      const streamId = item.streamId
      if (streamId) streamIdsSeen.add(streamId)
      if (item.type === "reasoning") {
        if (item.text.length === 0) continue
        entries.push({
          kind: "reasoning",
          itemId: item.itemId,
          ...(streamId === undefined ? {} : { streamId }),
          text: item.text,
          status: "completed",
          at: event.createdAt,
        })
        continue
      }
      const text = item.content.map((block) => block.text).join("")
      if (text.length > 0) {
        entries.push({
          kind: "assistant",
          itemId: item.itemId,
          ...(streamId === undefined ? {} : { streamId }),
          text,
          status: "completed",
          at: event.createdAt,
        })
      }
      continue
    }
    if (event.type === "item.started") {
      const { item } = event.data
      const entry: Extract<ExecutionEntry, { readonly kind: "tool" }> = {
        kind: "tool",
        toolCallId: item.toolCallId,
        turnId: event.data.turnId,
        execution: item,
        state: "requested",
      }
      tools.set(item.toolCallId, entry)
      entries.push(entry)
      continue
    }
    if (
      event.type === "item.completed" &&
      event.data.item.type !== "agent_message" &&
      event.data.item.type !== "reasoning"
    ) {
      const { item } = event.data
      updateTool(tools, entries, item.toolCallId, {
        ...(item.type === "dynamic_tool_call" ? {} : { execution: item }),
        state: item.error === undefined ? "completed" : "failed",
        ...(item.output === undefined ? {} : { output: item.output }),
        resultText:
          item.content.kind === "text"
            ? item.content.text
            : JSON.stringify(item.content.value),
        ...(item.error === undefined ? {} : { resultError: true }),
        ...(item.error === undefined
          ? {}
          : { resultErrorMessage: item.error.message }),
      })
      continue
    }
    if (event.type === "permission.requested") {
      const entry: Extract<ExecutionEntry, { readonly kind: "permission" }> = {
        kind: "permission",
        permissionRequestId: event.data.permissionRequestId,
        turnId: event.data.turnId,
        toolCallId: event.data.toolCallId,
        action: event.data.action,
        ...(event.data.subject === undefined
          ? {}
          : { subject: event.data.subject }),
        ...(event.data.reason === undefined
          ? {}
          : { reason: event.data.reason }),
        state: "requested",
      }
      permissions.set(event.data.permissionRequestId, entry)
      entries.push(entry)
      continue
    }
    if (event.type === "permission.resolved") {
      updatePermission(permissions, entries, event.data.permissionRequestId, {
        state: "resolved",
        behavior: event.data.behavior,
      })
      continue
    }
    if (event.type === "context.compacted") {
      entries.push({
        kind: "context_compacted",
        compactionId: event.data.compactionId,
        summary: event.data.summary,
        createdAt: event.createdAt,
      })
    }
  }

  for (const [streamId, snapshot] of Object.entries(state.reasoningSnapshots)) {
    if (streamIdsSeen.has(streamId)) continue
    entries.push({
      kind: "reasoning",
      streamId,
      text: snapshot.text,
      status: "streaming",
      at: snapshot.createdAt,
    })
  }

  for (const [streamId, snapshot] of Object.entries(state.snapshots)) {
    if (streamIdsSeen.has(streamId)) continue
    entries.push({
      kind: "assistant",
      streamId,
      text: snapshot.text,
      status: "streaming",
      at: snapshot.createdAt,
    })
  }

  const queuedInputIds = admittedInputIds.filter(
    (inputId) =>
      !startedInputIds.has(inputId) && !cancelledInputIds.has(inputId),
  )
  const sessionActiveTurnId = session?.activeTurnId
  const activeTurnId =
    sessionActiveTurnId === undefined ||
    terminalTurnIds.has(sessionActiveTurnId)
      ? undefined
      : sessionActiveTurnId
  const activeTurnStartedAt =
    activeTurnId === undefined ? undefined : turnStartedAt.get(activeTurnId)
  const activeActivity =
    activeTurnId === undefined
      ? undefined
      : projectActiveActivity(activeTurnId, state.snapshots, tools, permissions)

  return {
    entries,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    ...(session?.mateId === undefined ? {} : { mateId: session.mateId }),
    ...(session?.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: session.mateRevisionId }),
    ...(session?.workingDirectory === undefined
      ? {}
      : { workingDirectory: session.workingDirectory }),
    queuedInputIds,
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(lastTurnUsage === undefined ? {} : { lastTurnUsage }),
    ...(lastTurnMetrics === undefined ? {} : { lastTurnMetrics }),
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
    ...(activeTurnStartedAt === undefined ? {} : { activeTurnStartedAt }),
    ...(activeActivity === undefined ? {} : { activeActivity }),
  }
}

function projectActiveActivity(
  turnId: string,
  snapshots: ExecutionViewState["snapshots"],
  tools: Map<string, Extract<ExecutionEntry, { readonly kind: "tool" }>>,
  permissions: Map<
    string,
    Extract<ExecutionEntry, { readonly kind: "permission" }>
  >,
): ActiveTurnActivity {
  const waitingPermission = [...permissions.values()].find(
    (permission) =>
      permission.turnId === turnId && permission.state === "requested",
  )
  if (waitingPermission !== undefined) {
    return { kind: "waiting_permission", action: waitingPermission.action }
  }

  const runningTool = [...tools.values()]
    .reverse()
    .find((tool) => tool.turnId === turnId && tool.state === "requested")
  if (runningTool !== undefined) {
    return { kind: "running_tool", name: runningTool.execution.name }
  }

  if (Object.values(snapshots).some((snapshot) => snapshot.turnId === turnId)) {
    return { kind: "responding" }
  }
  return { kind: "reasoning" }
}

function addTerminalTelemetry(
  current: SessionTelemetry,
  usage: TokenUsage | undefined,
  metrics: TurnMetrics | undefined,
): SessionTelemetry {
  return {
    turns: current.turns + 1,
    steps:
      current.steps + (metrics?.modelCalls ?? 0) + (metrics?.toolCalls ?? 0),
    modelDurationMs: current.modelDurationMs + (metrics?.modelDurationMs ?? 0),
    toolDurationMs: current.toolDurationMs + (metrics?.toolDurationMs ?? 0),
    inputTokens: current.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage?.outputTokens ?? 0),
    cacheReadInputTokens:
      current.cacheReadInputTokens + (usage?.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens:
      current.cacheWriteInputTokens + (usage?.cacheWriteInputTokens ?? 0),
  }
}

function markPendingPermissionsStale(
  permissions: Map<
    string,
    Extract<ExecutionEntry, { readonly kind: "permission" }>
  >,
  entries: ExecutionEntry[],
  turnId: string,
): void {
  for (const permission of permissions.values()) {
    if (permission.turnId !== turnId || permission.state !== "requested") {
      continue
    }
    updatePermission(permissions, entries, permission.permissionRequestId, {
      state: "stale",
    })
  }
}

function knownEvent(
  event: StoredEventEnvelope,
): RuntimeEventEnvelope | undefined {
  if (!isKernelEvent(event)) return undefined
  return event
}

function updateTool(
  tools: Map<string, Extract<ExecutionEntry, { readonly kind: "tool" }>>,
  entries: ExecutionEntry[],
  toolCallId: string,
  patch: Partial<Extract<ExecutionEntry, { readonly kind: "tool" }>>,
): void {
  const current = tools.get(toolCallId)
  if (!current) return
  const next = { ...current, ...patch }
  tools.set(toolCallId, next)
  const index = entries.findIndex(
    (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
  )
  if (index >= 0) entries[index] = next
}

function updatePermission(
  permissions: Map<
    string,
    Extract<ExecutionEntry, { readonly kind: "permission" }>
  >,
  entries: ExecutionEntry[],
  permissionRequestId: string,
  patch: Partial<Extract<ExecutionEntry, { readonly kind: "permission" }>>,
): void {
  const current = permissions.get(permissionRequestId)
  if (!current) return
  const next = { ...current, ...patch }
  permissions.set(permissionRequestId, next)
  const index = entries.findIndex(
    (entry) =>
      entry.kind === "permission" &&
      entry.permissionRequestId === permissionRequestId,
  )
  if (index >= 0) entries[index] = next
}
