import { expect, it } from "vitest"
import type { EventStore } from "../../src/kernel/event-store.ts"
import { EventType } from "../../src/kernel/events.ts"
import { fingerprintInputAdmission } from "../../src/kernel/operation.ts"

export function defineEventStoreContract(options: {
  readonly name: string
  readonly run: (test: (store: EventStore) => Promise<void>) => Promise<void>
}) {
  it(`${options.name}: writes events and projection together`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000001"
      await createSession(store, sessionId, { title: "Projected" })
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
      await createSession(store, sessionId, { title: "Rebuilt" })
      await store.appendEvent(
        sessionId,
        {
          type: EventType.InputCancelled,
          data: { inputId: "input_missing" },
        },
        { expectedSeq: 1 },
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

  it(`${options.name}: rejects fork metadata through ordinary append`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000019"
      await expect(
        store.appendEvent(
          sessionId,
          {
            type: EventType.SessionCreated,
            data: {
              parentSessionId: "session_00000000-0000-4000-8000-000000000018",
              forkedFromInputId: "input_forbidden",
              forkReason: "undo",
            },
          },
          { expectedSeq: 0 },
        ),
      ).rejects.toThrow("session.created can only be written by createSession")
      expect(await store.readEvents(sessionId)).toEqual([])
    })
  })

  it(`${options.name}: rejects stale compare-and-append`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000002"
      await createSession(store, sessionId)
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

  it(`${options.name}: returns the original event for an idempotent admission`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000003"
      await createSession(store, sessionId)
      const data = {
        requestId: "request:contract",
        inputId: "input_contract",
        role: "user" as const,
        content: { kind: "text" as const, text: "same" },
      }
      const appendOptions = {
        expectedSeq: 1,
        admission: {
          requestId: data.requestId,
          fingerprint: fingerprintInputAdmission(data),
        },
      }
      const fact = {
        type: EventType.InputAdmitted,
        data,
      } as const
      const first = await store.appendEvent(sessionId, fact, appendOptions)
      await store.appendEvent(
        sessionId,
        {
          type: EventType.InputCancelled,
          data: { inputId: "input_later" },
        },
        { expectedSeq: 2 },
      )
      const retry = await store.appendEvent(sessionId, fact, appendOptions)
      expect(retry).toEqual(first)
      expect(await store.readEvents(sessionId)).toHaveLength(3)
    })
  })

  it(`${options.name}: rejects a request id reused with a different fingerprint`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000004"
      await createSession(store, sessionId)
      const firstData = {
        requestId: "request:reused",
        inputId: "input_1",
        role: "user" as const,
        content: { kind: "text" as const, text: "first" },
      }
      await store.appendEvent(
        sessionId,
        {
          type: EventType.InputAdmitted,
          data: firstData,
        },
        {
          expectedSeq: 1,
          admission: {
            requestId: firstData.requestId,
            fingerprint: fingerprintInputAdmission(firstData),
          },
        },
      )

      const secondData = {
        ...firstData,
        inputId: "input_2",
        content: { kind: "text" as const, text: "different" },
      }
      await expect(
        store.appendEvent(
          sessionId,
          {
            type: EventType.InputAdmitted,
            data: secondData,
          },
          {
            expectedSeq: 2,
            admission: {
              requestId: secondData.requestId,
              fingerprint: fingerprintInputAdmission(secondData),
            },
          },
        ),
      ).rejects.toThrow("already admitted with different input")
    })
  })

  it(`${options.name}: reads only facts after the requested sequence`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000005"
      await createSession(store, sessionId)
      await store.appendEvent(
        sessionId,
        {
          type: EventType.InputCancelled,
          data: { inputId: "input_1" },
        },
        { expectedSeq: 1 },
      )

      expect(await store.readEvents(sessionId, { after: 1 })).toEqual([
        expect.objectContaining({ seq: 2, type: EventType.InputCancelled }),
      ])
    })
  })

  it(`${options.name}: does not expose mutable storage references`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000006"
      await createSession(store, sessionId, {
        title: "Original",
        metadata: { source: "Original" },
      })
      const event = (await store.readEvents(sessionId))[0] as unknown as {
        data: { title?: string }
      }
      const projection = (await store.readProjection(sessionId)) as unknown as {
        title?: string
        metadata?: { source?: string }
      }
      const listing = await store.listSessions()
      const listedMetadata = listing.sessions[0]?.metadata as
        | { source?: string }
        | undefined
      event.data.title = "Mutated"
      projection.title = "Mutated"
      if (listedMetadata !== undefined) listedMetadata.source = "Mutated"

      expect((await store.readEvents(sessionId))[0]).toMatchObject({
        data: { title: "Original" },
      })
      expect(await store.readProjection(sessionId)).toMatchObject({
        title: "Original",
        metadata: { source: "Original" },
      })
    })
  })

  it(`${options.name}: snapshots mutable append inputs before admission`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000011"
      await createSession(store, sessionId)
      const event = {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:snapshot",
          inputId: "input_snapshot",
          role: "user" as const,
          content: { kind: "text" as const, text: "Original" },
        },
      }
      const appendOptions = {
        expectedSeq: 1,
        admission: {
          requestId: event.data.requestId,
          fingerprint: fingerprintInputAdmission(event.data),
        },
      }
      const pending = store.appendEvent(sessionId, event, appendOptions)
      event.data.content.text = "Mutated"
      appendOptions.admission.fingerprint = "Mutated"
      const original = await pending

      expect((await store.readEvents(sessionId))[1]).toMatchObject({
        data: { content: { text: "Original" } },
      })
      expect(
        await store.appendEvent(
          sessionId,
          {
            type: EventType.InputAdmitted,
            data: {
              requestId: "request:snapshot",
              inputId: "input_retry",
              role: "user",
              content: { kind: "text", text: "Original" },
            },
          },
          {
            expectedSeq: 1,
            admission: {
              requestId: "request:snapshot",
              fingerprint: fingerprintInputAdmission({
                role: "user",
                content: { kind: "text", text: "Original" },
              }),
            },
          },
        ),
      ).toEqual(original)
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
      ).rejects.toThrow("has not been created")
      expect(await store.readEvents(sessionId)).toEqual([])
      expect(await store.readProjection(sessionId)).toBeUndefined()
    })
  })

  it(`${options.name}: deletes a session's events, projection, and listing`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000012"
      const otherId = "session_00000000-0000-4000-8000-000000000013"
      await createSession(store, sessionId, { title: "Doomed" })
      await createSession(store, otherId, { title: "Kept" })

      await store.deleteSession(sessionId)

      expect(await store.readEvents(sessionId)).toEqual([])
      expect(await store.readProjection(sessionId)).toBeUndefined()
      expect(
        (await store.listSessions()).sessions.map(
          (summary) => summary.sessionId,
        ),
      ).toEqual([otherId])
      expect(await store.readProjection(otherId)).toMatchObject({
        title: "Kept",
      })
      expect(await store.readEvents(otherId)).toHaveLength(1)
    })
  })

  it(`${options.name}: deleting a session twice is idempotent`, async () => {
    await options.run(async (store) => {
      const sessionId = "session_00000000-0000-4000-8000-000000000014"
      await createSession(store, sessionId)

      await store.deleteSession(sessionId)
      await store.deleteSession(sessionId)
      await store.deleteSession("session_00000000-0000-4000-8000-000000000015")

      expect(await store.readProjection(sessionId)).toBeUndefined()
      expect((await store.listSessions()).sessions).toEqual([])
    })
  })

  it(`${options.name}: filters the session list by working directory`, async () => {
    await options.run(async (store) => {
      const first = "session_00000000-0000-4000-8000-000000000016"
      const second = "session_00000000-0000-4000-8000-000000000017"
      const third = "session_00000000-0000-4000-8000-000000000018"
      await createSession(store, first, { workingDirectory: "/project/a" })
      await createSession(store, second, { workingDirectory: "/project/b" })
      await createSession(store, third, { workingDirectory: "/project/a" })

      const filtered = await store.listSessions({
        workingDirectory: "/project/a",
      })
      expect(
        filtered.sessions.map((summary) => summary.sessionId).sort(),
      ).toEqual([first, third].sort())
      expect(
        (await store.listSessions({ workingDirectory: "/project/nowhere" }))
          .sessions,
      ).toEqual([])
      expect(
        (await store.listSessions()).sessions
          .map((summary) => summary.sessionId)
          .sort(),
      ).toEqual([first, second, third].sort())
    })
  })
}

function createSession(
  store: EventStore,
  sessionId: string,
  data: Parameters<EventStore["createSession"]>[1]["data"] = {},
) {
  return store.createSession(sessionId, {
    type: EventType.SessionCreated,
    data,
  })
}
