import {
  isKernelEvent,
  type EventEnvelope,
  type StoredEventEnvelope,
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
      readonly kind: "tool"
      readonly toolCallId: string
      readonly turnId: string
      readonly name: string
      readonly input: unknown
      readonly state: string
      readonly resultText?: string
      readonly resultError?: boolean
    }
  | {
      readonly kind: "permission"
      readonly permissionRequestId: string
      readonly turnId: string
      readonly action: string
      readonly subject?: string
      readonly state: string
      readonly behavior?: string
      readonly reason?: string
    }
  | {
      readonly kind: "turn_terminal"
      readonly turnId: string
      readonly state: "failed" | "cancelled" | "interrupted"
      readonly message: string
    }

export type ExecutionView = {
  readonly entries: readonly ExecutionEntry[]
  readonly activeTurnId?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly workingDirectory?: string
  readonly pendingPermissionIds: readonly string[]
}

export type ExecutionViewState = {
  readonly durableEvents: readonly StoredEventEnvelope[]
  readonly snapshots: Readonly<Record<string, string>>
  readonly session?: ApiSessionDetail
}

export function createExecutionViewState(): ExecutionViewState {
  return {
    durableEvents: [],
    snapshots: {},
  }
}

export function reduceExecutionView(
  state: ExecutionViewState,
  action:
    | { readonly type: "reset"; readonly session?: ApiSessionDetail }
    | {
        readonly type: "durable"
        readonly event: StoredEventEnvelope
        readonly session?: ApiSessionDetail
      }
    | {
        readonly type: "durable_batch"
        readonly events: readonly StoredEventEnvelope[]
        readonly session?: ApiSessionDetail
      }
    | { readonly type: "transient"; readonly event: LiveSessionEvent }
    | { readonly type: "session"; readonly session: ApiSessionDetail },
): ExecutionViewState {
  if (action.type === "reset") {
    return {
      durableEvents: [],
      snapshots: {},
      ...(action.session === undefined ? {} : { session: action.session }),
    }
  }
  if (action.type === "session") {
    return { ...state, session: action.session }
  }
  if (action.type === "transient") {
    if (action.event.type !== "assistant.snapshot") return state
    return {
      ...state,
      snapshots: {
        ...state.snapshots,
        [action.event.streamId]: action.event.text,
      },
    }
  }
  if (action.type === "durable_batch") {
    return action.events.reduce(
      (current, event) =>
        reduceExecutionView(current, {
          type: "durable",
          event,
          ...(action.session === undefined ? {} : { session: action.session }),
        }),
      state,
    )
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
  const event = knownEvent(action.event)
  if (
    event?.type === "assistant.message" &&
    typeof event.data.providerMetadata?.streamId === "string"
  ) {
    const { [event.data.providerMetadata.streamId]: _, ...rest } = snapshots
    snapshots = rest
  }

  return {
    durableEvents,
    snapshots,
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

  for (const stored of state.durableEvents) {
    const event = knownEvent(stored)
    if (!event) continue
    if (event.type === "input.admitted" && event.data.role === "user") {
      entries.push({
        kind: "user_input",
        inputId: event.data.inputId,
        text: event.data.content.text,
        at: event.createdAt,
      })
      continue
    }
    if (event.type === "assistant.message") {
      const streamId =
        typeof event.data.providerMetadata?.streamId === "string"
          ? event.data.providerMetadata.streamId
          : undefined
      if (streamId) streamIdsSeen.add(streamId)
      entries.push({
        kind: "assistant",
        itemId: event.data.messageId,
        ...(streamId === undefined ? {} : { streamId }),
        text: event.data.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
        status: "completed",
        at: event.createdAt,
      })
      continue
    }
    if (event.type === "tool.call") {
      const entry: Extract<ExecutionEntry, { readonly kind: "tool" }> = {
        kind: "tool",
        toolCallId: event.data.toolCallId,
        turnId: event.data.turnId,
        name: event.data.name,
        input: event.data.input,
        state: "requested",
      }
      tools.set(event.data.toolCallId, entry)
      entries.push(entry)
      continue
    }
    if (event.type === "tool.result") {
      updateTool(tools, entries, event.data.toolCallId, {
        state: event.data.error === undefined ? "completed" : "failed",
        resultText:
          event.data.content.kind === "text"
            ? event.data.content.text
            : JSON.stringify(event.data.content.value),
        ...(event.data.error === undefined ? {} : { resultError: true }),
      })
      continue
    }
    if (event.type === "permission.requested") {
      const entry: Extract<ExecutionEntry, { readonly kind: "permission" }> = {
        kind: "permission",
        permissionRequestId: event.data.permissionRequestId,
        turnId: event.data.turnId,
        action: event.data.action,
        ...(event.data.subject === undefined
          ? {}
          : { subject: event.data.subject }),
        state: "requested",
        ...(event.data.reason === undefined
          ? {}
          : { reason: event.data.reason }),
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
    }
  }

  for (const [streamId, text] of Object.entries(state.snapshots)) {
    if (streamIdsSeen.has(streamId)) continue
    entries.push({
      kind: "assistant",
      streamId,
      text,
      status: "streaming",
      at: new Date().toISOString(),
    })
  }

  const pendingPermissionIds = entries
    .filter(
      (entry): entry is Extract<ExecutionEntry, { kind: "permission" }> =>
        entry.kind === "permission" && entry.state === "requested",
    )
    .map((entry) => entry.permissionRequestId)

  return {
    entries,
    ...(state.session?.activeTurnId === undefined
      ? {}
      : { activeTurnId: state.session.activeTurnId }),
    ...(state.session?.mateId === undefined
      ? {}
      : { mateId: state.session.mateId }),
    ...(state.session?.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: state.session.mateRevisionId }),
    ...(state.session?.workingDirectory === undefined
      ? {}
      : { workingDirectory: state.session.workingDirectory }),
    pendingPermissionIds,
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
