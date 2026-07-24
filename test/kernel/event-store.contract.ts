import { expect, it } from "vitest"
import { EventType, type EventStore } from "../../src/index.ts"

export function defineEventStoreContract(options: {
  readonly name: string
  readonly run: (test: (store: EventStore) => Promise<void>) => Promise<void>
}) {
  it(`${options.name}: writes events and projection together`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000001"
      await store.appendEvent(
        sessionId,
        { type: EventType.SessionCreated, data: { title: "Projected" } },
        { expectedSeq: 0 },
      )
      expect(await store.readProjection(sessionId)).toMatchObject({
        id: sessionId,
        seq: 1,
        title: "Projected",
      })
    })
  })

  it(`${options.name}: persistently rebuilds a projection from facts`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-00000000000a"
      await store.appendEvents(
        sessionId,
        [
          {
            type: EventType.SessionCreated,
            data: { title: "Rebuilt" },
          },
          {
            type: EventType.InputCancelled,
            data: { inputId: "input_missing" },
          },
        ],
        { expectedSeq: 0 },
      )

      const rebuilt = await store.rebuildProjection(sessionId)

      expect(rebuilt.events).toHaveLength(2)
      expect(rebuilt.projection).toEqual(await store.readProjection(sessionId))
      expect(rebuilt.projection).toMatchObject({
        id: sessionId,
        seq: 2,
        title: "Rebuilt",
      })
    })
  })

  it(`${options.name}: rejects stale compare-and-append`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000002"
      await store.appendEvent(
        sessionId,
        { type: EventType.SessionCreated, data: {} },
        { expectedSeq: 0 },
      )
      await expect(
        store.appendEvent(
          sessionId,
          {
            type: EventType.InputCancelled,
            data: { inputId: "input_missing" },
          },
          { expectedSeq: 0 },
        ),
      ).rejects.toThrow("changed before the operation could commit")
    })
  })

  it(`${options.name}: returns the original event for an idempotent receipt`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000003"
      await store.appendEvent(
        sessionId,
        { type: EventType.SessionCreated, data: {} },
        { expectedSeq: 0 },
      )
      const options = {
        expectedSeq: 1,
        operation: { id: "input:1", fingerprint: "same" },
      }
      const fact = {
        type: EventType.InputCancelled,
        data: { inputId: "input_1" },
      } as const
      const first = await store.appendEvent(sessionId, fact, options)
      const retry = await store.appendEvent(sessionId, fact, options)
      expect(retry).toEqual(first)
      expect(await store.readEvents(sessionId)).toHaveLength(2)
    })
  })

  it(`${options.name}: rejects an operation id reused with a different fingerprint`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000004"
      await store.appendEvent(
        sessionId,
        { type: EventType.SessionCreated, data: {} },
        { expectedSeq: 0 },
      )
      await store.appendEvent(
        sessionId,
        {
          type: EventType.InputCancelled,
          data: { inputId: "input_1" },
        },
        {
          expectedSeq: 1,
          operation: { id: "operation:1", fingerprint: "first" },
        },
      )

      await expect(
        store.appendEvent(
          sessionId,
          {
            type: EventType.InputCancelled,
            data: { inputId: "input_2" },
          },
          {
            expectedSeq: 2,
            operation: { id: "operation:1", fingerprint: "different" },
          },
        ),
      ).rejects.toThrow("already used with different input")
    })
  })

  it(`${options.name}: reads only facts after the requested sequence`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000005"
      await store.appendEvents(
        sessionId,
        [
          { type: EventType.SessionCreated, data: {} },
          {
            type: EventType.InputCancelled,
            data: { inputId: "input_1" },
          },
        ],
        { expectedSeq: 0 },
      )

      expect(await store.readEvents(sessionId, { after: 1 })).toEqual([
        expect.objectContaining({ seq: 2, type: EventType.InputCancelled }),
      ])
    })
  })

  it(`${options.name}: does not expose mutable storage references`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000006"
      await store.appendEvent(
        sessionId,
        { type: EventType.SessionCreated, data: { title: "Original" } },
        { expectedSeq: 0 },
      )
      const event = (await store.readEvents(sessionId))[0] as unknown as {
        data: { title?: string }
      }
      const projection = (await store.readProjection(sessionId)) as unknown as {
        title?: string
      }
      event.data.title = "Mutated"
      projection.title = "Mutated"

      expect((await store.readEvents(sessionId))[0]).toMatchObject({
        data: { title: "Original" },
      })
      expect(await store.readProjection(sessionId)).toMatchObject({
        title: "Original",
      })
    })
  })

  it(`${options.name}: rolls back an append that cannot produce a projection`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000007"
      await expect(
        store.appendEvent(
          sessionId,
          {
            type: EventType.InputCancelled,
            data: { inputId: "input_missing" },
          },
          { expectedSeq: 0 },
        ),
      ).rejects.toThrow("projection")
      expect(await store.readEvents(sessionId)).toEqual([])
      expect(await store.readProjection(sessionId)).toBeUndefined()
    })
  })
}
