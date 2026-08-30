export const IdPrefix = {
  Compaction: "compaction",
  ContextWindow: "context_window",
  Event: "event",
  Input: "input",
  Item: "item",
  Request: "request",
  Session: "session",
  Turn: "turn",
} as const

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix]

export function createCompactionId(): string {
  return createPrefixedId(IdPrefix.Compaction)
}

export function createContextWindowId(): string {
  return createPrefixedId(IdPrefix.ContextWindow)
}

export function createEventId(): string {
  return createPrefixedId(IdPrefix.Event)
}

export function createInputId(): string {
  return createPrefixedId(IdPrefix.Input)
}

export function createItemId(): string {
  return createPrefixedId(IdPrefix.Item)
}

export function createRequestId(): string {
  return createPrefixedId(IdPrefix.Request)
}

export function createSessionId(): string {
  return createPrefixedId(IdPrefix.Session)
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

export function isGeneratedSessionId(value: string): boolean {
  return /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

export function isStorageKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)
}

function createPrefixedId(prefix: IdPrefix): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}
