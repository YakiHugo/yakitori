import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applySessionFacts,
  createJsonlEventStore,
  type EventEnvelope,
  EventType,
  type KernelEvent,
  TurnState,
  YakitoriErrorCode,
} from "../../src/index.ts"
import { parseStoredEventEnvelope } from "../../src/kernel/event-store.ts"
import {
  type JournalCommitRecord,
  parseJournalLine,
  serializeFactLine,
} from "../../src/kernel/jsonl-event-store-format.ts"
import { fingerprintInputAdmission } from "../../src/kernel/operation.ts"
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
  name: "JSONL event store",
  run: async (test) => {
    const fixture = await createStoreFixture("yakitori-store-")
    await test(fixture.store)
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

describe("Session journal format", () => {
  const fact = {
    id: "event_format",
    sessionId: "session_00000000-0000-4000-8000-000000000000",
    seq: 1,
    version: 1,
    createdAt: "2026-07-30T00:00:00.000Z",
    type: EventType.SessionCreated,
    data: { title: "Format" },
  } as const

  it("round-trips a flat fact line", () => {
    const line = serializeFactLine(fact)

    expect(line.endsWith("\n")).toBe(true)
    expect(parseJournalLine(line, 1)).toEqual(fact)
  })

  it("parses a legacy commit line for read compatibility", () => {
    const record: JournalCommitRecord = {
      record: "commit",
      version: 1,
      sessionId: fact.sessionId,
      firstSeq: 1,
      operation: { id: "legacy-request", fingerprint: "legacy" },
      events: [fact],
    }

    expect(parseJournalLine(JSON.stringify(record), 1)).toEqual(record)
  })

  it("rejects malformed JSON and extra fact-envelope keys", () => {
    expect(() => parseJournalLine('{"id":', 3)).toThrow(
      "Invalid Session journal JSON at record 3",
    )
    expect(() =>
      parseJournalLine(JSON.stringify({ ...fact, extra: true }), 4),
    ).toThrow("Invalid Session fact at record 4")
  })

  it("routes the reserved record key only to the legacy validator", () => {
    expect(() =>
      parseJournalLine(
        JSON.stringify({ ...fact, record: "future-framing" }),
        5,
      ),
    ).toThrow("Invalid Session journal record 5")
  })
})

describe("JSONL persistence", () => {
  it("stores one flat physical line per fact", async () => {
    const fixture = await createStoreFixture("yakitori-record-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000b"

    await fixture.store.appendEvents(
      sessionId,
      [
        { type: EventType.SessionCreated, data: { title: "Atomic" } },
        {
          type: EventType.InputCancelled,
          data: { inputId: "input_missing" },
        },
      ],
      { expectedSeq: 0 },
    )

    const journal = await readFile(fixture.journal(sessionId), "utf8")
    expect(journal.endsWith("\n")).toBe(true)
    const lines = journal.trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { sessionId, seq: 1, type: EventType.SessionCreated },
      { sessionId, seq: 2, type: EventType.InputCancelled },
    ])
    for (const line of lines) {
      expect(JSON.parse(line)).not.toHaveProperty("record")
      expect(JSON.parse(line)).not.toHaveProperty("operation")
    }
  })

  it("replays every newline-aligned byte cut as exactly that fact prefix", async () => {
    const fixture = await createStoreFixture("yakitori-byte-cut-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001b"
    const events = await fixture.store.appendEvents(
      sessionId,
      completeTurnFacts("request:byte-cut", "input_byte_cut", "turn_byte_cut"),
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    const journal = await readFile(fixture.journal(sessionId))
    const boundaries = [
      0,
      ...Array.from(journal).flatMap((byte, index) =>
        byte === 0x0a ? [index + 1] : [],
      ),
    ]

    for (const [factCount, boundary] of boundaries.entries()) {
      await writeFile(fixture.journal(sessionId), journal.subarray(0, boundary))
      const reopened = fixture.reopen()
      const replayed = await reopened.rebuildProjection(sessionId)
      const prefix = events.slice(0, factCount)

      expect(replayed.events).toEqual(prefix)
      expect(replayed.projection).toEqual(applySessionFacts(undefined, prefix))
      await reopened.close()
    }
  })

  it("keeps a complete multi-fact buffer prefix and leaves its Turn open", async () => {
    const fixture = await createStoreFixture("yakitori-crash-prefix-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001c"
    const facts = completeTurnFacts(
      "request:crash-prefix",
      "input_crash_prefix",
      "turn_crash_prefix",
    )
    await fixture.store.appendEvents(sessionId, facts.slice(0, 3), {
      expectedSeq: 0,
    })
    await fixture.store.appendEvents(sessionId, facts.slice(3), {
      expectedSeq: 3,
    })
    await fixture.store.close()
    const lines = (await readFile(fixture.journal(sessionId), "utf8"))
      .trimEnd()
      .split("\n")
    await writeFile(
      fixture.journal(sessionId),
      `${lines.slice(0, 4).join("\n")}\n`,
    )

    const replayed = await fixture.reopen().rebuildProjection(sessionId)

    expect(replayed.events.map((event) => event.type)).toEqual([
      EventType.SessionCreated,
      EventType.InputAdmitted,
      EventType.TurnStarted,
      EventType.AssistantMessage,
    ])
    expect(replayed.projection?.activeTurn).toMatchObject({
      turnId: "turn_crash_prefix",
      state: TurnState.Started,
    })
    expect(replayed.projection?.completedTurns).toEqual([])
  })

  it("reads legacy and fact lines with one contiguous sequence", async () => {
    const fixture = await createStoreFixture("yakitori-mixed-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001a"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: { title: "Mixed" } },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      serializeFactLine({
        id: "event_mixed_fact",
        sessionId,
        seq: 2,
        version: 1,
        createdAt: "2026-07-30T00:00:00.000Z",
        type: "provider.mixed",
        data: { format: "fact" },
      }),
    )

    const reopened = fixture.reopen()
    await reopened.appendEvent(
      sessionId,
      { type: EventType.InputCancelled, data: { inputId: "input_mixed" } },
      { expectedSeq: 2 },
    )

    expect(await reopened.readEvents(sessionId)).toMatchObject([
      { seq: 1, type: EventType.SessionCreated },
      { seq: 2, type: "provider.mixed" },
      { seq: 3, type: EventType.InputCancelled },
    ])
  })

  it("rebuilds admission reconciliation from a legacy receipt fixture", async () => {
    const fixture = await createStoreFixture("yakitori-legacy-admission-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001d"
    const admission = createAdmission(
      "request:legacy",
      "input_legacy",
      "legacy",
    )
    await writeLegacyJournal(fixture.journal(sessionId), {
      record: "commit",
      version: 1,
      sessionId,
      firstSeq: 1,
      operation: { id: "input.admit:request:legacy", fingerprint: "old" },
      events: [
        storedFact(sessionId, 1, "event_legacy_session", {
          type: EventType.SessionCreated,
          data: {},
        }),
        storedFact(sessionId, 2, "event_legacy_admission", admission.event),
      ],
    })

    const retry = createAdmission(
      "request:legacy",
      "input_retry_not_written",
      "legacy",
    )
    const replayed = await fixture.store.appendEvent(sessionId, retry.event, {
      expectedSeq: 2,
      admission: retry.reconciliation,
    })

    expect(replayed).toMatchObject({
      seq: 2,
      data: { inputId: "input_legacy" },
    })
    expect(await fixture.store.readEvents(sessionId)).toHaveLength(2)
  })

  it("truncates only a non-newline tail during initialization", async () => {
    const fixture = await createStoreFixture("yakitori-tail-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000c"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    const committedBytes = (await stat(fixture.journal(sessionId))).size
    await appendFile(fixture.journal(sessionId), '{"record":"commit"')

    const reopened = fixture.reopen()
    expect(await reopened.readEvents(sessionId)).toHaveLength(1)
    expect((await stat(fixture.journal(sessionId))).size).toBe(committedBytes)
  })

  it("rejects a malformed newline-committed fact line", async () => {
    const fixture = await createStoreFixture("yakitori-corrupt-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000d"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      `${JSON.stringify({
        id: "event_malformed",
        sessionId,
        seq: 2,
        version: 1,
        createdAt: "2026-07-30T00:00:00.000Z",
        type: "provider.malformed",
      })}\n`,
    )
    const corruptBytes = (await stat(fixture.journal(sessionId))).size

    const reopened = fixture.reopen()
    await expect(reopened.readEvents(sessionId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidEventLog,
    })
    expect((await stat(fixture.journal(sessionId))).size).toBe(corruptBytes)
  })

  it("rejects a malformed newline-committed legacy record", async () => {
    const fixture = await createStoreFixture("yakitori-corrupt-legacy-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001f"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      `${JSON.stringify({
        record: "commit",
        version: 1,
        sessionId,
        firstSeq: 2,
        events: [],
      })}\n`,
    )

    await expect(fixture.reopen().readEvents(sessionId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidEventLog,
    })
  })

  it.each([
    ["duplicate", 1],
    ["gap", 3],
  ])("rejects a committed fact with a %s sequence", async (_, seq) => {
    const fixture = await createStoreFixture(`yakitori-seq-${seq}-`)
    const sessionId = "session_00000000-0000-4000-8000-000000000020"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      serializeFactLine(
        storedFact(sessionId, seq, `event_bad_seq_${seq}`, {
          type: EventType.InputCancelled,
          data: { inputId: "input_missing" },
        }),
      ),
    )

    await expect(fixture.reopen().readEvents(sessionId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidEventLog,
    })
  })

  it("retains facts, projection, and admission reconciliation across reopen", async () => {
    const fixture = await createStoreFixture("yakitori-reopen-")
    const sessionId = "session_00000000-0000-4000-8000-000000000008"
    const admission = createAdmission("request:reopen", "input_reopen", "same")
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: { title: "Persistent" } },
      { expectedSeq: 0 },
    )
    const original = await fixture.store.appendEvent(
      sessionId,
      admission.event,
      { expectedSeq: 1, admission: admission.reconciliation },
    )
    await fixture.store.close()

    const reopened = fixture.reopen()
    expect(await reopened.readEvents(sessionId)).toHaveLength(2)
    expect(await reopened.readProjection(sessionId)).toMatchObject({
      id: sessionId,
      seq: 2,
      title: "Persistent",
    })
    expect(
      await reopened.appendEvent(sessionId, admission.event, {
        expectedSeq: 1,
        admission: admission.reconciliation,
      }),
    ).toEqual(original)
  })

  it("rejects an invalid admission reconciliation before writing", async () => {
    const fixture = await createStoreFixture("yakitori-admission-")
    const sessionId = "session_00000000-0000-4000-8000-000000000012"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )

    await expect(
      fixture.store.appendEvent(
        sessionId,
        createAdmission("request:valid", "input_1", "valid").event,
        { admission: { requestId: "", fingerprint: "" } },
      ),
    ).rejects.toMatchObject({ code: YakitoriErrorCode.InvalidArgument })
    await fixture.store.close()

    expect(await fixture.reopen().readEvents(sessionId)).toHaveLength(1)
  })

  it("reconciles a fully committed append by fact ID after sync fails", async () => {
    const fixture = await createStoreFixture("yakitori-committed-fact-")
    const sessionId = "session_00000000-0000-4000-8000-000000000021"
    await seedSessionJournal(fixture.journal(sessionId), sessionId)
    const sync = await spyOnFileHandleSync(fixture.journal(sessionId))
    sync.mockRejectedValueOnce(new Error("append acknowledgement lost"))

    try {
      await expect(
        fixture.store.appendEvent(
          sessionId,
          { type: EventType.InputCancelled, data: { inputId: "input_fact" } },
          { expectedSeq: 1 },
        ),
      ).resolves.toMatchObject({ seq: 2 })
      expect(sync).toHaveBeenCalledTimes(2)
      expect(await fixture.store.readEvents(sessionId)).toHaveLength(2)
    } finally {
      sync.mockRestore()
    }
  })

  it("reconciles AckLost from the recovered admission index", async () => {
    const fixture = await createStoreFixture("yakitori-resync-")
    const sessionId = "session_00000000-0000-4000-8000-000000000013"
    await seedSessionJournal(fixture.journal(sessionId), sessionId)
    const sync = await spyOnFileHandleSync(fixture.journal(sessionId))
    sync.mockRejectedValueOnce(new Error("first sync failed"))
    const admission = createAdmission("request:resync", "input_resync", "same")

    try {
      const committed = await fixture.store.appendEvent(
        sessionId,
        admission.event,
        {
          expectedSeq: 1,
          admission: admission.reconciliation,
        },
      )
      expect(committed).toMatchObject({ seq: 2 })
      const retry = createAdmission(
        "request:resync",
        "input_ack_lost_retry",
        "same",
      )
      await expect(
        fixture.store.appendEvent(sessionId, retry.event, {
          expectedSeq: 2,
          admission: retry.reconciliation,
        }),
      ).resolves.toEqual(committed)
      expect(sync).toHaveBeenCalledTimes(2)
      expect(await fixture.store.readEvents(sessionId)).toHaveLength(2)
    } finally {
      sync.mockRestore()
    }
  })

  it("preserves both sync and recovery failures", async () => {
    const fixture = await createStoreFixture("yakitori-resync-failure-")
    const sessionId = "session_00000000-0000-4000-8000-000000000014"
    await seedSessionJournal(fixture.journal(sessionId), sessionId)
    const sync = await spyOnFileHandleSync(fixture.journal(sessionId))
    const writeFailure = new Error("append sync failed")
    const recoveryFailure = new Error("recovery sync failed")
    sync
      .mockRejectedValueOnce(writeFailure)
      .mockRejectedValueOnce(recoveryFailure)
    const admission = createAdmission(
      "request:failure",
      "input_failure",
      "same",
    )

    try {
      const rejected = await fixture.store
        .appendEvent(sessionId, admission.event, {
          expectedSeq: 1,
          admission: admission.reconciliation,
        })
        .catch((error: unknown) => error)
      expect(rejected).toBeInstanceOf(AggregateError)
      expect(rejected).toMatchObject({
        cause: writeFailure,
        errors: [writeFailure, recoveryFailure],
      })
      await expect(
        fixture.store.appendEvent(sessionId, admission.event, {
          expectedSeq: 1,
          admission: admission.reconciliation,
        }),
      ).resolves.toMatchObject({ seq: 2 })
      expect(sync).toHaveBeenCalledTimes(3)
    } finally {
      sync.mockRestore()
    }
  })

  it("serializes same-Session compare-and-append attempts", async () => {
    const fixture = await createStoreFixture("yakitori-serial-")
    const sessionId = "session_00000000-0000-4000-8000-000000000009"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )

    const attempts = await Promise.allSettled([
      fixture.store.appendEvent(
        sessionId,
        { type: EventType.InputCancelled, data: { inputId: "input_a" } },
        { expectedSeq: 1 },
      ),
      fixture.store.appendEvent(
        sessionId,
        { type: EventType.InputCancelled, data: { inputId: "input_b" } },
        { expectedSeq: 1 },
      ),
    ])

    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    expect(await fixture.store.readEvents(sessionId)).toHaveLength(2)
  })

  it("rejects duplicate admission request IDs in the committed journal", async () => {
    const fixture = await createStoreFixture("yakitori-duplicate-request-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001e"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.appendEvent(
      sessionId,
      createAdmission("request:duplicate", "input_first", "first").event,
      { expectedSeq: 1 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      serializeFactLine(
        storedFact(sessionId, 3, "event_duplicate_request", {
          ...createAdmission("request:duplicate", "input_second", "second")
            .event,
        }),
      ),
    )

    await expect(fixture.reopen().readEvents(sessionId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidEventLog,
    })
  })

  it("rebuilds a corrupt summary without retaining the cold Session", async () => {
    const fixture = await createStoreFixture("yakitori-summary-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000e"
    await fixture.store.appendEvent(
      sessionId,
      {
        type: EventType.SessionCreated,
        data: { title: "Listed", metadata: { source: "journal" } },
      },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await writeFile(fixture.summary(sessionId), "not json")

    const reopened = fixture.reopen()
    expect(await reopened.listSessions()).toMatchObject({
      sessions: [
        {
          sessionId,
          seq: 1,
          title: "Listed",
          metadata: { source: "journal" },
        },
      ],
    })
    expect(
      JSON.parse(await readFile(fixture.summary(sessionId), "utf8")),
    ).toMatchObject({
      version: 1,
      sessionId,
      journalBytes: (await stat(fixture.journal(sessionId))).size,
    })
    await appendFile(
      fixture.journal(sessionId),
      serializeFactLine({
        id: "event_after_listing",
        sessionId,
        seq: 2,
        version: 1,
        createdAt: "2026-07-27T00:00:00.000Z",
        type: "provider.after_listing",
        data: {},
      }),
    )
    expect(await reopened.readEvents(sessionId)).toHaveLength(2)
  })

  it("drains the latest coalesced summary before close returns", async () => {
    const fixture = await createStoreFixture("yakitori-summary-close-")
    const sessionId = "session_00000000-0000-4000-8000-000000000010"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.InputCancelled, data: { inputId: "input_1" } },
      { expectedSeq: 1 },
    )
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.InputCancelled, data: { inputId: "input_2" } },
      { expectedSeq: 2 },
    )

    await fixture.store.close()

    expect(
      JSON.parse(await readFile(fixture.summary(sessionId), "utf8")),
    ).toMatchObject({
      sessionId,
      seq: 3,
      journalBytes: (await stat(fixture.journal(sessionId))).size,
    })
  })

  it("preserves an unknown fact while rebuilding from disk", async () => {
    const fixture = await createStoreFixture("yakitori-opaque-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000f"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: { title: "Repairable" } },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    await appendFile(
      fixture.journal(sessionId),
      serializeFactLine({
        id: "event_unknown_repair",
        sessionId,
        seq: 2,
        version: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        type: "provider.future_fact",
        data: { value: "opaque" },
      }),
    )

    const reopened = fixture.reopen()
    expect(await reopened.listSessions()).toMatchObject({
      sessions: [{ sessionId, seq: 2, title: "Repairable" }],
    })
    const replayed = await reopened.rebuildProjection(sessionId)
    expect(replayed.events[1]).toMatchObject({
      type: "provider.future_fact",
      data: { value: "opaque" },
    })
    expect(replayed.projection).toMatchObject({
      id: sessionId,
      seq: 2,
      title: "Repairable",
    })
    await expect(
      reopened.appendEvent(
        sessionId,
        { type: EventType.InputCancelled, data: { inputId: "input_future" } },
        { expectedSeq: 2 },
      ),
    ).resolves.toMatchObject({ seq: 3 })
    expect(await reopened.readEvents(sessionId)).toHaveLength(3)
  })

  it("rejects new work after close", async () => {
    const fixture = await createStoreFixture("yakitori-close-")
    await fixture.store.close()

    await expect(fixture.store.listSessions()).rejects.toThrow("closed")
  })

  it("drains a list operation admitted before close", async () => {
    const fixture = await createStoreFixture("yakitori-list-close-")
    const sessionId = "session_00000000-0000-4000-8000-000000000015"
    await fixture.store.appendEvent(
      sessionId,
      { type: EventType.SessionCreated, data: {} },
      { expectedSeq: 0 },
    )
    await fixture.store.close()
    const reopened = fixture.reopen()

    const listing = reopened.listSessions()
    const closing = reopened.close()

    await expect(listing).resolves.toMatchObject({ sessions: [{ sessionId }] })
    await closing
  })
})

