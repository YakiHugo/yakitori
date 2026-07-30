import { describe, expect, it } from "vitest"
import { EventType } from "../../src/kernel/events.ts"
import {
  type JournalCommitRecord,
  parseJournalLine,
  serializeFactLine,
} from "../../src/kernel/jsonl-event-store-format.ts"

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
