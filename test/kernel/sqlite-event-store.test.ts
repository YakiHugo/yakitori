import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionKernel, createSqliteEventStore } from "../../src/index.ts"
import { parseStoredEventEnvelope } from "../../src/kernel/event-store.ts"
import { defineEventStoreContract } from "./event-store.contract.ts"
import { createMemoryEventStore } from "./memory-event-store.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

defineEventStoreContract({
  name: "memory event store",
  run: async (test) => test(createMemoryEventStore()),
})

defineEventStoreContract({
  name: "SQLite event store",
  run: async (test) => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-store-"))
    const store = createSqliteEventStore({ rootDir })
    cleanup.push(async () => {
      store.close()
      await rm(rootDir, { recursive: true, force: true })
    })
    await test(store)
  },
})

describe("stored event tolerance", () => {
  it("preserves an unknown fact opaquely", () => {
    expect(
      parseStoredEventEnvelope(
        JSON.stringify({
          id: "event_future",
          sessionId: "session_00000000-0000-4000-8000-000000000000",
          seq: 2,
          version: 1,
          createdAt: "2026-07-24T00:00:00.000Z",
          type: "future.fact",
          data: { payload: true },
        }),
        2,
      ),
    ).toMatchObject({ type: "future.fact", data: { payload: true } })
  })

  it("preserves a known fact with a future payload opaquely", () => {
    expect(
      parseStoredEventEnvelope(
        JSON.stringify({
          id: "event_future_payload",
          sessionId: "session_00000000-0000-4000-8000-000000000000",
          seq: 2,
          version: 2,
          createdAt: "2026-07-24T00:00:00.000Z",
          type: "turn.started",
          data: { turnId: "turn_1", inputId: "input_1", future: true },
        }),
        2,
      ),
    ).toMatchObject({
      type: "turn.started",
      data: { turnId: "turn_1", inputId: "input_1", future: true },
    })
  })
})

describe("SQLite persistence", () => {
  it("repairs a deleted projection while preserving an unknown fact", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-repair-"))
    const databasePath = join(rootDir, "events.sqlite")
    const sessionId = "session_00000000-0000-4000-8000-00000000000b"
    try {
      const first = createSqliteEventStore({ databasePath })
      await first.appendEvent(
        sessionId,
        { type: "session.created", data: { title: "Repairable" } },
        { expectedSeq: 0 },
      )
      first.close()

      const database = new DatabaseSync(databasePath)
      database
        .prepare("DELETE FROM session_projections WHERE session_id = ?")
        .run(sessionId)
      database
        .prepare(`
          INSERT INTO events (session_id, seq, event_id, envelope_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          sessionId,
          2,
          "event_unknown_repair",
          JSON.stringify({
            id: "event_unknown_repair",
            sessionId,
            seq: 2,
            version: 1,
            createdAt: "2026-07-24T00:00:00.000Z",
            type: "provider.future_fact",
            data: { value: "opaque" },
          }),
        )
      database.close()

      const reopened = createSqliteEventStore({ databasePath })
      expect(await reopened.readProjection(sessionId)).toBeUndefined()
      const replayed = await createSessionKernel(reopened).replaySession({
        sessionId,
      })

      expect(replayed.events[1]).toMatchObject({
        type: "provider.future_fact",
        data: { value: "opaque" },
      })
      expect(replayed.session).toMatchObject({
        id: sessionId,
        seq: 2,
        title: "Repairable",
      })
      expect(await reopened.readProjection(sessionId)).toEqual(replayed.session)
      reopened.close()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("retains facts, projection, and operation receipts across reopen", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-reopen-"))
    const databasePath = join(rootDir, "events.sqlite")
    const sessionId = "session_00000000-0000-4000-8000-000000000008"
    const operation = {
      expectedSeq: 1,
      operation: { id: "operation:reopen", fingerprint: "same" },
    }
    const fact = {
      type: "input.cancelled" as const,
      data: { inputId: "input_1" },
    }
    try {
      const first = createSqliteEventStore({ databasePath })
      await first.appendEvent(
        sessionId,
        { type: "session.created", data: { title: "Persistent" } },
        { expectedSeq: 0 },
      )
      const original = await first.appendEvent(sessionId, fact, operation)
      first.close()

      const reopened = createSqliteEventStore({ databasePath })
      expect(await reopened.readEvents(sessionId)).toHaveLength(2)
      expect(await reopened.readProjection(sessionId)).toMatchObject({
        id: sessionId,
        seq: 2,
        title: "Persistent",
      })
      expect(await reopened.appendEvent(sessionId, fact, operation)).toEqual(
        original,
      )
      reopened.close()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("serializes compare-and-append across SQLite connections", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-cas-"))
    const databasePath = join(rootDir, "events.sqlite")
    const sessionId = "session_00000000-0000-4000-8000-000000000009"
    const first = createSqliteEventStore({ databasePath })
    const second = createSqliteEventStore({ databasePath })
    try {
      await first.appendEvent(
        sessionId,
        { type: "session.created", data: {} },
        { expectedSeq: 0 },
      )
      const attempts = await Promise.allSettled([
        first.appendEvent(
          sessionId,
          { type: "input.cancelled", data: { inputId: "input_a" } },
          { expectedSeq: 1 },
        ),
        second.appendEvent(
          sessionId,
          { type: "input.cancelled", data: { inputId: "input_b" } },
          { expectedSeq: 1 },
        ),
      ])

      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1)
      expect(
        attempts.filter((result) => result.status === "rejected"),
      ).toHaveLength(1)
      expect(await first.readEvents(sessionId)).toHaveLength(2)
      expect(await second.readProjection(sessionId)).toMatchObject({ seq: 2 })
    } finally {
      first.close()
      second.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
