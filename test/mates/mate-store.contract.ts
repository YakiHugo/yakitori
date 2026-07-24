import { describe, expect, it } from "vitest"
import {
  createMateId,
  createMateRevisionId,
  MateEventType,
  projectMate,
  summarizeMate,
  type MateEvent,
  type MateStore,
  YakitoriErrorCode,
} from "../../src/index.ts"

export function defineMateStoreContract(options: {
  readonly name: string
  readonly withStore: (
    run: (store: MateStore) => Promise<void>,
  ) => Promise<void>
}): void {
  describe(`mate store contract (${options.name})`, () => {
    it("persists events and lists summaries", async () => {
      await options.withStore(async (store) => {
        const mateId = createMateId()
        await store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 })
        const events = await store.readEvents(mateId)
        const mate = projectMate(events)
        if (!mate) throw new Error("Expected a mate projection.")

        expect(events).toHaveLength(1)
        expect(await store.listMates()).toEqual({
          mates: [summarizeMate(mate)],
        })
      })
    })

    it("paginates mate summaries and rejects invalid cursors", async () => {
      await options.withStore(async (store) => {
        const mateIds = [createMateId(), createMateId()]
        await Promise.all(
          mateIds.map((mateId) =>
            store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 }),
          ),
        )

        const first = await store.listMates({ limit: 1 })
        if (!first.nextCursor) throw new Error("Expected a next cursor.")
        const second = await store.listMates({
          cursor: first.nextCursor,
          limit: 1,
        })

        expect(
          [...first.mates, ...second.mates].map((mate) => mate.id),
        ).toEqual(expect.arrayContaining(mateIds))
        await expect(store.listMates({ limit: 0 })).rejects.toMatchObject({
          code: YakitoriErrorCode.InvalidArgument,
        })
        await expect(
          store.listMates({ cursor: createMateId() }),
        ).rejects.toMatchObject({ code: YakitoriErrorCode.InvalidArgument })
      })
    })

    it("rejects a stale expectedSeq append", async () => {
      await options.withStore(async (store) => {
        const mateId = createMateId()
        await store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 })

        await expect(
          store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 }),
        ).rejects.toMatchObject({
          code: YakitoriErrorCode.InvalidState,
        })
        expect(await store.readEvents(mateId)).toHaveLength(1)
      })
    })
  })
}

function createdEvent(): MateEvent {
  return {
    type: MateEventType.Created,
    data: {
      profile: { instructions: "Initial", name: "Momo", role: "Builder" },
      revisionId: createMateRevisionId(),
    },
  }
}
