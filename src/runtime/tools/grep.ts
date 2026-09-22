import { noToolApprovalRequired } from "./approval-requirements.ts"
import {
  completeFileSearchExecution,
  fileSearchExecution,
} from "./execution-descriptors.ts"
import {
  buildGrepArguments,
  type GrepInput,
  GrepInputSchema,
  parseGrepInput,
} from "./grep-input.ts"
import { resolveSearchPath } from "./path-policy.ts"
import { runRipgrepRecords } from "./ripgrep.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DEFAULT_RESULTS = 250
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_LINE_CHARACTERS = 1_000
const DEFAULT_OUTPUT_BYTES = 40 * 1024
const MIN_OUTPUT_BYTES = 512
const DEFAULT_RAW_BYTES = 5 * 1024 * 1024
const MAX_RECORD_BYTES = 256 * 1024

type Match = {
  readonly path: string
  readonly line: number
  readonly text: string
}

type SearchEntry = {
  readonly content: string
  readonly match?: Match
  readonly lineTruncated?: boolean
}

type GrepRunner = typeof runRipgrepRecords
type GrepTruncationReason = "result_limit" | "output_byte_limit"

export type GrepToolOptions = {
  // This is startup/permission state and is deliberately absent from the
  // model-visible schema.
  readonly includeIgnored?: boolean
  readonly timeoutMs?: number
  readonly maxResults?: number
  readonly maxLineCharacters?: number
  readonly maxOutputBytes?: number
  readonly maxRawBytes?: number
}

export function createGrepTool(
  options: GrepToolOptions = {},
  runRecords: GrepRunner = runRipgrepRecords,
): RuntimeTool {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < MIN_OUTPUT_BYTES) {
    throw new RangeError(
      `grep maxOutputBytes must be an integer of at least ${MIN_OUTPUT_BYTES}.`,
    )
  }
  const limits = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: options.maxResults ?? DEFAULT_RESULTS,
    maxLineCharacters: options.maxLineCharacters ?? DEFAULT_LINE_CHARACTERS,
    maxOutputBytes,
    maxRawBytes: options.maxRawBytes ?? DEFAULT_RAW_BYTES,
  }
  const includeIgnored = options.includeIgnored ?? false

  // TODO(grep-edit-monitoring): Measure grep -> read_file -> edit_file
  // sequences before reconsidering grep-derived edit authorization.
  return {
    toolName: plainToolName("grep"),
    description:
      "Search file contents with ripgrep. Read the relevant file before editing it. Supports regex, file globs, file types, context lines, case-insensitive and multiline search, and workspace-relative or absolute paths. Results are paginated and bounded.",
    approvalRequirement: noToolApprovalRequired,
    effect: "observe",
    supportsParallelToolCalls: true,
    describeExecution: fileSearchExecution("grep"),
    completeExecution: completeFileSearchExecution,
    inputSchema: GrepInputSchema,
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseGrepInput(input, limits.maxResults)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      const resolved = await resolveSearchPath(
        context.workspaceRoot,
        parsed.path,
      )
      if (!resolved.ok) {
        return failure(resolved.error.code, resolved.error.message)
      }

      const entries: SearchEntry[] = []
      let encountered = 0
      let selectedBytes = 0
      let hasMore = false
      let truncationReason: GrepTruncationReason | undefined
      const metadataReserve = Math.max(
        1_024,
        Math.floor(limits.maxOutputBytes / 5),
      )
      const contentBudget = Math.max(1, limits.maxOutputBytes - metadataReserve)
      const accept = (entry: SearchEntry) => {
        if (encountered++ < parsed.offset) return true
        if (entries.length >= parsed.headLimit) {
          hasMore = true
          truncationReason = "result_limit"
          return false
        }
        const bounded = boundLine(entry, limits.maxLineCharacters)
        const bytes = Buffer.byteLength(bounded.content, "utf8")
        const separator = entries.length === 0 ? 0 : 1
        if (selectedBytes + separator + bytes > contentBudget) {
          hasMore = true
          truncationReason = "output_byte_limit"
          return false
        }
        selectedBytes += separator + bytes
        entries.push(bounded)
        return true
      }

      const result = await runRecords(
        buildGrepArguments(parsed, resolved.displayPath, includeIgnored),
        {
          cwd: context.workspaceRoot,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.maxRawBytes,
          maxRecordBytes: MAX_RECORD_BYTES,
          delimiter:
            parsed.outputMode === "files_with_matches" ? "null" : "newline",
          onRecord(record) {
            return parseRecord(record, parsed).every(accept)
          },
        },
      )
      if (!result.ok) return failure("search_failed", result.message)
      if (result.stopReason === "aborted") {
        return failure("search_aborted", "grep search was aborted.")
      }
      if (result.stopReason === "timeout" && entries.length === 0) {
        return failure(
          "search_timeout",
          "Grep search timed out after returning 0 results.",
        )
      }
      // TODO(search-status): Align glob and grep timeout/status fields after
      // both public protocols have been exercised. Do not represent timeout as
      // a pagination truncation reason merely for structural symmetry.
      const timedOut = result.stopReason === "timeout"
      const stoppedByRawOutput =
        result.stopReason === "raw_byte_limit" ||
        result.stopReason === "record_byte_limit"
      if (timedOut) {
        hasMore = false
        truncationReason = undefined
      } else if (stoppedByRawOutput) {
        hasMore = false
        truncationReason = "output_byte_limit"
      }

      return buildSuccess({
        parsed,
        resolvedPath: resolved.displayPath,
        entries,
        hasMore,
        timedOut,
        ...(truncationReason === undefined ? {} : { truncationReason }),
        allowNextPage: !timedOut && !stoppedByRawOutput,
        maxOutputBytes: limits.maxOutputBytes,
      })
    },
  }
}

