import { createHash } from "node:crypto"
import { type FileHandle, open } from "node:fs/promises"
import { detectImageMediaType } from "../../kernel/image-metadata.ts"
import { regularFileReadFlags } from "./text-file-snapshot.ts"

const BINARY_SAMPLE_BYTES = 4 * 1024
// Some regular virtual files report a zero size even when their contents are readable.
const UNKNOWN_SIZE_READ_LIMIT = 1024 * 1024

export type CapturedLine = {
  readonly length: number
  readonly full?: string
  readonly head?: string
  readonly tail?: string
}

export type TextFilePage = {
  readonly startLine: number
  readonly lines: ReadonlyMap<number, CapturedLine>
  readonly reachedEof: boolean
  readonly hasMore: boolean
  readonly binary: boolean
  readonly media?: "image" | "pdf"
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
  readonly revisionBytes?: number
  readonly allowAppend?: boolean
}): Promise<TextFilePage> {
  input.signal?.throwIfAborted()
  // The path-policy check provides an early diagnostic, but only the opened
  // descriptor can close the race where the final path is replaced by a FIFO
  // or another special file between lstat and open.
  const handle = await open(input.absolutePath, regularFileReadFlags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new UnsupportedTextFileTypeError()
    const size = Number(before.size)
    const readLimit = size === 0 ? UNKNOWN_SIZE_READ_LIMIT + 1 : size
    const tail =
      input.offset < 0
        ? await scanFilePrefix(handle, readLimit, true, input.signal)
        : undefined
    if (size === 0 && tail !== undefined && tail.byteCount >= readLimit) {
      throw new Error("The virtual file exceeded the bounded tail scan.")
    }
    const startLine =
      tail === undefined
        ? input.offset
        : Math.max(1, tail.lineCount + input.offset + 1)
    const captureRevision =
      size > 0 &&
      input.revisionBytes !== undefined &&
      size <= input.revisionBytes
    const hash = createHash("sha256")
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const selected = new Map<number, CapturedLine>()
    let encodedBytes = 0
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
      if (lineCount >= startLine && lineCount - startLine < input.limit) {
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
          if (lineCount + 1 >= startLine) {
            appendCharacter(line, character)
          }
          finalNewline = false
        }
      }
      return true
    }

    let reachedEof = true
    for await (const bytes of readFilePrefix(handle, readLimit, input.signal)) {
      if (encodedBytes === 0) {
        const media =
          bytes.toString("latin1", 0, 5) === "%PDF-"
            ? "pdf"
            : detectImageMediaType(bytes) === undefined
              ? undefined
              : "image"
        if (media !== undefined) {
          return {
            startLine,
            lines: selected,
            binary: true,
            reachedEof: false,
            hasMore: false,
            media,
          }
        }
      }
      hash.update(bytes)
      encodedBytes += bytes.byteLength
      if (pageFilled) {
        hasMore = true
        reachedEof = false
        if (!captureRevision) break
        continue
      }
      const boundary = findPageByteBoundary({
        bytes,
        completedLines: lineCount,
        targetLines: startLine + input.limit - 1,
        pendingCarriageReturn,
      })
      const consumed =
        boundary === undefined ? bytes : bytes.subarray(0, boundary.byteLength)
      if (
        byteCount === 0 &&
        looksBinary(consumed.subarray(0, BINARY_SAMPLE_BYTES))
      ) {
        return {
          startLine,
          lines: selected,
          binary: true,
          reachedEof: false,
          hasMore: false,
        }
      }
      byteCount += consumed.byteLength
      consume(decoder.decode(consumed, { stream: true }))
      if (boundary?.finishStandaloneCarriageReturn === true) {
        pendingCarriageReturn = false
        finishLine("CR")
      }
      if (boundary?.hasMore === true) {
        hasMore = true
        reachedEof = false
        if (!captureRevision) break
      }
    }

    if (size === 0 && encodedBytes >= readLimit && !pageFilled) {
      throw new Error("The virtual file exceeded the bounded page scan.")
    }
    if (reachedEof) {
      consume(decoder.decode())
      if (pendingCarriageReturn) {
        finishLine("CR")
      } else if (currentLineHasContent) {
        finishLine()
      }
    }

    const capturedHash = hash.digest("hex")
    const after = await handle.stat({ bigint: true })
    const unchanged =
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs
    if (!unchanged) {
      // A growing log is safe to display only when the captured prefix still
      // matches. Tail offsets also depend on the bytes counted in the first pass.
      if (
        input.allowAppend !== true ||
        after.size <= before.size ||
        (await scanFilePrefix(handle, encodedBytes, false, input.signal))
          .sha256 !== capturedHash ||
        (tail !== undefined &&
          (await scanFilePrefix(handle, tail.byteCount, false, input.signal))
            .sha256 !== tail.sha256)
      ) {
        throw new FileChangedDuringReadError()
      }
      const verified = await handle.stat({ bigint: true })
      if (
        verified.size !== after.size ||
        verified.mtimeNs !== after.mtimeNs ||
        verified.ctimeNs !== after.ctimeNs
      ) {
        throw new FileChangedDuringReadError()
      }
    }
    if (
      tail !== undefined &&
      ((size > 0 && tail.byteCount !== size) ||
        (encodedBytes === tail.byteCount && tail.sha256 !== capturedHash))
    ) {
      throw new FileChangedDuringReadError()
    }
    const wholeFile = reachedEof && startLine === 1
    const sha256 =
      encodedBytes === size && (captureRevision || wholeFile)
        ? capturedHash
        : undefined
    return {
      startLine,
      lines: selected,
      reachedEof,
      hasMore,
      binary: false,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(reachedEof ? { lineCount } : {}),
      ...(wholeFile
        ? { byteCount, lineEnding: newlineStyle(lf, crlf, cr), finalNewline }
        : {}),
    }
  } finally {
    await handle.close()
  }
}

async function scanFilePrefix(
  handle: FileHandle,
  size: number,
  countLines: boolean,
  signal?: AbortSignal,
): Promise<{ sha256: string; lineCount: number; byteCount: number }> {
  const hash = createHash("sha256")
  let lineCount = 0
  let byteCount = 0
  let previous: number | undefined
  for await (const bytes of readFilePrefix(handle, size, signal)) {
    hash.update(bytes)
    byteCount += bytes.length
    if (!countLines) continue
    for (const byte of bytes) {
      if (byte === 0x0d || (byte === 0x0a && previous !== 0x0d)) lineCount++
      previous = byte
    }
  }
  if (previous !== undefined && previous !== 0x0a && previous !== 0x0d)
    lineCount++
  return { sha256: hash.digest("hex"), lineCount, byteCount }
}

async function* readFilePrefix(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
) {
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024))
  let offset = 0
  while (offset < size) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    )
    if (bytesRead === 0) break
    offset += bytesRead
    yield buffer.subarray(0, bytesRead)
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
