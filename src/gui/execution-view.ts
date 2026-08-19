import {
  type EventEnvelope,
  isKernelEvent,
  type StoredEventEnvelope,
  type TokenUsage,
} from "../kernel/events.ts"
import type { LiveSessionEvent } from "../runtime/live-events.ts"
import type { ApiSessionDetail } from "../server/protocol.ts"

export type ExecutionEntry =
  | {
      readonly kind: "user_input"
      readonly inputId: string
      readonly text: string
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
      readonly name: string
      readonly summary: string
      readonly input: unknown
      readonly state: string
      readonly output?: unknown
      readonly resultText?: string
      readonly resultError?: boolean
      readonly resultErrorMessage?: string
      readonly diff?: ToolDiff
      readonly commandResult?: CommandResult
    }
  | {
      readonly kind: "permission"
      readonly permissionRequestId: string
      readonly turnId: string
      readonly toolCallId: string
      readonly action: string
      readonly subject?: string
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
  readonly activeTurnStartedAt?: string
  readonly activeActivity?: ActiveTurnActivity
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
  readonly session?: ApiSessionDetail
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
        readonly session?: ApiSessionDetail
      }
    | { readonly type: "transient"; readonly event: LiveSessionEvent }
    | { readonly type: "session"; readonly session: ApiSessionDetail },
): ExecutionViewState {
  if (action.type === "session") {
    return { ...state, session: action.session }
  }
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

  const existing = state.durableEvents.find(
    (event) =>
      event.id === action.event.id ||
      (event.sessionId === action.event.sessionId &&
        event.seq === action.event.seq),
  )
  if (existing) {
    return action.session === undefined
      ? state
      : { ...state, session: action.session }
  }

  const durableEvents = [...state.durableEvents, action.event].sort(
    (left, right) => left.seq - right.seq,
  )

  // Drop completed stream bubbles when the durable assistant fact arrives.
  let snapshots = state.snapshots
  let reasoningSnapshots = state.reasoningSnapshots
  const event = knownEvent(action.event)
  if (
    event?.type === "assistant.message" &&
    typeof event.data.providerMetadata?.streamId === "string"
  ) {
    const { [event.data.providerMetadata.streamId]: _, ...rest } = snapshots
    snapshots = rest
    const {
      [event.data.providerMetadata.streamId]: _reasoning,
      ...reasoningRest
    } = reasoningSnapshots
    reasoningSnapshots = reasoningRest
  }
  if (
    event?.type === "turn.completed" ||
    event?.type === "turn.failed" ||
    event?.type === "turn.cancelled" ||
    event?.type === "turn.interrupted"
  ) {
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
    ...(action.session === undefined
      ? state.session === undefined
        ? {}
        : { session: state.session }
      : { session: action.session }),
  }
}

