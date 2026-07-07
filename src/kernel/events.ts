import { createEventId } from "./ids.ts"

export const EventType = {
  InputAdmitted: "input.admitted",
  InputCancelled: "input.cancelled",
  InputPromoted: "input.promoted",
  ItemAppended: "item.appended",
  ItemCompleted: "item.completed",
  ItemUpdated: "item.updated",
  PermissionCancelled: "permission.cancelled",
  PermissionRequested: "permission.requested",
  PermissionResolved: "permission.resolved",
  SessionCreated: "session.created",
  SessionMetadataUpdated: "session.metadata_updated",
  ToolCancelled: "tool.cancelled",
  ToolCompleted: "tool.completed",
  ToolFailed: "tool.failed",
  ToolProgress: "tool.progress",
  ToolRequested: "tool.requested",
  ToolStarted: "tool.started",
  TurnCancelled: "turn.cancelled",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  TurnStarted: "turn.started",
} as const

export const InputRole = {
  Runtime: "runtime",
  System: "system",
  User: "user",
} as const

export const ItemKind = {
  AssistantMessage: "assistant_message",
  Error: "error",
  Input: "input",
  Permission: "permission",
  Reasoning: "reasoning",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
} as const

export const ItemStatus = {
  Completed: "completed",
  Failed: "failed",
  InProgress: "in_progress",
} as const

export const PermissionBehavior = {
  Allow: "allow",
  AskCancelled: "ask_cancelled",
  Deny: "deny",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]
export type InputRole = (typeof InputRole)[keyof typeof InputRole]
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind]
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]
export type PermissionBehavior =
  (typeof PermissionBehavior)[keyof typeof PermissionBehavior]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type EventMetadata = JsonObject

export type TextContent = {
  readonly kind: "text"
  readonly text: string
}

export type JsonContent = {
  readonly kind: "json"
  readonly value: JsonValue
}

export type ItemContent = TextContent | JsonContent

export type KernelError = {
  readonly message: string
  readonly code?: string
  readonly details?: EventMetadata
}

export type PermissionDecisionReason = {
  readonly kind: string
  readonly message?: string
  readonly metadata?: EventMetadata
}

export type SessionCreatedEvent = {
  readonly type: typeof EventType.SessionCreated
  readonly data: {
    readonly title?: string
    readonly workingDirectory?: string
    readonly parentSessionId?: string
    readonly metadata?: EventMetadata
  }
}

export type SessionMetadataUpdatedEvent = {
  readonly type: typeof EventType.SessionMetadataUpdated
  readonly data: {
    readonly title?: string
    readonly metadata?: EventMetadata
  }
}

export type InputAdmittedEvent = {
  readonly type: typeof EventType.InputAdmitted
  readonly data: {
    readonly inputId: string
    readonly role: InputRole
    readonly content: TextContent
    readonly parentInputId?: string
    readonly metadata?: EventMetadata
  }
}

export type InputPromotedEvent = {
  readonly type: typeof EventType.InputPromoted
  readonly data: {
    readonly inputId: string
    readonly turnId: string
  }
}

export type InputCancelledEvent = {
  readonly type: typeof EventType.InputCancelled
  readonly data: {
    readonly inputId: string
    readonly reason?: string
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
    readonly outputItemId?: string
    readonly metadata?: EventMetadata
  }
}

export type TurnFailedEvent = {
  readonly type: typeof EventType.TurnFailed
  readonly data: {
    readonly turnId: string
    readonly error: KernelError
  }
}

export type TurnCancelledEvent = {
  readonly type: typeof EventType.TurnCancelled
  readonly data: {
    readonly turnId: string
    readonly reason?: string
  }
}

export type ItemAppendedEvent = {
  readonly type: typeof EventType.ItemAppended
  readonly data: {
    readonly itemId: string
    readonly turnId: string
    readonly kind: ItemKind
    readonly content: ItemContent
    readonly parentItemId?: string
    readonly status?: ItemStatus
    readonly providerMetadata?: EventMetadata
  }
}

