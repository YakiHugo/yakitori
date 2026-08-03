import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { RuntimeLimits } from "../limits.ts"
import {
  buildGrepArguments,
  grepRevision,
  GrepInputSchema,
  parseGrepInput,
  type GrepInput,
  type GrepOutputMode,
} from "./grep-input.ts"
import { isSensitiveWorkspacePath, resolveSearchPath } from "./path-policy.ts"
import { runRipgrepRecords, type RipgrepRecordResult } from "./ripgrep.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DEFAULT_RESULTS = 250
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_LINE_CHARACTERS = 1_000
const DEFAULT_OUTPUT_BYTES = 40 * 1024
const DEFAULT_RAW_BYTES = 5 * 1024 * 1024
const MAX_RECORD_BYTES = 256 * 1024

type Match = {
  readonly path: string
  readonly line: number
  readonly endLine: number
  readonly text: string
  readonly fullLine: boolean
}

type SearchEntry = {
  readonly content: string
  readonly match?: Match
}

type GrepRunner = typeof runRipgrepRecords

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
  const limits = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: options.maxResults ?? DEFAULT_RESULTS,
    maxLineCharacters: options.maxLineCharacters ?? DEFAULT_LINE_CHARACTERS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    maxRawBytes: options.maxRawBytes ?? DEFAULT_RAW_BYTES,
  }
  const includeIgnored = options.includeIgnored ?? false

  return {
    name: "grep",
    description:
      "Search file contents with ripgrep. Supports regex, file globs, file types, context lines, case-insensitive and multiline search. files_with_matches is sorted newest-first; content and count are sorted by path and line. Results are paginated and bounded.",
    autoAllow: true,
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

      const currentRevision = grepRevision(
        parsed,
        resolved.relativePath,
        includeIgnored,
        context.fileObservations?.checkpoint() ?? "untracked",
      )
      if (parsed.offset > 0 && parsed.expectedRevision === undefined) {
        return failure(
          "missing_revision",
          "grep expected_revision is required when offset is greater than zero. Restart at offset 0.",
        )
      }
      if (
        parsed.expectedRevision !== undefined &&
        parsed.expectedRevision !== currentRevision
      ) {
        return failure(
          "stale_revision",
          "grep results may have changed since the previous page. Restart at offset 0 without expected_revision.",
        )
      }

      const entries: SearchEntry[] = []
      let encountered = 0
      let selectedBytes = 0
      let hasMore = false
      let lineTruncated = false
      let limitReason: string | undefined
      const metadataReserve = Math.max(
        1_024,
        Math.floor(limits.maxOutputBytes / 5),
      )
      const contentBudget = Math.max(1, limits.maxOutputBytes - metadataReserve)
      const accept = (entry: SearchEntry) => {
        if (
          entry.match !== undefined &&
          isSensitiveWorkspacePath(entry.match.path)
        ) {
          return true
        }
        if (entry.match === undefined) {
          const path = entryPath(entry.content, parsed.outputMode)
          if (path !== undefined && isSensitiveWorkspacePath(path)) return true
        }
        if (encountered++ < parsed.offset) return true
        if (entries.length >= parsed.headLimit) {
          hasMore = true
          limitReason = "result_limit"
          return false
        }
        const bounded = boundLine(entry, limits.maxLineCharacters)
        lineTruncated ||= bounded.truncated
        const bytes = Buffer.byteLength(bounded.entry.content, "utf8")
        const separator = entries.length === 0 ? 0 : 1
        if (selectedBytes + separator + bytes > contentBudget) {
          hasMore = true
          limitReason = "output_byte_limit"
          return false
        }
        selectedBytes += separator + bytes
        entries.push(bounded.entry)
        return true
      }

      const result = await runRecords(
        buildGrepArguments(parsed, resolved.relativePath, includeIgnored),
        {
          cwd: context.workspaceRoot,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.maxRawBytes,
          maxRecordBytes: MAX_RECORD_BYTES,
          delimiter:
            parsed.outputMode === "files_with_matches" ? "null" : "newline",
          onRecord(record) {
            const entry = parseRecord(record, parsed)
            return entry === undefined || accept(entry)
          },
        },
      )
      if (!result.ok) return failure("search_failed", result.message)
      if (result.stopReason === "aborted") {
        return failure("search_aborted", "grep search was aborted.")
      }
      if (
        result.stopReason !== undefined &&
        result.stopReason !== "consumer_limit"
      ) {
        hasMore = true
        limitReason = result.stopReason
      }

      return buildSuccess({
        parsed,
        workspaceRoot: context.workspaceRoot,
        resolvedPath: resolved.relativePath,
        includeIgnored,
        entries,
        hasMore,
        lineTruncated,
        ...(limitReason === undefined ? {} : { limitReason }),
        maxOutputBytes: limits.maxOutputBytes,
        stopResult: result,
        ...(context.fileObservations === undefined
          ? {}
          : { fileObservations: context.fileObservations }),
      })
    },
  }
}

