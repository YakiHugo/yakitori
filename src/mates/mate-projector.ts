import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import {
  MateEventType,
  MateLifecycle,
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

export type MateProjection = {
  readonly createdAt: string
  readonly currentRevision: MateRevision
  readonly id: string
  readonly lifecycle: MateLifecycle
  readonly revisions: readonly MateRevision[]
  readonly seq: number
  readonly updatedAt: string
}

export type MateSummary = {
  readonly createdAt: string
  readonly currentRevision: MateRevision
  readonly id: string
  readonly lifecycle: MateLifecycle
  readonly seq: number
  readonly updatedAt: string
}

export function projectMate(
  events: readonly MateEventEnvelope[],
): MateProjection | undefined {
  const first = events.at(0)
  if (!first) return undefined
  requireEventIdentity(first.mateId, events)
  if (first.type !== MateEventType.Created) {
    throw invalidReplay("Mate history must start with mate.created.", first)
  }
  requireProfile(first.data.profile, first)
  requireRevisionId(first.data.revisionId, first)

  const revisions: MateRevision[] = [
    {
      ...first.data.profile,
      createdAt: first.createdAt,
      id: first.data.revisionId,
      revision: 1,
    },
  ]
  let lifecycle: MateLifecycle = MateLifecycle.Active

  for (const event of events.slice(1)) {
    if (event.type === MateEventType.Created) {
      throw invalidReplay(
        "Mate history contains more than one mate.created.",
        event,
      )
    }
    if (event.type === MateEventType.ProfileRevised) {
      if (lifecycle !== MateLifecycle.Active) {
        throw invalidReplay(
          "Inactive mates cannot revise their profile.",
          event,
        )
      }
      requireProfile(event.data.profile, event)
      const expectedRevision = revisions.length + 1
      if (event.data.revision !== expectedRevision) {
        throw invalidReplay(
          `Mate revision must be ${expectedRevision}, got ${event.data.revision}.`,
          event,
        )
      }
      requireRevisionId(event.data.revisionId, event)
      if (revisions.some((revision) => revision.id === event.data.revisionId)) {
        throw invalidReplay("Mate revision ids must be unique.", event)
      }
      revisions.push({
        ...event.data.profile,
        createdAt: event.createdAt,
        id: event.data.revisionId,
        revision: event.data.revision,
      })
      continue
    }
    if (event.type === MateEventType.LifecycleChanged) {
      if (event.data.lifecycle === lifecycle) {
        throw invalidReplay(
          `Mate lifecycle is already ${event.data.lifecycle}.`,
          event,
        )
      }
      lifecycle = event.data.lifecycle
      continue
    }
    throw invalidReplay("Mate history contains an unknown event type.", event)
  }

  const currentRevision = revisions.at(-1)
  const last = events.at(-1)
  if (!currentRevision || !last) {
    throw invalidReplay(
      "Mate history did not produce a current revision.",
      first,
    )
  }

  return {
    createdAt: first.createdAt,
    currentRevision,
    id: first.mateId,
    lifecycle,
    revisions,
    seq: last.seq,
    updatedAt: last.createdAt,
  }
}

export function summarizeMate(mate: MateProjection): MateSummary {
  return {
    createdAt: mate.createdAt,
    currentRevision: mate.currentRevision,
    id: mate.id,
    lifecycle: mate.lifecycle,
    seq: mate.seq,
    updatedAt: mate.updatedAt,
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
    code: YakitoriErrorCode.InvalidReplay,
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
