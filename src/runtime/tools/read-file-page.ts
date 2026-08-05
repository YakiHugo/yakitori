import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

const BINARY_SAMPLE_BYTES = 4 * 1024
const REGULAR_FILE_READ_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32"
    ? 0
    : constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))

export type CapturedLine = {
  readonly length: number
  readonly full?: string
  readonly head?: string
  readonly tail?: string
}

export type TextFilePage = {
  readonly lines: ReadonlyMap<number, CapturedLine>
  readonly reachedEof: boolean
  readonly hasMore: boolean
  readonly binary: boolean
  readonly lineCount?: number
  readonly sha256?: string
  readonly byteCount?: number
  readonly lineEnding?: "CR" | "CRLF" | "LF" | "mixed" | "none"
  readonly finalNewline?: boolean
}

export class FileChangedDuringReadError extends Error {
  constructor() {
    super("File changed while its read page was being captured.")
    this.name = "FileChangedDuringReadError"
  }
}

export class UnsupportedTextFileTypeError extends Error {
  constructor() {
    super("The opened path is not a regular file.")
    this.name = "UnsupportedTextFileTypeError"
  }
}

export async function captureTextFilePage(input: {
  readonly absolutePath: string
  readonly offset: number
  readonly limit: number
  readonly maxLineCharacters: number
  readonly signal?: AbortSignal
}): Promise<TextFilePage> {
  input.signal?.throwIfAborted()
  // The path-policy check provides an early diagnostic, but only the opened
  // descriptor can close the race where the final path is replaced by a FIFO
  // or another special file between lstat and open.
  const handle = await open(input.absolutePath, REGULAR_FILE_READ_FLAGS)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new UnsupportedTextFileTypeError()
    const hash = input.offset === 1 ? createHash("sha256") : undefined
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const sample: Buffer[] = []
    const selected = new Map<number, CapturedLine>()
    let sampleBytes = 0
    let byteCount = 0
    let lineCount = 0
    let finalNewline = false
    let pendingCarriageReturn = false
    let pageFilled = false
    let hasMore = false
    let lf = 0
    let crlf = 0
    let cr = 0
    let line = createLineBuilder(input.maxLineCharacters)
    let currentLineHasContent = false

    const finishLine = (ending?: "CR" | "CRLF" | "LF") => {
      lineCount += 1
      if (lineCount >= input.offset && lineCount < input.offset + input.limit) {
        selected.set(lineCount, finishLineBuilder(line))
        if (selected.size === input.limit) pageFilled = true
      }
      if (ending === "CRLF") crlf += 1
      else if (ending === "CR") cr += 1
      else if (ending === "LF") lf += 1
      finalNewline = ending !== undefined
      line = createLineBuilder(input.maxLineCharacters)
      currentLineHasContent = false
    }
    const consume = (text: string): boolean => {
      for (const character of text) {
        if (pageFilled) {
          hasMore = true
          return false
        }
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false
          if (character === "\n") {
            finishLine("CRLF")
            continue
          }
          finishLine("CR")
          if (pageFilled) {
            hasMore = true
            return false
          }
        }
        if (character === "\r") {
          pendingCarriageReturn = true
        } else if (character === "\n") {
          finishLine("LF")
        } else {
          currentLineHasContent = true
          if (lineCount + 1 >= input.offset) {
            appendCharacter(line, character)
          }
          finalNewline = false
        }
      }
      return true
    }

    const stream = handle.createReadStream({
      autoClose: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    let reachedEof = true
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (pageFilled) {
        hasMore = true
        reachedEof = false
        break
      }
      const boundary = findPageByteBoundary({
        bytes,
        completedLines: lineCount,
        targetLines: input.offset + input.limit - 1,
        pendingCarriageReturn,
      })
      const consumed =
        boundary === undefined ? bytes : bytes.subarray(0, boundary.byteLength)
      hash?.update(consumed)
      byteCount += consumed.byteLength
      if (sampleBytes < BINARY_SAMPLE_BYTES) {
        const part = consumed.subarray(0, BINARY_SAMPLE_BYTES - sampleBytes)
        sample.push(part)
        sampleBytes += part.byteLength
      }
      consume(decoder.decode(consumed, { stream: true }))
      if (boundary?.finishStandaloneCarriageReturn === true) {
        pendingCarriageReturn = false
        finishLine("CR")
      }
      if (boundary?.hasMore === true) {
        hasMore = true
        reachedEof = false
        break
      }
    }

    if (reachedEof) {
      consume(decoder.decode())
      if (pendingCarriageReturn) {
        finishLine("CR")
      } else if (currentLineHasContent) {
        finishLine()
      }
    }

    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new FileChangedDuringReadError()
    }

    const completeMetadata =
      reachedEof && hash !== undefined
        ? {
            sha256: hash.digest("hex"),
            byteCount,
            lineCount,
            lineEnding: newlineStyle(lf, crlf, cr),
            finalNewline,
          }
        : reachedEof
          ? { lineCount }
          : {}
    return {
      lines: selected,
      reachedEof,
      hasMore,
      binary: looksBinary(Buffer.concat(sample)),
      ...completeMetadata,
    }
  } finally {
    await handle.close()
  }
}