function parseRecord(record: string, input: GrepInput): SearchEntry[] {
  if (record.length === 0) return []
  if (input.outputMode === "files_with_matches") {
    return [{ content: normalizePath(record) }]
  }
  if (input.outputMode === "count") {
    const separator = record.lastIndexOf("\0")
    if (separator < 0) return []
    const path = normalizePath(record.slice(0, separator))
    return [{ content: `${path}:${record.slice(separator + 1)}` }]
  }
  return parseRipgrepJson(record, input.onlyMatching).map((match) => ({
    content: input.lineNumbers
      ? `${match.path}:${match.line}:${displayText(match.text)}`
      : `${match.path}:${displayText(match.text)}`,
    match,
  }))
}

function parseRipgrepJson(record: string, onlyMatching: boolean): Match[] {
  let event: unknown
  try {
    event = JSON.parse(record)
  } catch {
    return []
  }
  if (
    !isRecord(event) ||
    (event.type !== "match" && event.type !== "context") ||
    !isRecord(event.data)
  )
    return []
  const path = textValue(event.data.path)
  const lines = textValue(event.data.lines)
  const line = event.data.line_number
  if (path === undefined || lines === undefined || typeof line !== "number") {
    return []
  }
  // --json reports complete lines even with --only-matching. Submatch offsets
  // are UTF-8 byte offsets, not JavaScript string indices.
  if (onlyMatching && event.type === "match") {
    if (!Array.isArray(event.data.submatches)) return []
    const bytes =
      isRecord(event.data.lines) && typeof event.data.lines.bytes === "string"
        ? Buffer.from(event.data.lines.bytes, "base64")
        : Buffer.from(lines)
    const matches: Match[] = []
    let scanned = 0
    let matchLine = line
    for (const submatch of event.data.submatches) {
      if (!isRecord(submatch)) continue
      const text = textValue(submatch.match)
      const start = submatch.start
      if (text === undefined || text === "" || typeof start !== "number")
        continue
      while (scanned < start && scanned < bytes.length) {
        if (bytes[scanned] === 10) matchLine += 1
        scanned += 1
      }
      matches.push({ path: normalizePath(path), line: matchLine, text })
    }
    return matches
  }
  const text = lines.replace(/\r\n$|\n$|\r$/u, "")
  return [
    {
      path: normalizePath(path),
      line,
      text,
    },
  ]
}

function buildSuccess(input: {
  readonly parsed: GrepInput
  readonly resolvedPath: string
  readonly entries: SearchEntry[]
  readonly hasMore: boolean
  readonly timedOut: boolean
  readonly truncationReason?: GrepTruncationReason
  readonly allowNextPage: boolean
  readonly maxOutputBytes: number
}): ToolExecutionResult {
  const entries = [...input.entries]
  let output = makeOutput({
    ...input,
    entries,
    hasMore: input.hasMore && input.allowNextPage && entries.length > 0,
  })
  while (
    entries.length > 0 &&
    Buffer.byteLength(JSON.stringify(output), "utf8") > input.maxOutputBytes
  ) {
    entries.pop()
    const reduced = {
      ...input,
      entries,
      hasMore: input.allowNextPage && entries.length > 0,
    }
    output = makeOutput(
      input.timedOut
        ? reduced
        : { ...reduced, truncationReason: "output_byte_limit" },
    )
  }
  if (input.timedOut && entries.length === 0) {
    return failure(
      "search_timeout",
      "Grep search timed out after returning 0 results.",
    )
  }
  if (
    Buffer.byteLength(JSON.stringify(output), "utf8") > input.maxOutputBytes
  ) {
    return failure(
      "output_budget_too_small",
      "Grep result metadata exceeds the configured output byte limit.",
    )
  }
  return { ok: true, output, content: output.content }
}

