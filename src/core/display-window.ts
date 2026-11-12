import { type FileHandle, open } from "node:fs/promises"
import type { StoredRolloutItem, ThreadMetadata } from "./rollout.ts"

export type DisplayWindow = Readonly<{
  // Contiguous history coverage. Supplemental state must not move its cursor.
  records: readonly StoredRolloutItem[]
  lookbehind: readonly StoredRolloutItem[]
  hasEarlier: boolean
}>

export type DisplayWindowRead = DisplayWindow &
  Readonly<{
    metadata: ThreadMetadata
    // Last stored sequence, even when reading a page before that sequence.
    endSeq: number
  }>

export function isDisplayInput(record: StoredRolloutItem): boolean {
  if (
    record.item.type !== "response_item" ||
    !record.item.item.id.startsWith("input_")
  )
    return false
  const message = record.item.item.item
  const submission = record.item.item.submissionMetadata
  return (
    (message.role === "user" && message.context === undefined) ||
    (message.role === "developer" &&
      message.context?.type === "thread_message" &&
      submission?.content !== undefined &&
      submission.provenance !== undefined)
  )
}

function displayStart(records: readonly StoredRolloutItem[]): {
  index: number
  hasTurnStart: boolean
  hasTurnContext: boolean
} {
  const promptIndex = records.findLastIndex(isDisplayInput)
  const prompt = records[promptIndex]
  if (prompt?.item.type !== "response_item") {
    return { index: 0, hasTurnStart: false, hasTurnContext: false }
  }
  const turnId = prompt.item.item.turnId
  const turnStart = records.findLastIndex(
    (record, index) =>
      index <= promptIndex &&
      record.item.type === "turn_started" &&
      record.item.turnId === turnId,
  )
  const contextIndex = records.findLastIndex(
    (record, index) =>
      index <= promptIndex &&
      record.item.type === "turn_context" &&
      record.item.context.turnId === turnId,
  )
  return {
    index:
      turnStart >= 0
        ? turnStart
        : contextIndex >= 0
          ? contextIndex
          : promptIndex,
    hasTurnStart: turnStart >= 0,
    hasTurnContext: contextIndex >= 0,
  }
}

function lastCacheState(records: readonly StoredRolloutItem[]): {
  completion: StoredRolloutItem | undefined
  context: StoredRolloutItem | undefined
} {
  const completion = records.findLast(
    (record) =>
      record.item.type === "turn_completed" &&
      record.item.outcome === "completed",
  )
  if (completion?.item.type !== "turn_completed") {
    return { completion: undefined, context: undefined }
  }
  const turnId = completion.item.turnId
  const context = records.findLast(
    (record) =>
      record.seq < completion.seq &&
      record.item.type === "turn_context" &&
      record.item.context.turnId === turnId,
  )
  return { completion, context }
}

// Include the owning Turn's start and context before its latest prompt. The
// preceding cache policy can belong to a different Turn and model.
export function selectDisplayWindow(
  records: readonly StoredRolloutItem[],
  beforeSeqExclusive?: number,
): DisplayWindow {
  const visible = records.filter(
    (record) =>
      record.item.type !== "session_meta" &&
      (beforeSeqExclusive === undefined || record.seq < beforeSeqExclusive),
  )
  const { index: start } = displayStart(visible)
  const selected = visible.slice(start)
  const preceding = visible.slice(0, start)
  const supplemental = new Map<number, StoredRolloutItem>()
  const add = (record: StoredRolloutItem | undefined) => {
    if (record !== undefined && record.seq < (selected[0]?.seq ?? 0)) {
      supplemental.set(record.seq, record)
    }
  }
  if (!selected.some((record) => record.item.type === "token_count")) {
    add(preceding.findLast((record) => record.item.type === "token_count"))
  }
  if (!selected.some((record) => record.item.type === "turn_context")) {
    add(preceding.findLast((record) => record.item.type === "turn_context"))
  }
  const cache = lastCacheState(visible)
  add(cache.completion)
  add(cache.context)
  return {
    records: selected,
    lookbehind: [...supplemental.values()].sort((a, b) => a.seq - b.seq),
    hasEarlier: preceding.length > 0,
  }
}

