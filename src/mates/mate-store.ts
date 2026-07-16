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
