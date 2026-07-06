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

export function createEventId(): string {
  return createPrefixedId(IdPrefix.Event)
}

export function createInputId(): string {
  return createPrefixedId(IdPrefix.Input)
}

export function createItemId(): string {
  return createPrefixedId(IdPrefix.Item)
}

export function createPermissionRequestId(): string {
  return createPrefixedId(IdPrefix.PermissionRequest)
}

export function createSessionId(): string {
  return createPrefixedId(IdPrefix.Session)
}

export function createToolCallId(): string {
  return createPrefixedId(IdPrefix.ToolCall)
}

export function createTurnId(): string {
  return createPrefixedId(IdPrefix.Turn)
}

export function isIdWithPrefix(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`)
}

function createPrefixedId(prefix: IdPrefix): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}
