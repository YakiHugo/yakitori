export const IdPrefix = {
  Event: "event",
  Input: "input",
  Item: "item",
  PermissionRequest: "permission",
  Request: "request",
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

export function createRequestId(): string {
  return createPrefixedId(IdPrefix.Request)
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

export function isRequestId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function createPrefixedId(prefix: IdPrefix): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}
