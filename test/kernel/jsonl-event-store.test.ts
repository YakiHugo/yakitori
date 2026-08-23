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
import { YakitoriErrorCode } from "../../src/kernel/errors.ts"
import {
  type EventStore,
  parseStoredEventEnvelope,
} from "../../src/kernel/event-store.ts"
import {
  type EventEnvelope,
  EventType,
  type KernelEvent,
} from "../../src/kernel/events.ts"
import { createJsonlEventStore } from "../../src/kernel/jsonl-event-store.ts"
import {
  type JournalCommitRecord,
  parseJournalLine,
  serializeFactLine,
} from "../../src/kernel/jsonl-event-store-format.ts"
import { fingerprintInputAdmission } from "../../src/kernel/operation.ts"
import { applySessionFacts } from "../../src/kernel/session-projector.ts"
import { TurnState } from "../../src/kernel/session-states.ts"
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
  it("removes an unpublished staging journal during recovery", async () => {
    const fixture = await createStoreFixture("yakitori-staging-recovery-")
    const staging = join(fixture.sessionsDirectory, ".staging-crashed-fork")
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, "events.jsonl"), "partial")

    await fixture.store.listSessions()

    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not expose a fork when staging fsync fails", async () => {
    const fixture = await createStoreFixture("yakitori-staging-failure-")
    const sourceId = "session_00000000-0000-4000-8000-000000000020"
    const targetId = "session_00000000-0000-4000-8000-000000000021"
    const sourceEvents = await appendRootEvents(fixture.store, sourceId, [
      { type: EventType.SessionCreated, data: {} },
      createAdmission("request:atomic-cut", "input_atomic_cut", "cut").event,
    ])
    await vi.waitFor(async () => {
      expect((await stat(fixture.summary(sourceId))).size).toBeGreaterThan(0)
    })
    const sync = await spyOnFileHandleSync(fixture.journal(sourceId))
    sync.mockRejectedValueOnce(new Error("simulated staging fsync failure"))

    await expect(
      fixture.store.forkSession({
        sourceSessionId: sourceId,
        targetSessionId: targetId,
        atInputId: "input_atomic_cut",
        expectedSourceSeq: sourceEvents.length,
        created: forkCreated(sourceId, "input_atomic_cut"),
      }),
    ).rejects.toThrow("simulated staging fsync failure")

    expect(await fixture.store.readEvents(targetId)).toEqual([])
    await expect(stat(fixture.journal(targetId))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await fixture.store.readEvents(sourceId)).toHaveLength(2)
  })

  it("does not report a failed fork after its journal was renamed", async () => {
    const fixture = await createStoreFixture("yakitori-published-fork-sync-")
    const sourceId = "session_00000000-0000-4000-8000-000000000024"
    const targetId = "session_00000000-0000-4000-8000-000000000025"
    const sourceEvents = await appendRootEvents(fixture.store, sourceId, [
      { type: EventType.SessionCreated, data: {} },
      createAdmission("request:published-cut", "input_published_cut", "cut")
        .event,
    ])
    await vi.waitFor(async () => {
      expect((await stat(fixture.summary(sourceId))).size).toBeGreaterThan(0)
    })
    const sync = await spyOnFileHandleSync(fixture.journal(sourceId))
    sync
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new Error("simulated post-rename directory sync failure"),
      )

    const forked = await fixture.store.forkSession({
      sourceSessionId: sourceId,
      targetSessionId: targetId,
      atInputId: "input_published_cut",
      expectedSourceSeq: sourceEvents.length,
      created: forkCreated(sourceId, "input_published_cut"),
    })

    expect(forked.projection.id).toBe(targetId)
    expect(await fixture.store.readEvents(targetId)).toEqual(forked.events)
    expect((await stat(fixture.journal(targetId))).size).toBeGreaterThan(0)
  })

  it("serializes conversation deletion with concurrent fork publication", async () => {
    const fixture = await createStoreFixture("yakitori-fork-delete-race-")
    const sourceId = "session_00000000-0000-4000-8000-000000000022"
    const targetId = "session_00000000-0000-4000-8000-000000000023"
    const sourceEvents = await appendRootEvents(fixture.store, sourceId, [
      { type: EventType.SessionCreated, data: {} },
      createAdmission("request:race-cut", "input_race_cut", "cut").event,
    ])
    const settled = await fixture.store.appendEvent(
      sourceId,
      {
        type: EventType.InputCancelled,
        data: { inputId: "input_race_cut", reason: "test_settled" },
      },
      { expectedSeq: sourceEvents.length },
    )

    await Promise.allSettled([
      fixture.store.forkSession({
        sourceSessionId: sourceId,
        targetSessionId: targetId,
        atInputId: "input_race_cut",
        expectedSourceSeq: settled.seq,
        created: forkCreated(sourceId, "input_race_cut"),
      }),
      fixture.store.deleteConversation(sourceId),
    ])

    expect(await fixture.store.readEvents(sourceId)).toEqual([])
    expect(await fixture.store.readEvents(targetId)).toEqual([])
    expect((await fixture.store.listSessions()).sessions).toEqual([])
  })

  it("stores one flat physical line per fact", async () => {
    const fixture = await createStoreFixture("yakitori-record-")
    const sessionId = "session_00000000-0000-4000-8000-00000000000b"

    await appendRootEvents(fixture.store, sessionId, [
      { type: EventType.SessionCreated, data: { title: "Atomic" } },
      {
        type: EventType.InputCancelled,
        data: { inputId: "input_missing" },
      },
    ])

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

  it("stores a fork as a history reference and resolves it after reopen", async () => {
    const fixture = await createStoreFixture("yakitori-reference-fork-")
    const sourceId = "session_00000000-0000-4000-8000-000000000030"
    const targetId = "session_00000000-0000-4000-8000-000000000031"
    const sourceEvents = await appendRootEvents(fixture.store, sourceId, [
      ...completeTurnFacts("request:shared", "input_shared", "turn_shared"),
      createAdmission("request:cut", "input_cut", "cut").event,
      { type: EventType.InputCancelled, data: { inputId: "input_cut" } },
    ])

    const forked = await fixture.store.forkSession({
      sourceSessionId: sourceId,
      targetSessionId: targetId,
      atInputId: "input_cut",
      expectedSourceSeq: sourceEvents.length,
      created: forkCreated(sourceId, "input_cut"),
    })

    expect(forked.events).toHaveLength(5)
    const physical = (await readFile(fixture.journal(targetId), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(physical).toMatchObject([
      {
        sessionId: targetId,
        seq: 1,
        type: EventType.SessionCreated,
        data: {
          parentSessionId: sourceId,
          forkedFromInputId: "input_cut",
          forkReason: "undo",
        },
      },
    ])

    await fixture.store.close()
    const reopened = fixture.reopen()
    expect(await reopened.readEvents(targetId)).toEqual(forked.events)
    await expect(
      reopened.appendEvent(
        targetId,
        { type: EventType.InputCancelled, data: { inputId: "input_later" } },
        { expectedSeq: 5 },
      ),
    ).resolves.toMatchObject({ sessionId: targetId, seq: 6 })
    expect(
      (await readFile(fixture.journal(targetId), "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).seq),
    ).toEqual([1, 6])
  })

  it("resolves chained references and protects every referenced parent", async () => {
    const fixture = await createStoreFixture("yakitori-reference-chain-")
    const sourceId = "session_00000000-0000-4000-8000-000000000032"
    const childId = "session_00000000-0000-4000-8000-000000000033"
    const grandchildId = "session_00000000-0000-4000-8000-000000000034"
    const sourceEvents = await appendRootEvents(fixture.store, sourceId, [
      ...completeTurnFacts("request:root", "input_root", "turn_root"),
      createAdmission("request:child-cut", "input_child_cut", "cut").event,
    ])
    const child = await fixture.store.forkSession({
      sourceSessionId: sourceId,
      targetSessionId: childId,
      atInputId: "input_child_cut",
      expectedSourceSeq: sourceEvents.length,
      created: forkCreated(sourceId, "input_child_cut"),
    })
    await fixture.store.appendEvent(
      childId,
      createAdmission("request:grandchild-cut", "input_grandchild_cut", "cut")
        .event,
      { expectedSeq: child.events.length },
    )
    const grandchild = await fixture.store.forkSession({
      sourceSessionId: childId,
      targetSessionId: grandchildId,
      atInputId: "input_grandchild_cut",
      expectedSourceSeq: child.events.length + 1,
      created: forkCreated(childId, "input_grandchild_cut"),
    })
    await fixture.store.close()

    const reopened = fixture.reopen()
    expect(await reopened.readEvents(grandchildId)).toEqual(grandchild.events)
    await expect(reopened.deleteSession(sourceId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidState,
    })
    await expect(reopened.deleteSession(childId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidState,
    })
    await reopened.deleteSession(grandchildId)
    await reopened.deleteSession(childId)
    await reopened.deleteSession(sourceId)
    expect((await reopened.listSessions()).sessions).toEqual([])
  })

  it("reopens a 100-fork reference chain without loading ancestor Sessions", async () => {
    const fixture = await createStoreFixture("yakitori-deep-reference-")
    const rootId = "session_00000000-0000-4000-8000-000000000200"
    let currentId = rootId
    await fixture.store.createSession(currentId, {
      type: EventType.SessionCreated,
      data: {},
    })

    for (let index = 0; index < 100; index += 1) {
      const inputId = `input_deep_${index}`
      const turnId = `turn_deep_${index}`
      const cutInputId = `input_deep_cut_${index}`
      const appended = await fixture.store.appendEvents(
        currentId,
        [
          createAdmission(`request:deep:${index}`, inputId, "step").event,
          { type: EventType.TurnStarted, data: { turnId, inputId } },
          { type: EventType.TurnCompleted, data: { turnId } },
          createAdmission(`request:deep-cut:${index}`, cutInputId, "cut").event,
        ],
        { expectedSeq: index * 3 + 1 },
      )
      const targetId = `session_00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`
      await fixture.store.forkSession({
        sourceSessionId: currentId,
        targetSessionId: targetId,
        atInputId: cutInputId,
        expectedSourceSeq: appended.at(-1)?.seq ?? 0,
        created: forkCreated(currentId, cutInputId),
      })
      await fixture.store.appendEvent(
        currentId,
        {
          type: EventType.InputCancelled,
          data: { inputId: cutInputId, reason: "test_settled" },
        },
        { expectedSeq: appended.at(-1)?.seq ?? 0 },
      )
      currentId = targetId
    }

    await fixture.store.close()
    const reopened = fixture.reopen()
    const events = await reopened.readEvents(currentId)
    expect(events).toHaveLength(301)
    expect(events.at(-1)).toMatchObject({
      seq: 301,
      type: EventType.TurnCompleted,
    })
    await reopened.deleteConversation(rootId)
    expect((await reopened.listSessions()).sessions).toEqual([])
  }, 20_000)

  it("replays every newline-aligned byte cut as exactly that fact prefix", async () => {
    const fixture = await createStoreFixture("yakitori-byte-cut-")
    const sessionId = "session_00000000-0000-4000-8000-00000000001b"
    const events = await appendRootEvents(
      fixture.store,
      sessionId,
      completeTurnFacts("request:byte-cut", "input_byte_cut", "turn_byte_cut"),
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
    await createRoot(fixture.store, sessionId)
    await fixture.store.appendEvents(sessionId, facts.slice(1, 3), {
      expectedSeq: 1,
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
    await createRoot(fixture.store, sessionId, { title: "Mixed" })
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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId, { title: "Persistent" })
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
    await createRoot(fixture.store, sessionId)

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
    await createRoot(fixture.store, sessionId)

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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId, {
      title: "Listed",
      metadata: { source: "journal" },
    })
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
      version: 2,
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
    await createRoot(fixture.store, sessionId)
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
    await createRoot(fixture.store, sessionId, { title: "Repairable" })
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
    await createRoot(fixture.store, sessionId)
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

function createRoot(
  store: EventStore,
  sessionId: string,
  data: Parameters<EventStore["createSession"]>[1]["data"] = {},
) {
  return store.createSession(sessionId, {
    type: EventType.SessionCreated,
    data,
  })
}

async function appendRootEvents(
  store: EventStore,
  sessionId: string,
  events: readonly KernelEvent[],
) {
  const [created, ...rest] = events
  if (created?.type !== EventType.SessionCreated) {
    throw new Error("Root fixture must begin with session.created.")
  }
  const createdEnvelope = await store.createSession(sessionId, created)
  const appended = await store.appendEvents(sessionId, rest, {
    expectedSeq: 1,
  })
  return [createdEnvelope, ...appended]
}

function forkCreated(parentSessionId: string, forkedFromInputId: string) {
  return {
    type: EventType.SessionCreated,
    data: {
      parentSessionId,
      forkedFromInputId,
      forkReason: "undo" as const,
    },
  } as const
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
    sessionsDirectory: sessionsDir,
    reopen() {
      store = createJsonlEventStore({ sessionsDir })
      return store
    },
  }
}