function parseRecord(
  record: string,
  input: GrepInput,
): SearchEntry | undefined {
  if (record.length === 0) return undefined
  if (input.outputMode === "files_with_matches") {
    return { content: normalizePath(record) }
  }
  if (input.outputMode === "count") {
    const separator = record.lastIndexOf("\0")
    if (separator < 0) return undefined
    const path = normalizePath(record.slice(0, separator))
    return { content: `${path}:${record.slice(separator + 1)}` }
  }
  const match = parseRipgrepJson(record, input.onlyMatching)
  if (match === undefined) return undefined
  return {
    content: input.lineNumbers
      ? `${match.path}:${match.line}:${displayText(match.text)}`
      : `${match.path}:${displayText(match.text)}`,
    match,
  }
}

function parseRipgrepJson(
  record: string,
  onlyMatching: boolean,
): Match | undefined {
  let event: unknown
  try {
    event = JSON.parse(record)
  } catch {
    return undefined
  }
  if (
    !isRecord(event) ||
    (event.type !== "match" && event.type !== "context") ||
    !isRecord(event.data)
  )
    return undefined
  const path = textValue(event.data.path)
  const lines = textValue(event.data.lines)
  const line = event.data.line_number
  if (path === undefined || lines === undefined || typeof line !== "number") {
    return undefined
  }
  const text = lines.replace(/\r\n$|\n$|\r$/u, "")
  const lineCount = text.length === 0 ? 1 : text.split(/\r\n|\n|\r/u).length
  return {
    path: normalizePath(path),
    line,
    endLine: line + lineCount - 1,
    text,
    fullLine: event.type === "context" || !onlyMatching,
  }
}

async function buildSuccess(input: {
  readonly parsed: GrepInput
  readonly workspaceRoot: string
  readonly resolvedPath: string
  readonly includeIgnored: boolean
  readonly entries: SearchEntry[]
  readonly hasMore: boolean
  readonly lineTruncated: boolean
  readonly limitReason?: string
  readonly maxOutputBytes: number
  readonly stopResult: Extract<RipgrepRecordResult, { readonly ok: true }>
  readonly fileObservations?: import("./file-observations.ts").FileObservationStore
}): Promise<ToolExecutionResult> {
  const entries = [...input.entries]
  const hashes = await hashVisibleFiles(input.workspaceRoot, entries)
  let output = makeOutput(input, entries, hashes)
  while (
    entries.length > 0 &&
    Buffer.byteLength(JSON.stringify(output), "utf8") > input.maxOutputBytes
  ) {
    entries.pop()
    output = makeOutput(
      { ...input, hasMore: true, limitReason: "output_byte_limit" },
      entries,
      hashes,
    )
  }
  return { ok: true, output, content: JSON.stringify(output) }
}

function makeOutput(
  input: Parameters<typeof buildSuccess>[0],
  entries: readonly SearchEntry[],
  hashes: ReadonlyMap<string, string>,
) {
  const observations = buildObservations(entries, hashes)
  const truncated =
    input.hasMore ||
    input.lineTruncated ||
    input.stopResult.stopReason !== undefined
  const preliminary = {
    path: input.resolvedPath,
    outputMode: input.parsed.outputMode,
    count: entries.length,
    offset: input.parsed.offset,
    observations,
    truncated,
    timedOut: input.stopResult.stopReason === "timeout",
    ...(input.limitReason === undefined
      ? {}
      : { limitReason: input.limitReason }),
    content: renderContent(
      entries,
      input.hasMore,
      input.lineTruncated,
      input.parsed.offset,
    ),
  }
  const checkpoint =
    input.fileObservations?.checkpointAfterSuccess("grep", {}, preliminary) ??
    "untracked"
  const revision = grepRevision(
    input.parsed,
    input.resolvedPath,
    input.includeIgnored,
    checkpoint,
  )
  const nextOffset = input.parsed.offset + entries.length
  return {
    ...preliminary,
    revision,
    page: {
      offset: input.parsed.offset,
      returned: entries.length,
      has_more: input.hasMore,
      snapshot_token: revision,
      ...(input.hasMore
        ? {
            next: {
              offset: nextOffset,
              expected_revision: revision,
            },
          }
        : {}),
    },
  }
}