export function projectExecutionView(state: ExecutionViewState): ExecutionView {
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
  let lastModel:
    | { readonly provider: string; readonly model: string }
    | undefined
  let lastTurnUsage: TokenUsage | undefined

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
      const context = event.data.executionContext
      if (context !== undefined) {
        lastModel = { provider: context.provider, model: context.model }
      }
      continue
    }
    if (event.type === "turn.completed") {
      terminalTurnIds.add(event.data.turnId)
      if (event.data.usage !== undefined) lastTurnUsage = event.data.usage
      continue
    }
    if (event.type === "assistant.message") {
      const streamId =
        typeof event.data.providerMetadata?.streamId === "string"
          ? event.data.providerMetadata.streamId
          : undefined
      if (streamId) streamIdsSeen.add(streamId)
      for (const [index, block] of event.data.content.entries()) {
        if (block.type !== "reasoning" || block.text.length === 0) continue
        entries.push({
          kind: "reasoning",
          itemId: `${event.data.messageId}:reasoning:${index}`,
          text: block.text,
          status: "completed",
          at: event.createdAt,
        })
      }
      const text = event.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
      if (text.length > 0) {
        entries.push({
          kind: "assistant",
          itemId: event.data.messageId,
          ...(streamId === undefined ? {} : { streamId }),
          text,
          status: "completed",
          at: event.createdAt,
        })
      }
      continue
    }
    if (event.type === "tool.call") {
      const entry: Extract<ExecutionEntry, { readonly kind: "tool" }> = {
        kind: "tool",
        toolCallId: event.data.toolCallId,
        turnId: event.data.turnId,
        name: event.data.name,
        summary: summarizeTool(event.data.name, event.data.input),
        input: event.data.input,
        state: "requested",
      }
      tools.set(event.data.toolCallId, entry)
      entries.push(entry)
      continue
    }
    if (event.type === "tool.result") {
      const structured = parseToolOutput(
        event.data.output,
        state.session?.workingDirectory,
      )
      updateTool(tools, entries, event.data.toolCallId, {
        state: event.data.error === undefined ? "completed" : "failed",
        ...(event.data.output === undefined
          ? {}
          : { output: event.data.output }),
        resultText:
          event.data.content.kind === "text"
            ? event.data.content.text
            : JSON.stringify(event.data.content.value),
        ...(event.data.error === undefined ? {} : { resultError: true }),
        ...(event.data.error === undefined
          ? {}
          : { resultErrorMessage: event.data.error.message }),
        ...(structured.diff === undefined ? {} : { diff: structured.diff }),
        ...(structured.commandResult === undefined
          ? {}
          : { commandResult: structured.commandResult }),
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
    if (event.type === "turn.failed") {
      terminalTurnIds.add(event.data.turnId)
      markPendingPermissionsStale(permissions, entries, event.data.turnId)
      entries.push({
        kind: "turn_terminal",
        turnId: event.data.turnId,
        state: "failed",
        message: event.data.error.message,
      })
      continue
    }
    if (event.type === "turn.cancelled") {
      terminalTurnIds.add(event.data.turnId)
      markPendingPermissionsStale(permissions, entries, event.data.turnId)
      entries.push({
        kind: "turn_terminal",
        turnId: event.data.turnId,
        state: "cancelled",
        message: event.data.reason ?? "Turn cancelled.",
      })
      continue
    }
    if (event.type === "turn.interrupted") {
      terminalTurnIds.add(event.data.turnId)
      markPendingPermissionsStale(permissions, entries, event.data.turnId)
      for (const tool of tools.values()) {
        if (tool.turnId !== event.data.turnId || tool.state !== "requested") {
          continue
        }
        updateTool(tools, entries, tool.toolCallId, {
          state: "interrupted",
          resultText:
            "Interrupted before a result was recorded. Side effects may be unknown.",
          resultError: true,
        })
      }
      entries.push({
        kind: "turn_terminal",
        turnId: event.data.turnId,
        state: "interrupted",
        message: event.data.reason ?? "Turn interrupted.",
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
  const sessionActiveTurnId = state.session?.activeTurnId
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
    ...(state.session?.mateId === undefined
      ? {}
      : { mateId: state.session.mateId }),
    ...(state.session?.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: state.session.mateRevisionId }),
    ...(state.session?.workingDirectory === undefined
      ? {}
      : { workingDirectory: state.session.workingDirectory }),
    queuedInputIds,
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(lastTurnUsage === undefined ? {} : { lastTurnUsage }),
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
    return { kind: "running_tool", name: runningTool.name }
  }

  if (Object.values(snapshots).some((snapshot) => snapshot.turnId === turnId)) {
    return { kind: "responding" }
  }
  return { kind: "reasoning" }
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

function knownEvent(event: StoredEventEnvelope): EventEnvelope | undefined {
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

function parseToolOutput(
  output: unknown,
  workspaceRoot?: string,
): {
  readonly diff?: ToolDiff
  readonly commandResult?: CommandResult
} {
  if (!isRecord(output)) return {}
  const diff = parseDiff(output.diff)
  const commandResult = parseCommandResult(output, workspaceRoot)
  return {
    ...(diff === undefined ? {} : { diff }),
    ...(commandResult === undefined ? {} : { commandResult }),
  }
}

function parseDiff(value: unknown): ToolDiff | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.format !== "unified" ||
    typeof value.text !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined
  }
  return { text: value.text, truncated: value.truncated }
}

function parseCommandResult(
  output: Record<string, unknown>,
  workspaceRoot?: string,
): CommandResult | undefined {
  if (
    typeof output.stdout !== "string" ||
    typeof output.stderr !== "string" ||
    typeof output.truncated !== "boolean"
  ) {
    return undefined
  }
  const exitCode =
    typeof output.exitCode === "number" || output.exitCode === null
      ? output.exitCode
      : null
  const signal = typeof output.signal === "string" ? output.signal : null
  const binary = parseBinary(output.binary)
  const warnings = Array.isArray(output.warnings)
    ? output.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      )
    : undefined
  const blocked =
    isRecord(output.blocked) && typeof output.blocked.rule === "string"
      ? { rule: output.blocked.rule }
      : undefined
  return {
    exitCode,
    signal,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
    timedOut: output.timedOut === true,
    ...(typeof output.durationMs === "number"
      ? { durationMs: output.durationMs }
      : {}),
    ...(typeof output.cwd === "string"
      ? { cwd: workspaceRelativePath(workspaceRoot, output.cwd) }
      : {}),
    ...(typeof output.shell === "string" ? { shell: output.shell } : {}),
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
    ...(blocked === undefined ? {} : { blocked }),
    ...(binary === undefined ? {} : { binary }),
  }
}

function parseBinary(value: unknown): CommandResult["binary"] {
  if (!isRecord(value)) return undefined
  if (
    typeof value.stdout !== "boolean" ||
    typeof value.stderr !== "boolean" ||
    typeof value.stdoutBytes !== "number" ||
    typeof value.stderrBytes !== "number"
  ) {
    return undefined
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    stdoutBytes: value.stdoutBytes,
    stderrBytes: value.stderrBytes,
  }
}

function summarizeTool(name: string, input: unknown): string {
  if (isRecord(input)) {
    if (
      (name === "read_file" ||
        name === "edit_file" ||
        name === "write_file" ||
        name === "grep" ||
        name === "glob") &&
      typeof input.path === "string"
    ) {
      return input.path
    }
    if (name === "run_command" && typeof input.command === "string") {
      if (typeof input.description === "string") {
        return truncateLine(input.description, 80)
      }
      return truncateLine(input.command, 80)
    }
  }
  return name
}

function workspaceRelativePath(
  workspaceRoot: string | undefined,
  cwd: string,
): string {
  if (workspaceRoot === undefined) return cwd
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "")
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/$/, "")
  if (normalizedCwd === normalizedRoot) return "."
  return normalizedCwd.startsWith(`${normalizedRoot}/`)
    ? normalizedCwd.slice(normalizedRoot.length + 1)
    : cwd
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length <= max
    ? singleLine
    : `${singleLine.slice(0, max - 1)}…`
}