function createAdmission(requestId: string, inputId: string, text: string) {
  const data = {
    requestId,
    inputId,
    role: "user" as const,
    content: { kind: "text" as const, text },
  }
  return {
    event: { type: EventType.InputAdmitted, data } as const,
    reconciliation: {
      requestId,
      fingerprint: fingerprintInputAdmission(data),
    },
  }
}

function completeTurnFacts(
  requestId: string,
  inputId: string,
  turnId: string,
): readonly KernelEvent[] {
  return [
    { type: EventType.SessionCreated, data: {} },
    {
      type: EventType.InputAdmitted,
      data: {
        requestId,
        inputId,
        role: "user",
        content: { kind: "text", text: "prefix" },
      },
    },
    { type: EventType.TurnStarted, data: { turnId, inputId } },
    {
      type: EventType.AssistantMessage,
      data: {
        messageId: "message_prefix",
        turnId,
        content: [{ type: "text", text: "durable prefix" }],
      },
    },
    {
      type: EventType.TurnCompleted,
      data: { turnId, outputMessageId: "message_prefix" },
    },
  ]
}

function storedFact(
  sessionId: string,
  seq: number,
  id: string,
  event: KernelEvent,
): EventEnvelope {
  return {
    id,
    sessionId,
    seq,
    version: 1,
    createdAt: `2026-07-30T00:00:0${seq}.000Z`,
    ...event,
  }
}

async function writeLegacyJournal(
  path: string,
  record: JournalCommitRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record)}\n`)
}

async function seedSessionJournal(path: string, sessionId: string) {
  await writeLegacyJournal(path, {
    record: "commit",
    version: 1,
    sessionId,
    firstSeq: 1,
    events: [
      {
        id: "event_seed",
        sessionId,
        seq: 1,
        version: 1,
        createdAt: "2026-07-27T00:00:00.000Z",
        type: EventType.SessionCreated,
        data: {},
      },
    ],
  })
}

async function spyOnFileHandleSync(path: string) {
  const probe = await open(path, "r+")
  const prototype = Object.getPrototypeOf(probe) as {
    sync(): Promise<void>
  }
  await probe.close()
  return vi.spyOn(prototype, "sync")
}

async function createStoreFixture(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  const sessionsDir = join(rootDir, "sessions")
  let store = createJsonlEventStore({ sessionsDir })
  cleanup.push(async () => {
    await store.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    journal(sessionId: string) {
      return join(sessionsDir, sessionId, "events.jsonl")
    },
    summary(sessionId: string) {
      return join(sessionsDir, sessionId, "summary.json")
    },
    reopen() {
      store = createJsonlEventStore({ sessionsDir })
      return store
    },
  }
}
