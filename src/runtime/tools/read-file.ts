import { RuntimeLimits } from "../limits.ts"
import { resolveReadPath } from "./path-policy.ts"
import {
  captureTextFileSnapshot,
  type CapturedLine,
  FileChangedDuringSnapshotError,
  type TextFileSnapshot,
} from "./read-file-snapshot.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DEFAULT_LINE_CHARACTERS = 2_000
const LINE_TRUNCATION_MARKER = "…[line truncated]…"

type ReadInput = {
  readonly path: string
  readonly offset: number
  readonly limit: number
}

export function createReadFileTool(
  maxBytes = RuntimeLimits.modelVisibleToolResultBytes,
  maxLines = RuntimeLimits.modelVisibleToolResultLines,
  maxLineCharacters = DEFAULT_LINE_CHARACTERS,
): RuntimeTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file or a bounded line range from one file snapshot. Lines are prefixed {N}\\t for display; never include those prefixes in edit_file oldString. offset is 1-based and may be negative from the end. Output is capped at 2,000 lines, 2,000 characters per displayed line, and 50 KB. Continuation revision checks are maintained internally.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          description:
            "1-based starting line; a negative value counts backward from the final line.",
          anyOf: [{ minimum: 1 }, { minimum: -maxLines, maximum: -1 }],
        },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseReadInput(input, maxLines)
      if (!parsed.ok) return parsed.result

      const resolved = await resolveReadPath(context.workspaceRoot, parsed.path)
      if (!resolved.ok) {
        return readFailure(resolved.error.code, resolved.error.message)
      }

      let snapshot: TextFileSnapshot
      try {
        snapshot = await captureTextFileSnapshot({
          absolutePath: resolved.absolutePath,
          offset: parsed.offset,
          limit: Math.min(parsed.limit, maxLines),
          maxLineCharacters,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        if (error instanceof FileChangedDuringSnapshotError) {
          return readFailure(
            "file_changed_during_read",
            "The file changed while read_file was capturing its snapshot.",
            { suggestion: "Retry read_file against the latest file contents." },
          )
        }
        return readFailure(
          "read_failed",
          "The file could not be read safely as UTF-8 text.",
        )
      }
      if (snapshot.binary) {
        return readFailure(
          "binary_file",
          "read_file only supports UTF-8 text; the first 4 KB appears binary.",
        )
      }

      const start = resolveOffset(parsed.offset, snapshot.lineCount)
      if (start === undefined) {
        return readFailure(
          "offset_out_of_bounds",
          `offset ${parsed.offset} is outside this file's ${snapshot.lineCount} lines.`,
          { lineCount: snapshot.lineCount },
        )
      }
      const continuationSha = context.fileObservations?.continuationSha(
        resolved.relativePath,
        start,
      )
      if (
        continuationSha !== undefined &&
        continuationSha !== snapshot.sha256
      ) {
        return readFailure(
          "read_stale",
          "The file changed since the previous read_file page.",
          {
            suggestion:
              "Restart reading this file at offset 1 before continuing.",
          },
        )
      }

      if (
        context.fileObservations?.hasRead({
          path: resolved.relativePath,
          sha256: snapshot.sha256,
          offset: start,
          limit: parsed.limit,
        })
      ) {
        const output = {
          path: resolved.relativePath,
          sha256: snapshot.sha256,
          unchanged: true,
          status: "read_unchanged",
          range: { offset: start, requestedLimit: parsed.limit },
          content:
            "(File unchanged; reuse the previous read_file result for this range.)",
        }
        return { ok: true, output, content: JSON.stringify(output) }
      }

      const selected = selectSnapshotLines({
        lines: snapshot.lines,
        lineCount: snapshot.lineCount,
        start,
        limit: Math.min(parsed.limit, maxLines),
        byteBudget: maxBytes > 4_096 ? maxBytes - 2_048 : maxBytes,
        maxLineCharacters,
      })
      const nextOffset =
        start - 1 + selected.lineCount < snapshot.lineCount
          ? start + selected.lineCount
          : undefined
      const truncatedByLines =
        nextOffset !== undefined && !selected.truncatedByBytes
      const truncated =
        selected.truncatedByBytes ||
        selected.truncatedLineCount > 0 ||
        nextOffset !== undefined
      const hint =
        nextOffset === undefined
          ? selected.truncatedLineCount > 0
            ? `\n(${selected.truncatedLineCount} displayed line${selected.truncatedLineCount === 1 ? " was" : "s were"} capped at ${maxLineCharacters} characters.)`
            : ""
          : `\n(${
              selected.truncatedByBytes
                ? `Output capped at ${formatBytes(maxBytes)}. `
                : selected.lineCount === maxLines
                  ? `Output capped at ${maxLines} lines. `
                  : ""
            }Showing lines ${start}-${Math.max(start, nextOffset - 1)}. Use offset=${nextOffset} to continue; revision checking is automatic.)`
      const visibleContent =
        snapshot.lineCount === 0
          ? "(File is empty.)"
          : maxBytes <= 4_096 && selected.truncatedByBytes
            ? addShortTruncationMarker(selected.content, maxBytes)
            : fitUtf8(`${selected.content}${hint}`, maxBytes)
      const output = {
        path: resolved.relativePath,
        sha256: snapshot.sha256,
        byteCount: snapshot.byteCount,
        lineCount: snapshot.lineCount,
        lineEnding: snapshot.lineEnding,
        finalNewline: snapshot.finalNewline,
        empty: snapshot.lineCount === 0,
        truncated,
        truncatedByBytes: selected.truncatedByBytes,
        truncatedByLines,
        truncatedByLineLength: selected.truncatedLineCount > 0,
        truncatedLineCount: selected.truncatedLineCount,
        lineCharacterLimit: maxLineCharacters,
        range: {
          offset: start,
          limit: selected.lineCount,
          requestedLimit: parsed.limit,
        },
        ...(nextOffset === undefined ? {} : { continuation: { nextOffset } }),
        content: visibleContent,
      }
      return { ok: true, output, content: JSON.stringify(output) }
    },
  }
}

