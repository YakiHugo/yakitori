import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { YakitoriErrorCode } from "../../src/kernel/errors.ts"
import {
  type EventEnvelope,
  EventType,
  HistoryRecordType,
} from "../../src/kernel/events.ts"
import { createJsonlEventStore } from "../../src/kernel/jsonl-event-store.ts"
import { serializeFactLine } from "../../src/kernel/jsonl-event-store-format.ts"
import { fingerprintInputAdmission } from "../../src/kernel/operation.ts"
import { TurnState } from "../../src/kernel/session-states.ts"

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const run of cleanup.splice(0)) await run()
})

describe("JSONL recovery fault models", () => {
  it("reserves an opaque input admission ID without replaying it", async () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000103"
    const requestId = "request:opaque"
    const fixture = await createJournalFixture(sessionId, [
      serializeFactLine(
        storedFact(sessionId, 1, "event_opaque_session", {
          type: EventType.SessionCreated,
          data: {},
        }),
      ),
      serializeFactLine({
        id: "event_opaque_admission",
        sessionId,
        seq: 2,
        version: 2,
        createdAt: "2026-07-30T00:00:02.000Z",
        type: EventType.InputAdmitted,
        data: { requestId, futureShape: true },
      }),
    ])
    const data = {
      requestId,
      inputId: "input_opaque_retry",
      role: "user" as const,
      content: { kind: "text" as const, text: "retry" },
    }

    await expect(
      fixture.store.appendEvent(
        sessionId,
        { type: EventType.InputAdmitted, data },
        {
          expectedSeq: 2,
          admission: {
            requestId,
            fingerprint: fingerprintInputAdmission(data),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidState,
      message: `Admission ${requestId} is unknown to this runtime.`,
    })
    expect(await fixture.store.readEvents(sessionId)).toHaveLength(2)
  })

  it("treats duplicate opaque admission IDs as committed corruption", async () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000104"
    const requestId = "request:opaque-duplicate"
    const fixture = await createJournalFixture(sessionId, [
      serializeFactLine(
        storedFact(sessionId, 1, "event_duplicate_session", {
          type: EventType.SessionCreated,
          data: {},
        }),
      ),
      ...[2, 3].map((seq) =>
        serializeFactLine({
          id: `event_opaque_duplicate_${seq}`,
          sessionId,
          seq,
          version: 2,
          createdAt: `2026-07-30T00:00:0${seq}.000Z`,
          type: EventType.InputAdmitted,
          data: { requestId, futureShape: seq },
        }),
      ),
    ])

    await expect(fixture.store.readEvents(sessionId)).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidEventLog,
      details: { sessionId, requestId },
    })
  })

  it("retains a complete fact prefix when writeAll fails mid-buffer", async () => {
    const sessionId = "session_00000000-0000-4000-8000-000000000105"
    const fixture = await createJournalFixture(sessionId, [
      serializeFactLine(
        storedFact(sessionId, 1, "event_partial_session", {
          type: EventType.SessionCreated,
          data: {},
        }),
      ),
      serializeFactLine(
        storedFact(sessionId, 2, "event_partial_input", {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:partial-write",
            inputId: "input_partial_write",
            role: "user",
            content: { kind: "text", text: "partial" },
          },
        }),
      ),
      serializeFactLine(
        storedFact(sessionId, 3, "event_partial_turn", {
          type: EventType.TurnStarted,
          data: {
            turnId: "turn_partial_write",
            inputId: "input_partial_write",
          },
        }),
      ),
    ])
    await fixture.store.readEvents(sessionId)
    const failure = new Error("simulated second write failure")
    const { originalWrite, write } = await spyOnFileHandleWrite(fixture.journal)
    write.mockImplementationOnce(async function (
      this: WritableHandle,
      buffer,
      offset = 0,
      _length,
      position,
    ) {
      const newline = buffer.indexOf(0x0a, offset)
      if (newline < 0) throw new Error("Expected a multi-line append buffer.")
      return originalWrite.call(
        this,
        buffer,
        offset,
        newline - offset + 1,
        position,
      )
    })
    write.mockRejectedValueOnce(failure)

    await expect(
      fixture.store.appendEvents(
        sessionId,
        [
          {
            type: HistoryRecordType.AgentMessage,
            data: {
              messageId: "message_partial_write",
              turnId: "turn_partial_write",
              content: [{ type: "text", text: "durable prefix" }],
            },
          },
          {
            type: EventType.TurnCompleted,
            data: {
              turnId: "turn_partial_write",
              outputMessageId: "message_partial_write",
            },
          },
        ],
        { expectedSeq: 3 },
      ),
    ).rejects.toBe(failure)

    const replayed = await fixture.store.rebuildProjection(sessionId)
    expect(replayed.events.map((event) => event.type)).toEqual([
      EventType.SessionCreated,
      EventType.InputAdmitted,
      EventType.TurnStarted,
      HistoryRecordType.AgentMessage,
    ])
    expect(replayed.projection?.activeTurn).toMatchObject({
      turnId: "turn_partial_write",
      state: TurnState.Started,
    })
  })
})

function storedFact(
  sessionId: string,
  seq: number,
  id: string,
  event: { readonly type: string; readonly data: Record<string, unknown> },
): EventEnvelope {
  return {
    id,
    sessionId,
    seq,
    version: 2,
    createdAt: `2026-07-30T00:00:0${seq}.000Z`,
    ...event,
  } as EventEnvelope
}

async function createJournalFixture(
  sessionId: string,
  lines: readonly string[],
) {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-recovery-model-"))
  const sessionsDir = join(rootDir, "sessions")
  const directory = join(sessionsDir, sessionId)
  const journal = join(directory, "events.jsonl")
  await mkdir(directory, { recursive: true })
  await writeFile(journal, lines.join(""))
  let store = createJsonlEventStore({ sessionsDir })
  cleanup.push(async () => {
    await store.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    journal,
    async reopen() {
      await store.close()
      store = createJsonlEventStore({ sessionsDir })
    },
  }
}

type WriteResult = {
  readonly bytesWritten: number
  readonly buffer: Buffer
}

type WritableHandle = {
  write(
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<WriteResult>
}

async function spyOnFileHandleWrite(path: string) {
  const probe = await open(path, "r+")
  const prototype = Object.getPrototypeOf(probe) as WritableHandle
  await probe.close()
  const originalWrite = prototype.write
  const spy = vi.spyOn(prototype, "write")
  spy.mockImplementation(originalWrite)
  return { originalWrite, write: spy }
}
