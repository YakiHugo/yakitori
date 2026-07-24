import {
  createMateEventEnvelope,
  createYakitoriError,
  invalidMateListCursor,
  projectMate,
  requireMateListLimit,
  summarizeMate,
  type MateEvent,
  type MateEventEnvelope,
  type MateStore,
  type MateStoreAppendOptions,
  type MateStoreListInput,
  YakitoriErrorCode,
} from "../../src/index.ts"

export function createMemoryMateStore(): MateStore {
  const mates = new Map<string, MateEventEnvelope[]>()
  const summaries = new Map<string, ReturnType<typeof summarizeMate>>()

  return {
    async appendEvent(mateId, event, options = {}) {
      return appendEvent(mateId, event, options)
    },

    async listMates(input = {}) {
      const mateIds = Array.from(mates.keys()).sort()
      const limit = requireMateListLimit(input.limit)
      const start = requireCursorIndex(mateIds, input) + 1
      const page = mateIds.slice(start, start + limit)
      return {
        mates: page.map((mateId) => requireSummary(summaries, mateId)),
        ...(start + limit >= mateIds.length
          ? {}
          : { nextCursor: requireLastMateId(page) }),
      }
    },

    async readEvents(mateId) {
      return [...(mates.get(mateId) ?? [])]
    },
  }

  function appendEvent(
    mateId: string,
    event: MateEvent,
    options: MateStoreAppendOptions,
  ): MateEventEnvelope {
    const existing = mates.get(mateId) ?? []
    if (
      options.expectedSeq !== undefined &&
      options.expectedSeq !== existing.length
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: `Mate ${mateId} changed before the operation could commit.`,
      })
    }
    const envelope = createMateEventEnvelope({
      event,
      mateId,
      seq: existing.length + 1,
    })
    mates.set(mateId, [...existing, envelope])
    const mate = projectMate(mates.get(mateId) ?? [])
    if (!mate) throw new Error("Expected a mate projection.")
    summaries.set(mateId, summarizeMate(mate))
    return envelope
  }
}

function requireSummary(
  summaries: ReadonlyMap<string, ReturnType<typeof summarizeMate>>,
  mateId: string,
) {
  const summary = summaries.get(mateId)
  if (summary) return summary
  throw new Error(`Expected a summary for ${mateId}.`)
}

function requireCursorIndex(
  mateIds: readonly string[],
  input: MateStoreListInput,
): number {
  if (input.cursor === undefined) return -1
  const index = mateIds.indexOf(input.cursor)
  if (index >= 0) return index
  throw invalidMateListCursor(input.cursor)
}

function requireLastMateId(mateIds: readonly string[]): string {
  const mateId = mateIds.at(-1)
  if (mateId) return mateId
  throw new Error("Expected a mate list cursor.")
}
