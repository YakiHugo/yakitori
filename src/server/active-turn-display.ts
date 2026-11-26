import {
  displayPageBytes,
  displayPageRecords,
  displayRecord,
  isTranscriptRecord,
} from "../core/display-window.ts"
import type { StoredRolloutItem } from "../core/rollout.ts"

type DisplayRecord = Readonly<{ record: StoredRolloutItem; bytes: number }>

// The event pump owns this display state for one resident actor. Its durable
// cursor advances with publication, so subscribers can safely buffer the tail.
export class ActiveTurnDisplay {
  #turnId: string | undefined
  #finishedTurnId: string | undefined
  #records: DisplayRecord[] = []
  #bytes = 0
  #omittedActivity = false
  #start: StoredRolloutItem | undefined
  #transcript: StoredRolloutItem[] = []
  #context: StoredRolloutItem | undefined

  append(records: readonly StoredRolloutItem[]): void {
    for (const stored of records) {
      const record = displayRecord(stored)
      if (record === undefined) continue
      const { item } = record
      const turnId =
        item.type === "response_item"
          ? (this.#turnId ?? item.item.turnId)
          : item.type === "turn_context"
            ? (this.#turnId ?? item.context.turnId)
            : "turnId" in item
              ? item.turnId
              : undefined
      if (turnId === undefined) continue
      if (item.type === "turn_completed") {
        this.finish(turnId)
        continue
      }
      if (
        this.#turnId !== turnId &&
        (item.type === "turn_started" ||
          (this.#turnId === undefined && this.#finishedTurnId !== turnId))
      )
        this.#reset(turnId)
      if (this.#turnId !== turnId) continue
      if (item.type === "turn_started") this.#start = record
      else if (item.type === "turn_context") this.#context = record
      else if (item.type !== "token_count" && isTranscriptRecord(record)) {
        // Activity pages only recover non-transcript rows. Preserve the
        // visible conversation for the lifetime of its active Turn.
        this.#transcript.push(record)
        continue
      }
      const bytes = Buffer.byteLength(JSON.stringify(record))
      this.#records.push({ record, bytes })
      this.#bytes += bytes
      while (
        this.#records.length > 1 &&
        (this.#records.length > displayPageRecords ||
          this.#bytes > displayPageBytes)
      ) {
        const omitted = this.#records.shift()
        if (omitted === undefined) break
        this.#bytes -= omitted.bytes
        if (!isTranscriptRecord(omitted.record)) this.#omittedActivity = true
      }
    }
  }

  finish(turnId: string): void {
    this.#finishedTurnId = turnId
    if (this.#turnId === turnId) this.#reset(undefined)
  }

  capture(turnId: string) {
    if (this.#finishedTurnId === turnId) return undefined
    if (this.#turnId !== turnId) return { turnId, records: [] }
    const records = new Map(
      this.#records.map(({ record }) => [record.seq, record]),
    )
    for (const record of this.#transcript) records.set(record.seq, record)
    for (const anchor of [this.#start, this.#context])
      if (anchor !== undefined) records.set(anchor.seq, anchor)
    const before = this.#records[0]?.record.seq
    return {
      turnId,
      records: [...records.values()].sort(
        (left, right) => left.seq - right.seq,
      ),
      ...(!this.#omittedActivity || before === undefined
        ? {}
        : { activityBefore: before }),
    }
  }

  #reset(turnId: string | undefined): void {
    this.#turnId = turnId
    this.#records = []
    this.#bytes = 0
    this.#omittedActivity = false
    this.#start = undefined
    this.#transcript = []
    this.#context = undefined
  }
}
