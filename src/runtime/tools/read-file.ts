import { readdir } from "node:fs/promises"
import { isAbortError } from "../errors.ts"
import { ToolLimitDefaults } from "../limits.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import { resolveReadPath } from "./path-policy.ts"
import {
  completeFileReadExecution,
  fileReadExecution,
} from "./execution-descriptors.ts"
import {
  type CapturedLine,
  captureTextFilePage,
  FileChangedDuringReadError,
  type TextFilePage,
  UnsupportedTextFileTypeError,
} from "./read-file-page.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"
import { plainToolName } from "./tool-name.ts"

const DEFAULT_LINE_CHARACTERS = 2_000
const LINE_TRUNCATION_MARKER = "…[line truncated]…"
const MAX_DIRECTORY_ENTRIES = 100

type ReadInput = {
  readonly path: string
  readonly offset: number
  readonly limit: number
}

export function createReadFileTool(
  maxBytes = ToolLimitDefaults.toolPreviewBytes,
  maxLines = ToolLimitDefaults.toolPreviewLines,
  maxLineCharacters = DEFAULT_LINE_CHARACTERS,
): RuntimeTool {
  const lineLimit = Math.min(maxLines, ToolLimitDefaults.toolPreviewLines)
  return {
    toolName: plainToolName("read_file"),
    description:
      "Read a live, bounded page from a regular UTF-8 text file, or list a directory. Accepts paths relative to the workspace and absolute paths. File lines are prefixed {N}\\t for display; never include those prefixes in edit_file oldString. offset is a 1-based starting line and limit is 1-2000. Pagination is best effort against the file's current contents. Output is capped at 2,000 lines, 2,000 characters per displayed line, and 50 KB. Directory listings do not authorize edits.",
    approvalRequirement: noToolApprovalRequired,
    effect: "observe",
    supportsParallelToolCalls: true,
    describeExecution: fileReadExecution,
    completeExecution: completeFileReadExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative path or absolute path of the UTF-8 text file.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: lineLimit,
          description: `Maximum number of lines to return. Defaults to ${lineLimit}.`,
        },
      },
      required: ["path"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseReadInput(input, lineLimit)
      if (!parsed.ok) return parsed.result

      const resolved = await resolveReadPath(context.workspaceRoot, parsed.path)
      if (!resolved.ok) {
        return readFailure(resolved.error.code, resolved.error.message)
      }
      if (resolved.kind === "directory") {
        return listDirectory(resolved.displayPath, resolved.absolutePath)
      }

      let page: TextFilePage
      try {
        page = await captureTextFilePage({
          absolutePath: resolved.absolutePath,
          offset: parsed.offset,
          limit: parsed.limit,
          maxLineCharacters,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        if (error instanceof FileChangedDuringReadError) {
          return readFailure(
            "file_changed_during_read",
            "The file changed while read_file was capturing its page.",
            { suggestion: "Retry read_file against the latest file contents." },
          )
        }
        if (error instanceof UnsupportedTextFileTypeError) {
          return readFailure(
            "unsupported_file_type",
            "read_file only reads regular files; streams and device files require a bounded command.",
          )
        }
        return readFailure(
          "read_failed",
          "The file could not be read safely as UTF-8 text.",
        )
      }
      if (page.binary) {
        return readFailure(
          "binary_file",
          "read_file only supports UTF-8 text; the first 4 KB appears binary.",
        )
      }

      if (
        page.reachedEof &&
        page.lineCount !== undefined &&
        parsed.offset > Math.max(1, page.lineCount)
      ) {
        return readFailure(
          "offset_out_of_bounds",
          `offset ${parsed.offset} is outside this file's ${page.lineCount} lines.`,
          { lineCount: page.lineCount },
        )
      }

      const selected = selectPageLines({
        lines: page.lines,
        start: parsed.offset,
        limit: parsed.limit,
        byteBudget: maxBytes > 4_096 ? maxBytes - 2_048 : maxBytes,
        maxLineCharacters,
      })
      const canContinue = page.hasMore || selected.truncatedByBytes
      const nextOffset =
        canContinue && selected.lineCount > 0
          ? parsed.offset + selected.lineCount
          : undefined
      const fullMetadata =
        page.sha256 !== undefined &&
        page.byteCount !== undefined &&
        page.lineCount !== undefined &&
        page.lineEnding !== undefined &&
        page.finalNewline !== undefined
          ? {
              sha256: page.sha256,
              byteCount: page.byteCount,
              lineCount: page.lineCount,
              lineEnding: page.lineEnding,
              finalNewline: page.finalNewline,
            }
          : undefined
      const complete =
        parsed.offset === 1 &&
        page.reachedEof &&
        fullMetadata !== undefined &&
        selected.lineCount === (page.lineCount ?? 0) &&
        !selected.truncatedByBytes &&
        selected.truncatedLineCount === 0
      const truncatedByLines = page.hasMore
      const truncated = !complete
      const hint =
        nextOffset === undefined
          ? selected.truncatedLineCount > 0
            ? `\n(${selected.truncatedLineCount} displayed line${selected.truncatedLineCount === 1 ? " was" : "s were"} capped at ${maxLineCharacters} characters.)`
            : ""
          : `\n(${
              selected.truncatedByBytes
                ? `Output capped at ${formatBytes(maxBytes)}. `
                : selected.lineCount === lineLimit
                  ? `Output capped at ${lineLimit} lines. `
                  : ""
            }Showing lines ${parsed.offset}-${Math.max(parsed.offset, nextOffset - 1)}. Use offset=${nextOffset} to continue from the file's current contents.)`
      const visibleContent =
        page.reachedEof && page.lineCount === 0
          ? "(File is empty.)"
          : maxBytes <= 4_096 && selected.truncatedByBytes
            ? addShortTruncationMarker(selected.content, maxBytes)
            : fitUtf8(`${selected.content}${hint}`, maxBytes)
      const fileObservation =
        complete && fullMetadata !== undefined
          ? {
              path: resolved.displayPath,
              kind: "whole_file_read" as const,
              complete: true,
              sha256: fullMetadata.sha256,
            }
          : selected.lineCount > 0
            ? {
                path: resolved.displayPath,
                kind: "ranged_read" as const,
                complete: false,
                ranges: [
                  {
                    startLine: parsed.offset,
                    endLine: parsed.offset + selected.lineCount - 1,
                  },
                ],
              }
            : undefined
      const output = {
        path: resolved.displayPath,
        complete,
        ...(complete && fullMetadata !== undefined
          ? fullMetadata
          : page.lineCount === undefined
            ? {}
            : { lineCount: page.lineCount }),
        empty: page.reachedEof && page.lineCount === 0,
        truncated,
        truncatedByBytes: selected.truncatedByBytes,
        truncatedByLines,
        truncatedByLineLength: selected.truncatedLineCount > 0,
        truncatedLineCount: selected.truncatedLineCount,
        lineCharacterLimit: maxLineCharacters,
        range: {
          offset: parsed.offset,
          limit: selected.lineCount,
          requestedLimit: parsed.limit,
        },
        ...(nextOffset === undefined ? {} : { continuation: { nextOffset } }),
        content: visibleContent,
        ...(fileObservation === undefined ? {} : { fileObservation }),
      }
      return { ok: true, output, content: visibleContent }
    },
  }
}

