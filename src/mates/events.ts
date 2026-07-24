import { createMateEventId, isMateRevisionId } from "./ids.ts"

export const MateEventType = {
  Created: "mate.created",
  LifecycleChanged: "mate.lifecycle_changed",
  ProfileRevised: "mate.profile_revised",
} as const

export const MateLifecycle = {
  Active: "active",
  Inactive: "inactive",
} as const

export type MateEventType = (typeof MateEventType)[keyof typeof MateEventType]
export type MateLifecycle = (typeof MateLifecycle)[keyof typeof MateLifecycle]

export const MateProfileLimit = {
  Instructions: 32_000,
  Label: 100,
} as const

export type MateProfile = {
  readonly instructions: string
  readonly name: string
  readonly role: string
}

export function isMateProfile(value: unknown): value is MateProfile {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["instructions", "name", "role"]) &&
    typeof value.instructions === "string" &&
    value.instructions.length <= MateProfileLimit.Instructions &&
    isLabel(value.name) &&
    isLabel(value.role)
  )
}

export type MateCreatedEvent = {
  readonly type: typeof MateEventType.Created
  readonly data: {
    readonly profile: MateProfile
    readonly revisionId: string
  }
}

export type MateProfileRevisedEvent = {
  readonly type: typeof MateEventType.ProfileRevised
  readonly data: {
    readonly profile: MateProfile
    readonly revision: number
    readonly revisionId: string
  }
}

export type MateLifecycleChangedEvent = {
  readonly type: typeof MateEventType.LifecycleChanged
  readonly data: {
    readonly lifecycle: MateLifecycle
  }
}

export type MateEvent =
  | MateCreatedEvent
  | MateProfileRevisedEvent
  | MateLifecycleChangedEvent

type MateEventEnvelopeBase = {
  readonly createdAt: string
  readonly id: string
  readonly mateId: string
  readonly seq: number
  readonly version: number
}

export type MateEventEnvelope = MateEventEnvelopeBase & MateEvent

export type MateEventEnvelopeInput = {
  readonly createdAt?: string
  readonly event: MateEvent
  readonly id?: string
  readonly mateId: string
  readonly seq: number
  readonly version?: number
}

export function createMateEventEnvelope(
  input: MateEventEnvelopeInput,
): MateEventEnvelope {
  if (!Number.isInteger(input.seq) || input.seq <= 0) {
    throw new RangeError("Mate event sequence must be a positive integer.")
  }
  if (!Number.isInteger(input.version ?? 1) || (input.version ?? 1) <= 0) {
    throw new RangeError("Mate event version must be a positive integer.")
  }

  const envelope = {
    createdAt: input.createdAt ?? new Date().toISOString(),
    id: input.id ?? createMateEventId(),
    mateId: input.mateId,
    seq: input.seq,
    version: input.version ?? 1,
  }
  const event = requireMateEvent(input.event)
  if (event.type === MateEventType.Created) {
    return { ...envelope, type: event.type, data: event.data }
  }
  if (event.type === MateEventType.ProfileRevised) {
    return { ...envelope, type: event.type, data: event.data }
  }
  return { ...envelope, type: event.type, data: event.data }
}

export function requireMateEvent(value: unknown): MateEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "data"]) ||
    !isRecord(value.data)
  ) {
    throw new TypeError("Mate event is invalid.")
  }
  if (
    value.type === MateEventType.Created &&
    hasExactKeys(value.data, ["profile", "revisionId"]) &&
    isMateProfile(value.data.profile) &&
    typeof value.data.revisionId === "string" &&
    isMateRevisionId(value.data.revisionId)
  ) {
    return {
      type: value.type,
      data: {
        profile: copyProfile(value.data.profile),
        revisionId: value.data.revisionId,
      },
    }
  }
  if (
    value.type === MateEventType.ProfileRevised &&
    hasExactKeys(value.data, ["profile", "revision", "revisionId"]) &&
    isMateProfile(value.data.profile) &&
    Number.isInteger(value.data.revision) &&
    typeof value.data.revision === "number" &&
    value.data.revision > 0 &&
    typeof value.data.revisionId === "string" &&
    isMateRevisionId(value.data.revisionId)
  ) {
    return {
      type: value.type,
      data: {
        profile: copyProfile(value.data.profile),
        revision: value.data.revision,
        revisionId: value.data.revisionId,
      },
    }
  }
  if (
    value.type === MateEventType.LifecycleChanged &&
    hasExactKeys(value.data, ["lifecycle"]) &&
    Object.values(MateLifecycle).includes(value.data.lifecycle as MateLifecycle)
  ) {
    return {
      type: value.type,
      data: { lifecycle: value.data.lifecycle as MateLifecycle },
    }
  }
  throw new TypeError("Mate event is invalid.")
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MateProfileLimit.Label
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function copyProfile(profile: MateProfile): MateProfile {
  return {
    instructions: profile.instructions,
    name: profile.name,
    role: profile.role,
  }
}