function makeOutput(input: Parameters<typeof buildSuccess>[0]) {
  const lineTruncated = input.entries.some(
    (entry) => entry.lineTruncated === true,
  )
  const truncated = input.timedOut || input.truncationReason !== undefined
  const output = {
    path: input.resolvedPath,
    outputMode: input.parsed.outputMode,
    count: input.entries.length,
    offset: input.parsed.offset,
    truncated,
    ...(input.truncationReason === undefined
      ? {}
      : { truncationReason: input.truncationReason }),
    timedOut: input.timedOut,
    lineTruncated,
    locations: input.entries.map((entry) =>
      searchLocation(entry, input.parsed.outputMode),
    ),
    content: renderContent(
      input.entries,
      input.hasMore,
      lineTruncated,
      input.timedOut,
      input.truncationReason,
      input.parsed.offset,
    ),
  }
  const nextOffset = input.parsed.offset + input.entries.length
  // TODO(search-pagination): Revisit offset pagination if stable workspace
  // search snapshots become a real GUI or agent workflow requirement.
  return {
    ...output,
    page: {
      offset: input.parsed.offset,
      returned: input.entries.length,
      has_more: input.hasMore,
      ...(input.hasMore
        ? {
            next: {
              offset: nextOffset,
            },
          }
        : {}),
    },
  }
}

function searchLocation(
  entry: SearchEntry,
  outputMode: GrepInput["outputMode"],
) {
  if (entry.match !== undefined) {
    return {
      path: entry.match.path,
      line: entry.match.line,
      text: entry.match.text,
    }
  }
  if (outputMode === "count") {
    const separator = entry.content.lastIndexOf(":")
    const count = Number(entry.content.slice(separator + 1))
    return {
      path: entry.content.slice(0, separator),
      ...(Number.isFinite(count) ? { count } : {}),
    }
  }
  return { path: entry.content }
}

function renderContent(
  entries: readonly SearchEntry[],
  hasMore: boolean,
  lineTruncated: boolean,
  timedOut: boolean,
  truncationReason: GrepTruncationReason | undefined,
  offset: number,
): string {
  if (entries.length === 0 && !timedOut && truncationReason === undefined) {
    return offset === 0
      ? "No matches found."
      : `Grep returned 0 results at offset ${offset}.`
  }
  const noun = entries.length === 1 ? "result" : "results"
  const summary = timedOut
    ? `Grep returned ${entries.length} ${noun} before timing out.`
    : `Grep returned ${entries.length} ${noun}.`
  const markers = [
    ...(truncationReason === "result_limit" && hasMore
      ? [
          `(Results truncated at the result limit. Continue from offset ${offset + entries.length}.)`,
        ]
      : []),
    ...(truncationReason === "output_byte_limit"
      ? [
          entries.length === 0
            ? "(Search output exceeded the byte limit before a complete result was returned.)"
            : "(Search output exceeded the byte limit; partial results shown.)",
        ]
      : []),
    ...(timedOut ? ["(Search timed out; partial results shown.)"] : []),
    ...(lineTruncated
      ? ["(One or more result lines were shortened for display.)"]
      : []),
  ]
  return [summary, ...entries.map((entry) => entry.content), ...markers].join(
    "\n",
  )
}

function displayText(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, "\\n")
}

function boundLine(entry: SearchEntry, maxCharacters: number) {
  if (entry.content.length <= maxCharacters) {
    return entry
  }
  const marker = "…[line truncated]…"
  const available = Math.max(0, maxCharacters - marker.length)
  const prefix = Math.ceil(available / 2)
  const suffix = Math.floor(available / 2)
  return {
    ...entry,
    content: `${entry.content.slice(0, prefix)}${marker}${entry.content.slice(
      entry.content.length - suffix,
    )}`,
    lineTruncated: true,
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "")
}

function textValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.text === "string") return value.text
  return typeof value.bytes === "string"
    ? Buffer.from(value.bytes, "base64").toString("utf8")
    : undefined
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: `${code}: ${message}`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
