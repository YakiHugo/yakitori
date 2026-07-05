export const IdPrefix = {
  Event: "event",
  Input: "input",
  Item: "item",
  PermissionRequest: "permission",
  Session: "session",
  ToolCall: "tool",
  Turn: "turn",
} as const

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix]

export type EventId = string & { readonly __brand: "EventId" }
export type InputId = string & { readonly __brand: "InputId" }
export type ItemId = string & { readonly __brand: "ItemId" }
export type PermissionRequestId = string & {
  readonly __brand: "PermissionRequestId"
}
export type SessionId = string & { readonly __brand: "SessionId" }
export type ToolCallId = string & { readonly __brand: "ToolCallId" }
export type TurnId = string & { readonly __brand: "TurnId" }

export type KernelId =
  | EventId
  | InputId
  | ItemId
  | PermissionRequestId
  | SessionId
  | ToolCallId
  | TurnId

export function createEventId(): EventId {
  return createPrefixedId(IdPrefix.Event) as EventId
}

export function createInputId(): InputId {
  return createPrefixedId(IdPrefix.Input) as InputId
}

export function createItemId(): ItemId {
  return createPrefixedId(IdPrefix.Item) as ItemId
}

export function createPermissionRequestId(): PermissionRequestId {
  return createPrefixedId(IdPrefix.PermissionRequest) as PermissionRequestId
}

export function createSessionId(): SessionId {
  return createPrefixedId(IdPrefix.Session) as SessionId
}

export function createToolCallId(): ToolCallId {
  return createPrefixedId(IdPrefix.ToolCall) as ToolCallId
}

export function createTurnId(): TurnId {
  return createPrefixedId(IdPrefix.Turn) as TurnId
}

export function isIdWithPrefix(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`)
}

function createPrefixedId(prefix: IdPrefix): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}
