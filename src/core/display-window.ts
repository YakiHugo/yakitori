import { type FileHandle, open } from "node:fs/promises"
import type { StoredRolloutItem, ThreadMetadata } from "./rollout.ts"

export type DisplayWindow = Readonly<{
  // Supplemental state never advances the cursor. Transcript pages have
  // separate coverage because they omit activity within the selected turns.
  records: readonly StoredRolloutItem[]
  lookbehind: readonly StoredRolloutItem[]
  hasEarlier: boolean
  transcriptStart?: number
  activityTurnIds?: readonly string[]
}>

export type DisplayWindowRead = DisplayWindow &
  Readonly<{
    metadata: ThreadMetadata
    // Last stored sequence, even when reading a page before that sequence.
    endSeq: number
    // False only for a bounded JSONL fallback while the shared index catches up.
    projectionReady: boolean
    // Canonical coverage boundary even when a bounded cold tail contains only
    // hidden records. Supplemental state never advances this paging cursor.
    coverageStartSeq?: number
  }>

// Implementation safety boundaries, not conversation or Turn limits. A single
// indivisible record may exceed the byte budget and is returned on its own.
export const displayPageRecords = 200
export const displayPageBytes = 256 * 1024

export type RolloutRecordLocation = Readonly<{ start: number; length: number }>

export function isTranscriptRecord({ item }: StoredRolloutItem): boolean {
  if (item.type === "item_started")
    return item.item.type === "context_compaction"
  if (item.type !== "item_completed") return true
  const execution = item.item
  return (
    execution.type === "agent_message" ||
    execution.type === "context_compaction" ||
    execution.type === "image_output" ||
    (execution.type === "reasoning" && execution.text === "") ||
    ("name" in execution &&
      (execution.name === "request_user_input_async" ||
        execution.name === "update_plan" ||
        (execution.content.kind === "tool_result" &&
          execution.content.parts.some((part) => part.type !== "text")) ||
        (execution.content.kind === "text" &&
          (execution.content.attachments?.length ?? 0) > 0)))
  )
}

export function displayRecord(
  record: StoredRolloutItem,
): StoredRolloutItem | undefined {
  const { item } = record
  if (item.type === "response_item") {
    const envelope = item.item
    const message = envelope.item
    if (
      !(
        envelope.id.startsWith("input_") || envelope.id.startsWith("message_")
      ) ||
      !(
        (message.role === "user" && message.context === undefined) ||
        (message.role === "developer" &&
          message.context?.type === "thread_message" &&
          envelope.submissionMetadata?.content !== undefined &&
          envelope.submissionMetadata.provenance !== undefined)
      )
    )
      return undefined
    const { providerMetadata: _providerMetadata, ...input } = envelope
    return { ...record, item: { type: "response_item", item: input } }
  }
  return item.type === "turn_started" ||
    item.type === "turn_context" ||
    item.type === "turn_completed" ||
    item.type === "item_started" ||
    item.type === "item_completed" ||
    item.type === "token_count"
    ? record
    : undefined
}

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
  let boundedStart = visible.length
  let bytes = 0
  while (boundedStart > start) {
    const record = visible[boundedStart - 1]
    if (record === undefined) break
    const size = Buffer.byteLength(JSON.stringify(record))
    if (
      boundedStart < visible.length &&
      (visible.length - boundedStart >= displayPageRecords ||
        bytes + size > displayPageBytes)
    )
      break
    bytes += size
    boundedStart -= 1
  }
  const selected = visible.slice(boundedStart)
  const preceding = visible.slice(0, boundedStart)
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
  const first = selected[0]?.item
  const turnId =
    first === undefined
      ? undefined
      : first.type === "response_item"
        ? first.item.turnId
        : first.type === "turn_context"
          ? first.context.turnId
          : "turnId" in first
            ? first.turnId
            : undefined
  if (turnId !== undefined) {
    add(
      preceding.findLast(
        ({ item }) => item.type === "turn_started" && item.turnId === turnId,
      ),
    )
    add(
      preceding.findLast(
        ({ item }) =>
          item.type === "turn_context" && item.context.turnId === turnId,
      ),
    )
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
      maxBytes?: number
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
    let scannedBytes = 0
    while (cursor > 0) {
      const start = Math.max(0, cursor - tailChunkBytes)
      const chunk = await readBytes(file, start, cursor - start)
      scannedBytes += chunk.length
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
      if (
        options.enough(records, reachedStart) ||
        (options.maxBytes !== undefined && scannedBytes >= options.maxBytes)
      ) {
        return { records, reachedStart, endSeq }
      }
    }
    return { records, reachedStart: true, endSeq }
  } finally {
    await file.close()
  }
}

// Reads complete records forward from a durable checkpoint. An incomplete
// trailing line never advances the checkpoint and will be retried after append.
export async function readJsonlBatch(
  path: string,
  options: JsonlReadOptions & Readonly<{ startByteOffset: number }>,
): Promise<{
  records: readonly StoredRolloutItem[]
  locations: readonly RolloutRecordLocation[]
  endByteOffset: number
  reachedEnd: boolean
  observedByteSize: number
}> {
  const file = await open(path, "r")
  try {
    const end = await jsonlEnd(file, options)
    if (options.startByteOffset > end)
      throw new Error("Rollout checkpoint is outside its physical file.")
    let cursor = options.startByteOffset
    let completeEnd = cursor
    let partial: Buffer[] = []
    const records: StoredRolloutItem[] = []
    const locations: RolloutRecordLocation[] = []
    while (cursor < end) {
      const bytes = await readBytes(
        file,
        cursor,
        Math.min(tailChunkBytes, end - cursor),
      )
      let start = 0
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 10) continue
        const line =
          partial.length === 0
            ? bytes.subarray(start, index)
            : Buffer.concat([...partial, bytes.subarray(start, index)])
        if (line.length > 0) {
          records.push(options.parse(line.toString("utf8")))
          locations.push({
            start: cursor + index - line.length,
            length: line.length + 1,
          })
        }
        partial = []
        completeEnd = cursor + index + 1
        start = index + 1
        if (
          records.length >= displayPageRecords ||
          completeEnd - options.startByteOffset >= displayPageBytes
        )
          return {
            records,
            locations,
            endByteOffset: completeEnd,
            reachedEnd: completeEnd === end,
            observedByteSize: end,
          }
      }
      if (start < bytes.length) partial.push(bytes.subarray(start))
      cursor += bytes.length
    }
    return {
      records,
      locations,
      endByteOffset: completeEnd,
      reachedEnd: true,
      observedByteSize: end,
    }
  } finally {
    await file.close()
  }
}

export async function readJsonlRecordAt(
  path: string,
  location: RolloutRecordLocation,
  parse: (line: string) => StoredRolloutItem,
): Promise<StoredRolloutItem> {
  const file = await open(path, "r")
  try {
    const bytes = await readBytes(file, location.start, location.length)
    if (bytes.length !== location.length || bytes.at(-1) !== 10)
      throw new Error("Indexed rollout record is incomplete.")
    return parse(bytes.subarray(0, -1).toString("utf8"))
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
