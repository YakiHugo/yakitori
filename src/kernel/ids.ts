type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

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

export type EventId = Brand<string, "EventId">
export type InputId = Brand<string, "InputId">
export type ItemId = Brand<string, "ItemId">
export type PermissionRequestId = Brand<string, "PermissionRequestId">
export type SessionId = Brand<string, "SessionId">
export type ToolCallId = Brand<string, "ToolCallId">
export type TurnId = Brand<string, "TurnId">

export type KernelId =
  | EventId
  | InputId
  | ItemId
  | PermissionRequestId
  | SessionId
  | ToolCallId
  | TurnId

export type IdForPrefix<Prefix extends IdPrefix> =
  Prefix extends typeof IdPrefix.Event
    ? EventId
    : Prefix extends typeof IdPrefix.Input
      ? InputId
      : Prefix extends typeof IdPrefix.Item
        ? ItemId
        : Prefix extends typeof IdPrefix.PermissionRequest
          ? PermissionRequestId
          : Prefix extends typeof IdPrefix.Session
            ? SessionId
            : Prefix extends typeof IdPrefix.ToolCall
              ? ToolCallId
              : Prefix extends typeof IdPrefix.Turn
                ? TurnId
                : never

export function createId<Prefix extends IdPrefix>(
  prefix: Prefix,
): IdForPrefix<Prefix> {
  return `${prefix}_${globalThis.crypto.randomUUID()}` as IdForPrefix<Prefix>
}

export function createEventId(): EventId {
  return createId(IdPrefix.Event)
}

export function createInputId(): InputId {
  return createId(IdPrefix.Input)
}

export function createItemId(): ItemId {
  return createId(IdPrefix.Item)
}

export function createPermissionRequestId(): PermissionRequestId {
  return createId(IdPrefix.PermissionRequest)
}

export function createSessionId(): SessionId {
  return createId(IdPrefix.Session)
}

export function createToolCallId(): ToolCallId {
  return createId(IdPrefix.ToolCall)
}

export function createTurnId(): TurnId {
  return createId(IdPrefix.Turn)
}

export function isIdWithPrefix(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`)
}