export function displayTailReady(
  records: readonly StoredRolloutItem[],
  reachedStart: boolean,
  beforeSeqExclusive?: number,
): boolean {
  if (reachedStart) return true
  const considered = records.filter(
    (record) =>
      record.item.type !== "session_meta" &&
      (beforeSeqExclusive === undefined || record.seq < beforeSeqExclusive),
  )
  const start = displayStart(considered)
  if (!start.hasTurnStart) return false
  // A newly admitted prompt may still be resolving its model. In that case
  // the preceding context is the current model until a new one is committed.
  if (
    !start.hasTurnContext &&
    !considered.some((record) => record.item.type === "turn_context")
  )
    return false
  if (!considered.some((record) => record.item.type === "token_count")) {
    return false
  }
  const cache = lastCacheState(considered)
  // Absence of state is established only at the logical history root. A file
  // header in a fork is a segment boundary, not the end of inherited history.
  return cache.completion !== undefined && cache.context !== undefined
}

const tailChunkBytes = 64 * 1024

type JsonlReadOptions = Readonly<{
  endByteOffset?: number
  endSeqExclusive?: number
  parse(line: string): StoredRolloutItem
}>

export async function readJsonlFirst(
  path: string,
  options: JsonlReadOptions,
): Promise<StoredRolloutItem | undefined> {
  const file = await open(path, "r")
  try {
    const end = await jsonlEnd(file, options)
    let line = await readLine(file, 0, end)
    while (line?.text === "") {
      line = await readLine(file, line.endByteOffset, end)
    }
    return line === undefined ? undefined : options.parse(line.text)
  } finally {
    await file.close()
  }
}

export async function readJsonlTail(
  path: string,
  options: JsonlReadOptions &
    Readonly<{
      beforeSeqExclusive?: number
      enough(
        records: readonly StoredRolloutItem[],
        reachedStart: boolean,
      ): boolean
    }>,
): Promise<{
  records: readonly StoredRolloutItem[]
  reachedStart: boolean
  endSeq: number
}> {
  const file = await open(path, "r")
  try {
    const end = await jsonlEnd(file, options)
    const last = await lastCompleteRecord(file, end, options.parse)
    const endSeq = last?.record.seq ?? 0
    const completeEnd = last?.endByteOffset ?? 0
    let cursor =
      options.beforeSeqExclusive === undefined ||
      options.beforeSeqExclusive > endSeq
        ? completeEnd
        : await positionBeforeSeq(
            file,
            completeEnd,
            options.beforeSeqExclusive,
            options.parse,
          )
    let partial: Buffer[] = []
    let records: StoredRolloutItem[] = []
    while (cursor > 0) {
      const start = Math.max(0, cursor - tailChunkBytes)
      const chunk = await readBytes(file, start, cursor - start)
      cursor = start
      const reachedStart = start === 0
      const firstNewline = reachedStart ? -1 : chunk.indexOf(10)
      if (!reachedStart && firstNewline === -1) {
        partial.unshift(chunk)
        continue
      }
      const completeStart = reachedStart ? 0 : firstNewline + 1
      const complete = chunk.subarray(completeStart)
      const bytes =
        partial.length === 0 ? complete : Buffer.concat([complete, ...partial])
      partial = completeStart === 0 ? [] : [chunk.subarray(0, completeStart)]
      records = [...parseCompleteLines(bytes, options.parse), ...records]
      if (options.enough(records, reachedStart)) {
        return { records, reachedStart, endSeq }
      }
    }
    return { records, reachedStart: true, endSeq }
  } finally {
    await file.close()
  }
}

