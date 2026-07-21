import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  createInputId,
  createSessionId,
  createSqliteEventStore,
  EventType,
  InputRole,
  type KernelEvent,
  type SqliteEventStore,
  YakitoriErrorCode,
} from "../../src/index.ts"
import { defineEventStoreContract } from "./event-store.contract.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

describe("SQLite event store", () => {
  it("returns empty results before any session exists", async () => {
    await withStores(async (context) => {
      const store = context.open()

      expect(await store.readEvents(createSessionId())).toEqual([])
      expect(await store.listSessions()).toEqual({ sessions: [] })
    })
  })

  it("persists ordered events and session summaries across reopen", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
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
              title: "SQLite session",
            },
          },
          inputAdmittedEvent(),
        ],
        { expectedSeq: 1 },
      )
      store.close()

      const reopened = context.open()
      expect(await reopened.readEvents(sessionId)).toEqual([
        created,
        ...appended,
      ])
      expect(await reopened.listSessions()).toEqual({
        sessions: [
          {
            sessionId,
            seq: 3,
            createdAt: created.createdAt,
            updatedAt: appended[1]?.createdAt,
            title: "SQLite session",
          },
        ],
      })
    })
  })

  it("paginates session summaries and validates list input", async () => {
    await withStores(async (context) => {
      const store = context.open()
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

  it("persists idempotency receipts and returns the original event", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
      await store.appendEvent(sessionId, sessionCreatedEvent(), {
        expectedSeq: 0,
      })
      const first = await store.appendEvent(sessionId, inputAdmittedEvent(), {
        expectedSeq: 1,
        operation: {
          id: "input.admit:request_sqlite-retry",
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
      store.close()

      const reopened = context.open()
      expect(
        await reopened.appendEvent(sessionId, inputAdmittedEvent(), {
          expectedSeq: 1,
          operation: {
            id: "input.admit:request_sqlite-retry",
            fingerprint: "same-payload",
          },
        }),
      ).toEqual(first)
      await expect(
        reopened.appendEvent(sessionId, inputAdmittedEvent(), {
          expectedSeq: 3,
          operation: {
            id: "input.admit:request_sqlite-retry",
            fingerprint: "changed-payload",
          },
        }),
      ).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidState,
      })
      expect(await reopened.readEvents(sessionId)).toHaveLength(3)
    })
  })

  it("validates stored events before replaying an operation receipt", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
      await store.appendEvent(sessionId, sessionCreatedEvent(), {
        expectedSeq: 0,
      })
      const admitted = await store.appendEvent(
        sessionId,
        inputAdmittedEvent(),
        {
          expectedSeq: 1,
          operation: {
            id: "input.admit:request_sqlite-corrupt-retry",
            fingerprint: "same-payload",
          },
        },
      )
      overwriteStoredEnvelope(
        context.rootDir,
        sessionId,
        JSON.stringify({ ...admitted, seq: 9 }),
        2,
      )

      await expect(
        store.appendEvent(sessionId, inputAdmittedEvent(), {
          expectedSeq: 2,
          operation: {
            id: "input.admit:request_sqlite-corrupt-retry",
            fingerprint: "same-payload",
          },
        }),
      ).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidEventLog,
        details: {
          expectedSeq: 2,
          actualSeq: 9,
        },
      })
    })
  })

  it("rejects a stale compare-and-append across independent connections", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const first = context.open()
      const second = context.open()
      await first.appendEvent(sessionId, sessionCreatedEvent(), {
        expectedSeq: 0,
      })

      const results = await Promise.allSettled([
        first.appendEvent(
          sessionId,
          {
            type: EventType.SessionMetadataUpdated,
            data: { title: "First writer" },
          },
          { expectedSeq: 1 },
        ),
        second.appendEvent(
          sessionId,
          {
            type: EventType.SessionMetadataUpdated,
            data: { title: "Second writer" },
          },
          { expectedSeq: 1 },
        ),
      ])

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: YakitoriErrorCode.InvalidState,
          }),
        }),
      ])
      expect(await first.readEvents(sessionId)).toHaveLength(2)
    })
  })

  it("rejects invalid session ids before querying storage", async () => {
    await withStores(async (context) => {
      const store = context.open()

      await expect(store.readEvents("../../outside")).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidArgument,
        details: {
          sessionId: "../../outside",
        },
      })
    })
  })

  it("rejects corrupted stored event JSON", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
      await store.appendEvent(sessionId, sessionCreatedEvent(), {
        expectedSeq: 0,
      })
      overwriteStoredEnvelope(context.rootDir, sessionId, "{not json}")

      await expect(store.readEvents(sessionId)).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidEventLog,
        message: "Invalid event JSON at record 1.",
        details: {
          recordNumber: 1,
        },
        cause: expect.any(SyntaxError),
      })
    })
  })

  it("rejects corrupted payloads and sequence gaps", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
      const event = await store.appendEvent(sessionId, sessionCreatedEvent(), {
        expectedSeq: 0,
      })
      overwriteStoredEnvelope(
        context.rootDir,
        sessionId,
        JSON.stringify({
          ...event,
          type: EventType.InputAdmitted,
          data: {},
        }),
      )

      await expect(store.readEvents(sessionId)).rejects.toThrow(
        "Invalid event data for input.admitted at record 1.",
      )

      overwriteStoredEnvelope(
        context.rootDir,
        sessionId,
        JSON.stringify({
          ...event,
          seq: 2,
        }),
      )
      await expect(store.readEvents(sessionId)).rejects.toThrow(
        "Event sequence must be gap-free. Expected 1, got 2.",
      )
    })
  })

  it("rejects session summaries without a creation event", async () => {
    await withStores(async (context) => {
      const sessionId = createSessionId()
      const store = context.open()
      await store.appendEvent(sessionId, inputAdmittedEvent(), {
        expectedSeq: 0,
      })

      await expect(store.listSessions()).rejects.toThrow(
        "Session log must start with session.created.",
      )
    })
  })
})

async function withStores(
  run: (context: {
    readonly rootDir: string
    readonly open: () => SqliteEventStore
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-sqlite-"))
  const stores: SqliteEventStore[] = []

  try {
    await run({
      rootDir,
      open() {
        const store = createSqliteEventStore({ rootDir })
        stores.push(store)
        return store
      },
    })
  } finally {
    for (const store of stores) store.close()
    await rm(rootDir, { recursive: true, force: true })
  }
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

function overwriteStoredEnvelope(
  rootDir: string,
  sessionId: string,
  envelope: string,
  seq = 1,
): void {
  const database = new DatabaseSync(join(rootDir, "events.sqlite"))
  database
    .prepare(
      "UPDATE events SET envelope_json = ? WHERE session_id = ? AND seq = ?",
    )
    .run(envelope, sessionId, seq)
  database.close()
}

defineEventStoreContract({
  name: "memory",
  withStore: async (run) => {
    await run(createMemoryEventStore())
  },
})

defineEventStoreContract({
  name: "sqlite",
  withStore: async (run) => {
    await withStores(async (context) => {
      await run(context.open())
    })
  },
})
