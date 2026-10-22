import { describe, expect, it } from "vitest"
import { YakitoriErrorCode } from "../../src/kernel/errors.ts"
import { type MateEvent, MateEventType } from "../../src/mates/events.ts"
import { createMateId, createMateRevisionId } from "../../src/mates/ids.ts"
import type { MateStore } from "../../src/mates/mate-store.ts"

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
        const event = createdEvent()
        const created = await store.appendEvent(mateId, event, {
          expectedSeq: 0,
        })
        const events = await store.readEvents(mateId)
        expect(events).toEqual([
          {
            id: created.id,
            mateId,
            seq: 1,
            version: 1,
            createdAt: created.createdAt,
            ...event,
          },
        ])
        expect(await store.listMates()).toEqual({
          mates: [
            {
              id: mateId,
              seq: 1,
              createdAt: created.createdAt,
              updatedAt: created.createdAt,
              currentRevision: {
                ...event.data.profile,
                id: event.data.revisionId,
                revision: 1,
                createdAt: created.createdAt,
              },
            },
          ],
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

    it("keeps the committed history and summary unchanged when replay rejects an append", async () => {
      await options.withStore(async (store) => {
        const mateId = createMateId()
        const created = await store.appendEvent(mateId, createdEvent(), {
          expectedSeq: 0,
        })
        const before = await store.listMates()

        await expect(
          store.appendEvent(mateId, createdEvent(), { expectedSeq: 1 }),
        ).rejects.toMatchObject({ code: YakitoriErrorCode.InvalidEventLog })

        expect(await store.readEvents(mateId)).toEqual([created])
        expect(await store.listMates()).toEqual(before)
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
