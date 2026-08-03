import { createHash } from "node:crypto"
import { open } from "node:fs/promises"

const BINARY_SAMPLE_BYTES = 4 * 1024

export type CapturedLine = {
  readonly length: number
  readonly full?: string
  readonly head?: string
  readonly tail?: string
}

export type TextFileSnapshot = {
  readonly sha256: string
  readonly byteCount: number
  readonly lineCount: number
  readonly binary: boolean
  readonly lineEnding: "CR" | "CRLF" | "LF" | "mixed" | "none"
  readonly finalNewline: boolean
  readonly lines: ReadonlyMap<number, CapturedLine>
}

export class FileChangedDuringSnapshotError extends Error {
  constructor() {
    super("File changed while its read snapshot was being captured.")
    this.name = "FileChangedDuringSnapshotError"
  }
}

export async function captureTextFileSnapshot(input: {
  readonly absolutePath: string
  readonly offset: number
  readonly limit: number
  readonly maxLineCharacters: number
  readonly signal?: AbortSignal
}): Promise<TextFileSnapshot> {
  input.signal?.throwIfAborted()
  const handle = await open(input.absolutePath, "r")
  try {
    const before = await handle.stat()
    const hash = createHash("sha256")
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const sample: Buffer[] = []
    let sampleBytes = 0
    let byteCount = 0
    let lineCount = 0
    let finalNewline = false
    let pendingCarriageReturn = false
    let lf = 0
    let crlf = 0
    let cr = 0
    let line = createLineBuilder(input.maxLineCharacters)
    const selected = new Map<number, CapturedLine>()
    const tailSize = input.offset < 0 ? -input.offset : 0
    const tail = new Array<
      { readonly line: number; readonly capture: CapturedLine } | undefined
    >(tailSize)
    const positiveEnd = input.offset > 0 ? input.offset + input.limit - 1 : 0

    const finishLine = (ending?: "CR" | "CRLF" | "LF") => {
      lineCount += 1
      const capture = finishLineBuilder(line)
      if (
        input.offset > 0 &&
        lineCount >= input.offset &&
        lineCount <= positiveEnd
      ) {
        selected.set(lineCount, capture)
      }
      if (tailSize > 0) {
        tail[(lineCount - 1) % tailSize] = { line: lineCount, capture }
      }
      if (ending === "CRLF") crlf += 1
      else if (ending === "CR") cr += 1
      else if (ending === "LF") lf += 1
      finalNewline = ending !== undefined
      line = createLineBuilder(input.maxLineCharacters)
    }
    const consume = (text: string) => {
      for (const character of text) {
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false
          if (character === "\n") {
            finishLine("CRLF")
            continue
          }
          finishLine("CR")
        }
        if (character === "\r") {
          pendingCarriageReturn = true
        } else if (character === "\n") {
          finishLine("LF")
        } else {
          appendCharacter(line, character)
          finalNewline = false
        }
      }
    }

    const stream = handle.createReadStream({
      autoClose: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(bytes)
      byteCount += bytes.byteLength
      if (sampleBytes < BINARY_SAMPLE_BYTES) {
        const part = bytes.subarray(0, BINARY_SAMPLE_BYTES - sampleBytes)
        sample.push(part)
        sampleBytes += part.byteLength
      }
      consume(decoder.decode(bytes, { stream: true }))
    }
    consume(decoder.decode())
    if (pendingCarriageReturn) {
      finishLine("CR")
    } else if (line.length > 0) {
      finishLine()
    }

    if (input.offset < 0 && -input.offset <= lineCount) {
      const start = lineCount + input.offset + 1
      const end = Math.min(lineCount, start + input.limit - 1)
      for (let number = start; number <= end; number += 1) {
        const entry = tail[(number - 1) % tailSize]
        if (entry?.line === number) selected.set(number, entry.capture)
      }
    }

    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new FileChangedDuringSnapshotError()
    }

    return {
      sha256: hash.digest("hex"),
      byteCount,
      lineCount,
      binary: looksBinary(Buffer.concat(sample)),
      lineEnding: newlineStyle(lf, crlf, cr),
      finalNewline,
      lines: selected,
    }
  } finally {
    await handle.close()
  }
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
): TextFileSnapshot["lineEnding"] {
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
