import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import {
  isMateProfile,
  type MateEventEnvelope,
  type MateProfile,
} from "./events.ts"
import { isMateId, isMateRevisionId } from "./ids.ts"

export type MateRevision = MateProfile & {
  readonly createdAt: string
  readonly id: string
  readonly revision: number
}

export type MateProjection = Readonly<{
  createdAt: string
  currentRevision: MateRevision
  id: string
  seq: number
  updatedAt: string
}>

export type MateSummary = MateProjection

export function projectMate(
  events: readonly MateEventEnvelope[],
): MateProjection | undefined {
  const first = events.at(0)
  if (!first) return undefined
  requireEventIdentity(first.mateId, events)
  if (events.length > 1) {
    throw invalidReplay(
      "Mate history contains more than one mate.created.",
      events[1],
    )
  }
  requireProfile(first.data.profile, first)
  requireRevisionId(first.data.revisionId, first)

  const currentRevision: MateRevision = {
    ...first.data.profile,
    createdAt: first.createdAt,
    id: first.data.revisionId,
    revision: 1,
  }

  return {
    createdAt: first.createdAt,
    currentRevision,
    id: first.mateId,
    seq: first.seq,
    updatedAt: first.createdAt,
  }
}

function requireEventIdentity(
  mateId: string,
  events: readonly MateEventEnvelope[],
): void {
  if (!isMateId(mateId)) {
    throw invalidReplay("Mate history has an invalid mate id.", events[0])
  }
  for (const [index, event] of events.entries()) {
    if (event.mateId !== mateId) {
      throw invalidReplay("Mate event belongs to another mate.", event)
    }
    if (event.seq !== index + 1) {
      throw invalidReplay(
        `Mate event sequence must be gap-free. Expected ${index + 1}, got ${event.seq}.`,
        event,
      )
    }
  }
}

function requireRevisionId(revisionId: string, event: MateEventEnvelope): void {
  if (isMateRevisionId(revisionId)) return
  throw invalidReplay("Mate history has an invalid revision id.", event)
}

function requireProfile(profile: MateProfile, event: MateEventEnvelope): void {
  if (isMateProfile(profile)) return
  throw invalidReplay("Mate history has an invalid profile.", event)
}

function invalidReplay(message: string, event: MateEventEnvelope | undefined) {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidEventLog,
    message,
    ...(event === undefined
      ? {}
      : {
          details: {
            eventId: event.id,
            mateId: event.mateId,
            seq: event.seq,
          },
        }),
  })
}