type PageByteBoundary = {
  readonly byteLength: number
  readonly hasMore: boolean
  readonly finishStandaloneCarriageReturn: boolean
}

function findPageByteBoundary(input: {
  readonly bytes: Buffer
  readonly completedLines: number
  readonly targetLines: number
  readonly pendingCarriageReturn: boolean
}): PageByteBoundary | undefined {
  let completedLines = input.completedLines
  let pendingCarriageReturn = input.pendingCarriageReturn
  for (let index = 0; index < input.bytes.byteLength; index += 1) {
    const byte = input.bytes[index]
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false
      if (byte === 0x0a) {
        completedLines += 1
        if (completedLines >= input.targetLines) {
          return {
            byteLength: index + 1,
            hasMore: index + 1 < input.bytes.byteLength,
            finishStandaloneCarriageReturn: false,
          }
        }
        continue
      }
      completedLines += 1
      if (completedLines >= input.targetLines) {
        return {
          byteLength: index,
          hasMore: true,
          finishStandaloneCarriageReturn: true,
        }
      }
    }

    if (byte === 0x0d) {
      pendingCarriageReturn = true
    } else if (byte === 0x0a) {
      completedLines += 1
      if (completedLines >= input.targetLines) {
        return {
          byteLength: index + 1,
          hasMore: index + 1 < input.bytes.byteLength,
          finishStandaloneCarriageReturn: false,
        }
      }
    }
  }
  return undefined
}

type LineBuilder = {
  readonly maxCharacters: number
  readonly leadingCharacters: number
  readonly trailingCharacters: number
  length: number
  full: string[]
  head?: string
  tail?: string[]
  tailIndex: number
}

function createLineBuilder(maxCharacters: number): LineBuilder {
  return {
    maxCharacters,
    leadingCharacters: Math.ceil(maxCharacters / 2),
    trailingCharacters: Math.floor(maxCharacters / 2),
    length: 0,
    full: [],
    tailIndex: 0,
  }
}

function appendCharacter(line: LineBuilder, character: string): void {
  line.length += 1
  if (line.tail === undefined) {
    line.full.push(character)
    if (line.length <= line.maxCharacters) return
    line.head = line.full.slice(0, line.leadingCharacters).join("")
    const trailing = line.full.slice(-line.trailingCharacters)
    line.full = []
    line.tail = trailing
    line.tailIndex = 0
    return
  }
  if (line.trailingCharacters === 0) return
  if (line.tail.length < line.trailingCharacters) {
    line.tail.push(character)
    return
  }
  line.tail[line.tailIndex] = character
  line.tailIndex = (line.tailIndex + 1) % line.trailingCharacters
}

function finishLineBuilder(line: LineBuilder): CapturedLine {
  if (line.tail === undefined) {
    return { length: line.length, full: line.full.join("") }
  }
  const orderedTail = [
    ...line.tail.slice(line.tailIndex),
    ...line.tail.slice(0, line.tailIndex),
  ].join("")
  return {
    length: line.length,
    head: line.head ?? "",
    tail: orderedTail,
  }
}

function newlineStyle(
  lf: number,
  crlf: number,
  cr: number,
): NonNullable<TextFilePage["lineEnding"]> {
  const kinds = [lf, crlf, cr].filter((count) => count > 0).length
  if (kinds === 0) return "none"
  if (kinds > 1) return "mixed"
  if (crlf > 0) return "CRLF"
  return cr > 0 ? "CR" : "LF"
}

function looksBinary(sample: Buffer): boolean {
  if (sample.includes(0)) return true
  if (sample.byteLength === 0) return false
  let controls = 0
  for (const byte of sample) {
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
      byte === 0x7f
    ) {
      controls += 1
    }
  }
  return controls / sample.byteLength > 0.3
}
