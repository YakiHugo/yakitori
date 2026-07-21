import { describe, expect, it } from "vitest"
import {
  createInputId,
  createSessionId,
  EventType,
  InputRole,
  type EventStore,
  type KernelEvent,
  YakitoriErrorCode,
} from "../../src/index.ts"

export function defineEventStoreContract(options: {
  readonly name: string
  readonly withStore: (
    run: (store: EventStore) => Promise<void>,
  ) => Promise<void>
}): void {
  describe(`event store contract (${options.name})`, () => {
    it("returns empty results before any session exists", async () => {
      await options.withStore(async (store) => {
        expect(await store.readEvents(createSessionId())).toEqual([])
        expect(await store.listSessions()).toEqual({ sessions: [] })
      })
    })

    it("persists ordered events and session summaries", async () => {
      await options.withStore(async (store) => {
        const sessionId = createSessionId()
        const created = await store.appendEvent(
          sessionId,
          sessionCreatedEvent(),
          { expectedSeq: 0 },
        )
        const appended = await store.appendEvents(
          sessionId,
          [
            {
              type: EventType.SessionMetadataUpdated,
              data: {
                title: "Contract session",
              },
            },
            inputAdmittedEvent(),
          ],
          { expectedSeq: 1 },
        )

        expect(await store.readEvents(sessionId)).toEqual([
          created,
          ...appended,
        ])
        expect(await store.listSessions()).toEqual({
          sessions: [
            {
              sessionId,
              seq: 3,
              createdAt: created.createdAt,
              updatedAt: appended[1]?.createdAt,
              title: "Contract session",
            },
          ],
        })
      })
    })

    it("paginates session summaries and validates list input", async () => {
      await options.withStore(async (store) => {
        const sessionIds = [createSessionId(), createSessionId()]
        await Promise.all(
          sessionIds.map((sessionId) =>
            store.appendEvent(sessionId, sessionCreatedEvent(), {
              expectedSeq: 0,
            }),
          ),
        )

        const firstPage = await store.listSessions({ limit: 1 })
        if (!firstPage.nextCursor) throw new Error("Expected a next cursor.")
        const secondPage = await store.listSessions({
          limit: 1,
          cursor: firstPage.nextCursor,
        })

        expect(
          [...firstPage.sessions, ...secondPage.sessions].map(
            (summary) => summary.sessionId,
          ),
        ).toEqual(expect.arrayContaining(sessionIds))
        expect(secondPage.nextCursor).toBeUndefined()
        await expect(store.listSessions({ limit: 0 })).rejects.toThrow(
          "Session list limit must be an integer from 1 to 100.",
        )
        await expect(store.listSessions({ cursor: "missing" })).rejects.toThrow(
          "Session list cursor is invalid.",
        )
      })
    })

    it("returns the original event for an idempotent receipt", async () => {
      await options.withStore(async (store) => {
        const sessionId = createSessionId()
        await store.appendEvent(sessionId, sessionCreatedEvent(), {
          expectedSeq: 0,
        })
        const first = await store.appendEvent(sessionId, inputAdmittedEvent(), {
          expectedSeq: 1,
          operation: {
            id: "input.admit:request_contract-retry",
            fingerprint: "same-payload",
          },
        })
        await store.appendEvent(
          sessionId,
          {
            type: EventType.SessionMetadataUpdated,
            data: { title: "Later write" },
          },
          { expectedSeq: 2 },
        )

        expect(
          await store.appendEvent(sessionId, inputAdmittedEvent(), {
            expectedSeq: 1,
            operation: {
              id: "input.admit:request_contract-retry",
              fingerprint: "same-payload",
            },
          }),
        ).toEqual(first)
        await expect(
          store.appendEvent(sessionId, inputAdmittedEvent(), {
            expectedSeq: 3,
            operation: {
              id: "input.admit:request_contract-retry",
              fingerprint: "changed-payload",
            },
          }),
        ).rejects.toMatchObject({
          code: YakitoriErrorCode.InvalidState,
        })
        expect(await store.readEvents(sessionId)).toHaveLength(3)
      })
    })

    it("rejects a stale expectedSeq append", async () => {
      await options.withStore(async (store) => {
        const sessionId = createSessionId()
        await store.appendEvent(sessionId, sessionCreatedEvent(), {
          expectedSeq: 0,
        })
        await store.appendEvent(
          sessionId,
          {
            type: EventType.SessionMetadataUpdated,
            data: { title: "First writer" },
          },
          { expectedSeq: 1 },
        )

        await expect(
          store.appendEvent(
            sessionId,
            {
              type: EventType.SessionMetadataUpdated,
              data: { title: "Stale writer" },
            },
            { expectedSeq: 1 },
          ),
        ).rejects.toMatchObject({
          code: YakitoriErrorCode.InvalidState,
        })
        expect(await store.readEvents(sessionId)).toHaveLength(2)
      })
    })
  })
}

function sessionCreatedEvent(): KernelEvent {
  return {
    type: EventType.SessionCreated,
    data: {
      title: "Yakitori",
    },
  }
}

function inputAdmittedEvent(): KernelEvent {
  return {
    type: EventType.InputAdmitted,
    data: {
      inputId: createInputId(),
      role: InputRole.User,
      content: {
        kind: "text",
        text: "store this input",
      },
    },
  }
}
