export const MateIdPrefix = {
  Event: "mate_event",
  Mate: "mate",
  Revision: "mate_revision",
} as const

export function createMateEventId(): string {
  return createPrefixedId(MateIdPrefix.Event)
}

export function createMateId(): string {
  return createPrefixedId(MateIdPrefix.Mate)
}

export function createMateRevisionId(): string {
  return createPrefixedId(MateIdPrefix.Revision)
}

export function isMateId(value: string): boolean {
  return isGeneratedId(value, MateIdPrefix.Mate)
}

export function isMateEventId(value: string): boolean {
  return isGeneratedId(value, MateIdPrefix.Event)
}

export function isMateRevisionId(value: string): boolean {
  return isGeneratedId(value, MateIdPrefix.Revision)
}

function createPrefixedId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

function isGeneratedId(value: string, prefix: string): boolean {
  return new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  ).test(value)
}