async function jsonlEnd(
  file: FileHandle,
  options: JsonlReadOptions,
): Promise<number> {
  const size = (await file.stat()).size
  const end = options.endByteOffset ?? size
  if (
    !Number.isSafeInteger(end) ||
    end < 0 ||
    end > size ||
    (options.endByteOffset !== undefined && end === 0)
  ) {
    throw new Error("Thread history contains an invalid cutoff position.")
  }
  if (options.endByteOffset !== undefined) {
    const last = await lastCompleteRecord(file, end, options.parse)
    if (
      last?.endByteOffset !== end ||
      (options.endSeqExclusive !== undefined &&
        last.record.seq !== options.endSeqExclusive - 1)
    ) {
      throw new Error("Thread history contains an invalid cutoff position.")
    }
  }
  return end
}

async function lastCompleteRecord(
  file: FileHandle,
  end: number,
  parse: (line: string) => StoredRolloutItem,
): Promise<{ record: StoredRolloutItem; endByteOffset: number } | undefined> {
  let lineEnd = (await previousNewline(file, end)) + 1
  while (lineEnd > 0) {
    const start = (await previousNewline(file, lineEnd - 1)) + 1
    if (lineEnd - start > 1) {
      const bytes = await readBytes(file, start, lineEnd - start - 1)
      return {
        record: parse(bytes.toString("utf8")),
        endByteOffset: lineEnd,
      }
    }
    lineEnd = start
  }
  return undefined
}

async function previousNewline(
  file: FileHandle,
  beforeByteExclusive: number,
): Promise<number> {
  let cursor = beforeByteExclusive
  while (cursor > 0) {
    const start = Math.max(0, cursor - tailChunkBytes)
    const bytes = await readBytes(file, start, cursor - start)
    const index = bytes.lastIndexOf(10)
    if (index >= 0) return start + index
    cursor = start
  }
  return -1
}

// Local records have increasing sequences. Seek their byte boundary without
// replaying newer bodies on every request for an earlier page.
async function positionBeforeSeq(
  file: FileHandle,
  end: number,
  beforeSeqExclusive: number,
  parse: (line: string) => StoredRolloutItem,
): Promise<number> {
  let low = 0
  let high = end
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    let start = middle
    if (start > 0 && (await readBytes(file, start - 1, 1))[0] !== 10) {
      const partial = await readLine(file, start, end)
      if (partial === undefined) {
        high = middle
        continue
      }
      start = partial.endByteOffset
    }
    let line = await readLine(file, start, end)
    while (line?.text === "") {
      line = await readLine(file, line.endByteOffset, end)
    }
    if (line === undefined || parse(line.text).seq >= beforeSeqExclusive) {
      high = middle
    } else {
      low = line.endByteOffset
    }
  }
  return low
}

async function readLine(
  file: FileHandle,
  start: number,
  end: number,
): Promise<{ text: string; endByteOffset: number } | undefined> {
  const chunks: Buffer[] = []
  let cursor = start
  while (cursor < end) {
    const length = Math.min(tailChunkBytes, end - cursor)
    const bytes = await readBytes(file, cursor, length)
    const index = bytes.indexOf(10)
    if (index >= 0) {
      chunks.push(bytes.subarray(0, index))
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        endByteOffset: cursor + index + 1,
      }
    }
    chunks.push(bytes)
    cursor += length
  }
  return undefined
}

async function readBytes(
  file: FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await file.read(
      bytes,
      offset,
      length - offset,
      start + offset,
    )
    if (bytesRead === 0) {
      throw new Error("Rollout ended before its recorded size.")
    }
    offset += bytesRead
  }
  return bytes
}

function parseCompleteLines(
  bytes: Buffer,
  parse: (line: string) => StoredRolloutItem,
): StoredRolloutItem[] {
  const records: StoredRolloutItem[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue
    if (index > start) {
      records.push(parse(bytes.subarray(start, index).toString("utf8")))
    }
    start = index + 1
  }
  return records
}