async function listDirectory(
  displayPath: string,
  absolutePath: string,
): Promise<ToolExecutionResult> {
  let names: string[]
  try {
    names = await readdir(absolutePath)
  } catch {
    return readFailure("read_failed", "The directory could not be listed.")
  }
  names.sort()
  const truncated = names.length > MAX_DIRECTORY_ENTRIES
  const entries = names.slice(0, MAX_DIRECTORY_ENTRIES)
  const noun = entries.length === 1 ? "entry" : "entries"
  const content = [
    `Listed ${entries.length} ${noun} in ${displayPath}.`,
    ...entries,
    ...(truncated
      ? [`(Listing truncated at ${MAX_DIRECTORY_ENTRIES} entries.)`]
      : []),
  ].join("\n")
  return {
    ok: true,
    output: {
      path: displayPath,
      kind: "directory",
      count: entries.length,
      entries,
      truncated,
      content,
    },
    content,
  }
}

function selectPageLines(input: {
  readonly lines: ReadonlyMap<number, CapturedLine>
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
  const end = input.start + input.limit
  for (let number = input.start; number < end; number += 1) {
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
    !(Number.isInteger(input.offset) && (input.offset as number) >= 1)
  ) {
    return readInputFailure("read_file offset must be a positive integer.")
  }
  if (
    input.limit !== undefined &&
    !(
      Number.isInteger(input.limit) &&
      (input.limit as number) > 0 &&
      (input.limit as number) <= defaultLimit
    )
  ) {
    return readInputFailure(
      `read_file limit must be an integer from 1 through ${defaultLimit}.`,
    )
  }
  return {
    ok: true,
    path: input.path,
    offset: typeof input.offset === "number" ? input.offset : 1,
    limit: typeof input.limit === "number" ? input.limit : defaultLimit,
  }
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
  return {
    ok: false,
    code,
    message,
    content: [
      `${code}: ${message}`,
      ...(typeof details.suggestion === "string"
        ? [`Suggestion: ${details.suggestion}`]
        : []),
    ].join("\n"),
    ...(Object.keys(details).length === 0 ? {} : { output: details }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