function selectSnapshotLines(input: {
  readonly lines: ReadonlyMap<number, CapturedLine>
  readonly lineCount: number
  readonly start: number
  readonly limit: number
  readonly byteBudget: number
  readonly maxLineCharacters: number
}): {
  readonly content: string
  readonly lineCount: number
  readonly truncatedByBytes: boolean
  readonly truncatedLineCount: number
} {
  const parts: string[] = []
  let bytes = 0
  let truncatedByBytes = false
  let truncatedLineCount = 0
  const end = Math.min(input.lineCount, input.start - 1 + input.limit)
  for (let index = input.start - 1; index < end; index += 1) {
    const number = index + 1
    const line = input.lines.get(number)
    if (line === undefined) break
    const bounded = renderBoundedLine(number, line, input.maxLineCharacters)
    const value = parts.length === 0 ? bounded.content : `\n${bounded.content}`
    const width = Buffer.byteLength(value, "utf8")
    if (bytes + width > input.byteBudget) {
      truncatedByBytes = true
      break
    }
    if (bounded.truncated) truncatedLineCount += 1
    parts.push(value)
    bytes += width
  }
  return {
    content: parts.join(""),
    lineCount: parts.length,
    truncatedByBytes,
    truncatedLineCount,
  }
}

function renderBoundedLine(
  number: number,
  line: CapturedLine,
  maxCharacters: number,
): { readonly content: string; readonly truncated: boolean } {
  const prefix = `${number}\t`
  if (line.full !== undefined && prefix.length + line.length <= maxCharacters) {
    return { content: `${prefix}${line.full}`, truncated: false }
  }
  if (prefix.length >= maxCharacters) {
    return {
      content: prefix.slice(0, Math.max(0, maxCharacters)),
      truncated: true,
    }
  }
  const marker = LINE_TRUNCATION_MARKER.slice(
    0,
    Math.max(0, maxCharacters - prefix.length),
  )
  const available = Math.max(0, maxCharacters - prefix.length - marker.length)
  const leading = Math.ceil(available / 2)
  const trailing = Math.floor(available / 2)
  const head = line.full ?? line.head ?? ""
  const tail = line.full ?? line.tail ?? ""
  return {
    content: `${prefix}${head.slice(0, leading)}${marker}${tail.slice(tail.length - trailing)}`,
    truncated: true,
  }
}

function parseReadInput(
  input: unknown,
  defaultLimit: number,
):
  | ({ readonly ok: true } & ReadInput)
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (!isRecord(input)) {
    return readInputFailure("read_file input must be an object.")
  }
  const unsupported = Object.keys(input).find(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  )
  if (unsupported !== undefined) {
    return readInputFailure(
      `read_file does not accept the ${unsupported} argument.`,
    )
  }
  if (typeof input.path !== "string") {
    return readInputFailure("read_file path must be a string.")
  }
  if (
    input.offset !== undefined &&
    !(
      Number.isInteger(input.offset) &&
      input.offset !== 0 &&
      (input.offset as number) >= -defaultLimit
    )
  ) {
    return readInputFailure(
      `read_file offset must be a non-zero integer no less than -${defaultLimit}.`,
    )
  }
  if (
    input.limit !== undefined &&
    !(Number.isInteger(input.limit) && (input.limit as number) > 0)
  ) {
    return readInputFailure("read_file limit must be a positive integer.")
  }
  return {
    ok: true,
    path: input.path,
    offset: typeof input.offset === "number" ? input.offset : 1,
    limit: typeof input.limit === "number" ? input.limit : defaultLimit,
  }
}

function resolveOffset(offset: number, lineCount: number): number | undefined {
  if (lineCount === 0) return offset === 1 ? 1 : undefined
  const resolved = offset < 0 ? lineCount + offset + 1 : offset
  return resolved >= 1 && resolved <= lineCount ? resolved : undefined
}

function fitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let bytes = 0
  let end = 0
  for (const char of value) {
    const width = Buffer.byteLength(char, "utf8")
    if (bytes + width > maxBytes) break
    bytes += width
    end += char.length
  }
  return value.slice(0, end)
}

function addShortTruncationMarker(value: string, maxBytes: number): string {
  const marker = "\n...[truncated bytes]"
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"))
  return `${fitUtf8(value, available)}${fitUtf8(marker, maxBytes - available)}`
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`
}

function readInputFailure(message: string): {
  readonly ok: false
  readonly result: ToolExecutionResult
} {
  return { ok: false, result: readFailure("invalid_tool_input", message) }
}

function readFailure(
  code: string,
  message: string,
  details: Record<string, string | number> = {},
): ToolExecutionResult {
  const error = { code, message, ...details }
  return {
    ok: false,
    code,
    message,
    content: JSON.stringify({ error }),
    ...(Object.keys(details).length === 0 ? {} : { output: details }),
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
