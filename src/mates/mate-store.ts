import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import type { MateEvent, MateEventEnvelope } from "./events.ts"
import type { MateSummary } from "./mate-projector.ts"

export type MateStore = {
  appendEvent(
    mateId: string,
    event: MateEvent,
    options?: MateStoreAppendOptions,
  ): Promise<MateEventEnvelope>
  listMates(input?: MateStoreListInput): Promise<MateStoreListResult>
  readEvents(mateId: string): Promise<readonly MateEventEnvelope[]>
}

export type MateStoreAppendOptions = {
  readonly expectedSeq?: number
}

export type MateStoreListInput = {
  readonly cursor?: string
  readonly limit?: number
}

export type MateStoreListResult = {
  readonly mates: readonly MateSummary[]
  readonly nextCursor?: string
}

export function requireMateListLimit(value: number | undefined): number {
  if (value === undefined) return 50
  if (Number.isInteger(value) && value > 0 && value <= 100) return value
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate list limit must be an integer from 1 to 100.",
    details: { limit: value },
  })
}

export function invalidMateListCursor(cursor: string): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate list cursor is invalid.",
    details: { cursor },
  })
}
