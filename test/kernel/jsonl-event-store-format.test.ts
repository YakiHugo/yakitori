import { describe, expect, it } from "vitest"
import { EventType } from "../../src/kernel/events.ts"
import {
  parseJournalLine,
  parseJournalRecord,
  serializeFactBatchLine,
  serializeFactLine,
} from "../../src/kernel/jsonl-event-store-format.ts"

describe("Session journal format", () => {
  const fact = {
    id: "event_format",
    sessionId: "session_00000000-0000-4000-8000-000000000000",
    seq: 1,
    version: 2,
    createdAt: "2026-07-30T00:00:00.000Z",
    type: EventType.SessionCreated,
    data: { title: "Format" },
  } as const

  it("round-trips a flat fact line", () => {
    const line = serializeFactLine(fact)

    expect(line.endsWith("\n")).toBe(true)
    expect(parseJournalLine(line, 1)).toEqual(fact)
  })

  it("round-trips a crash-atomic fact batch in one physical record", () => {
    const second = { ...fact, id: "event_format_2", seq: 2 }
    const line = serializeFactBatchLine([fact, second])

    expect(line.match(/\n/g)).toHaveLength(1)
    expect(parseJournalRecord(line, 1)).toEqual([fact, second])
    expect(() => parseJournalLine(line, 1)).toThrow("contains a fact batch")
  })

  it("rejects malformed JSON and extra fact-envelope keys", () => {
    expect(() => parseJournalLine('{"id":', 3)).toThrow(
      "Invalid Session journal JSON at record 3",
    )
    expect(() =>
      parseJournalLine(JSON.stringify({ ...fact, extra: true }), 4),
    ).toThrow("Invalid Session fact at record 4")
  })

  it("rejects obsolete commit wrappers", () => {
    expect(() =>
      parseJournalLine(
        JSON.stringify({ ...fact, record: "future-framing" }),
        5,
      ),
    ).toThrow("Invalid Session fact at record 5")
  })
})