function renderContent(
  entries: readonly SearchEntry[],
  hasMore: boolean,
  lineTruncated: boolean,
  offset: number,
): string {
  const body = entries.map((entry) => entry.content).join("\n")
  const markers = [
    ...(lineTruncated ? ["(One or more result lines were truncated.)"] : []),
    ...(hasMore
      ? [
          `(Results truncated. Continue from offset ${offset + entries.length} with the returned expected_revision, or narrow the search.)`,
        ]
      : []),
  ]
  if (body.length === 0 && markers.length === 0) return "No matches found"
  return [...(body.length === 0 ? [] : [body]), ...markers].join("\n")
}

function buildObservations(
  entries: readonly SearchEntry[],
  hashes: ReadonlyMap<string, string>,
) {
  const lines = new Map<string, number[]>()
  for (const entry of entries) {
    if (entry.match === undefined) continue
    const existing = lines.get(entry.match.path) ?? []
    for (let line = entry.match.line; line <= entry.match.endLine; line += 1) {
      existing.push(line)
    }
    lines.set(entry.match.path, existing)
  }
  return [...lines]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, observedLines]) => {
      const sha256 = hashes.get(path)
      if (sha256 === undefined) return []
      const sorted = [...new Set(observedLines)].sort(
        (left, right) => left - right,
      )
      const ranges: { startLine: number; endLine: number }[] = []
      for (const line of sorted) {
        const previous = ranges.at(-1)
        if (previous !== undefined && line === previous.endLine + 1) {
          previous.endLine = line
        } else {
          ranges.push({ startLine: line, endLine: line })
        }
      }
      return [{ path, sha256, kind: "grep_snippet", ranges }]
    })
}

async function hashVisibleFiles(
  workspaceRoot: string,
  entries: readonly SearchEntry[],
): Promise<ReadonlyMap<string, string>> {
  const paths = [
    ...new Set(
      entries.flatMap((entry) => (entry.match ? [entry.match.path] : [])),
    ),
  ]
  const hashes = new Map<string, string>()
  for (const path of paths) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(`${workspaceRoot}/${path}`, "r")
      if ((await handle.stat()).size > RuntimeLimits.fileWriteBytes) continue
      const content = await handle.readFile()
      if (content.byteLength > RuntimeLimits.fileWriteBytes) continue
      const visible = entries.filter((entry) => entry.match?.path === path)
      if (!matchesCurrentContent(content.toString("utf8"), visible)) continue
      hashes.set(path, createHash("sha256").update(content).digest("hex"))
    } catch {
      // A disappearing file is not a valid observation. The visible search
      // line remains useful, but it cannot authorize a later write.
    } finally {
      await handle?.close()
    }
  }
  return hashes
}

function matchesCurrentContent(
  content: string,
  entries: readonly SearchEntry[],
): boolean {
  const lines = content.split(/\r\n|\n|\r/u)
  return entries.every((entry) => {
    const match = entry.match
    if (match === undefined) return true
    const current = lines.slice(match.line - 1, match.endLine).join("\n")
    const expected = match.text.replace(/\r\n|\r|\n/gu, "\n")
    return match.fullLine ? current === expected : current.includes(expected)
  })
}

function displayText(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, "\\n")
}

function boundLine(entry: SearchEntry, maxCharacters: number) {
  if (entry.content.length <= maxCharacters) {
    return { entry, truncated: false }
  }
  const marker = "…[line truncated]…"
  const available = Math.max(0, maxCharacters - marker.length)
  const prefix = Math.ceil(available / 2)
  const suffix = Math.floor(available / 2)
  return {
    entry: {
      ...entry,
      content: `${entry.content.slice(0, prefix)}${marker}${entry.content.slice(
        entry.content.length - suffix,
      )}`,
    },
    truncated: true,
  }
}

function entryPath(content: string, mode: GrepOutputMode): string | undefined {
  if (mode === "files_with_matches") return content
  if (mode !== "count") return undefined
  const separator = content.lastIndexOf(":")
  return separator < 0 ? undefined : content.slice(0, separator)
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "")
}

function textValue(value: unknown): string | undefined {
  return isRecord(value) && typeof value.text === "string"
    ? value.text
    : undefined
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: JSON.stringify({ error: { code, message } }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