export type ItemUpdatedEvent = {
  readonly type: typeof EventType.ItemUpdated
  readonly data: {
    readonly itemId: string
    readonly turnId: string
    readonly content?: ItemContent
    readonly metadata?: EventMetadata
  }
}

export type ItemCompletedEvent = {
  readonly type: typeof EventType.ItemCompleted
  readonly data: {
    readonly itemId: string
    readonly turnId: string
    readonly status: typeof ItemStatus.Completed | typeof ItemStatus.Failed
    readonly metadata?: EventMetadata
  }
}

export type PermissionRequestedEvent = {
  readonly type: typeof EventType.PermissionRequested
  readonly data: {
    readonly permissionRequestId: string
    readonly turnId: string
    readonly action: string
    readonly subject?: string
    readonly toolCallId?: string
    readonly reason?: string
    readonly metadata?: EventMetadata
  }
}

export type PermissionResolvedEvent = {
  readonly type: typeof EventType.PermissionResolved
  readonly data: {
    readonly permissionRequestId: string
    readonly turnId: string
    readonly behavior: PermissionBehavior
    readonly reason?: PermissionDecisionReason
    readonly metadata?: EventMetadata
  }
}

export type PermissionCancelledEvent = {
  readonly type: typeof EventType.PermissionCancelled
  readonly data: {
    readonly permissionRequestId: string
    readonly turnId: string
    readonly reason?: string
  }
}

export type ToolRequestedEvent = {
  readonly type: typeof EventType.ToolRequested
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
    readonly name: string
    readonly input: JsonValue
    readonly itemId?: string
    readonly permissionRequestId?: string
    readonly providerMetadata?: EventMetadata
  }
}

export type ToolStartedEvent = {
  readonly type: typeof EventType.ToolStarted
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
  }
}

export type ToolProgressEvent = {
  readonly type: typeof EventType.ToolProgress
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
    readonly message?: string
    readonly data?: JsonValue
  }
}

export type ToolCompletedEvent = {
  readonly type: typeof EventType.ToolCompleted
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
    readonly output: JsonValue
    readonly itemId?: string
    readonly metadata?: EventMetadata
  }
}

export type ToolFailedEvent = {
  readonly type: typeof EventType.ToolFailed
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
    readonly error: KernelError
  }
}

export type ToolCancelledEvent = {
  readonly type: typeof EventType.ToolCancelled
  readonly data: {
    readonly toolCallId: string
    readonly turnId: string
    readonly reason?: string
  }
}

export type KernelEvent =
  | SessionCreatedEvent
  | SessionMetadataUpdatedEvent
  | InputAdmittedEvent
  | InputPromotedEvent
  | InputCancelledEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | ItemAppendedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | PermissionCancelledEvent
  | ToolRequestedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolCancelledEvent

type EventEnvelopeBase = {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly version: number
  readonly createdAt: string
}

export type EventEnvelope = EventEnvelopeBase & KernelEvent

export type EventEnvelopeInput = {
  readonly sessionId: string
  readonly seq: number
  readonly event: KernelEvent
  readonly version?: number
  readonly id?: string
  readonly createdAt?: string
}

export function createEventEnvelope(input: EventEnvelopeInput): EventEnvelope {
  assertEventSequence(input.seq)
  assertEventVersion(input.version ?? 1)
  return {
    id: input.id ?? createEventId(),
    sessionId: input.sessionId,
    seq: input.seq,
    version: input.version ?? 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...input.event,
  }
}

function assertEventSequence(seq: number): void {
  if (Number.isInteger(seq) && seq > 0) return
  throw new RangeError("Event sequence must be a positive integer.")
}

function assertEventVersion(version: number): void {
  if (Number.isInteger(version) && version > 0) return
  throw new RangeError("Event version must be a positive integer.")
}
