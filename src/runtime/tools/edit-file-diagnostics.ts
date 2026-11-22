import type { JsonObject } from "../../kernel/index.ts"
import type { TextMatch } from "./edit-file-match.ts"
import { normalizeUnicodePunctuation } from "./text-file-format.ts"
import type { ToolFailure } from "./types.ts"

const MAX_SCORE_LINES = 8
const MAX_SNIPPET_LINES = 6
const MAX_SNIPPET_BYTES = 1_024

export type EditDiagnosticCandidate = {
  readonly startLine: number
  readonly endLine: number
  readonly score?: number
  readonly text: string
}

export type EditMatchLocation = {
  readonly startLine: number
  readonly endLine: number
}

export function closestEditCandidates(
  content: string,
  oldString: string,
  limit = 3,
): readonly EditDiagnosticCandidate[] {
  const lines = splitLines(content)
  const expected = splitLines(oldString)
  if (lines.length === 0 || expected.length === 0 || limit <= 0) return []

  const windowLength = Math.min(lines.length, expected.length)
  const comparableLines = lines.map((line) => line.trim())
  const comparableExpected = expected.map((line) => line.trim())
  const candidates: EditDiagnosticCandidate[] = []
  for (let start = 0; start <= lines.length - windowLength; start += 1) {
    const score = candidateScore(
      comparableLines,
      comparableExpected,
      start,
      windowLength,
    )
    if (score === 0) continue
    if (!couldEnterRanking(candidates, score, start + 1, limit)) continue
    insertRankedCandidate(
      candidates,
      {
        startLine: start + 1,
        endLine: start + windowLength,
        score,
        text: formatLines(
          lines.slice(start, start + Math.min(windowLength, MAX_SNIPPET_LINES)),
          start + 1,
        ),
      },
      limit,
    )
  }
  return candidates
}

export function editMismatchEvidence(
  content: string,
  oldString: string,
  newString: string,
) {
  if (newString.length >= 20 && content.includes(newString)) {
    return {
      diagnostic: "already_applied",
      suggestion:
        "The replacement is already present. Check whether the requested change has been applied.",
    }
  }
  const actual = content.replace(/\r\n|\r/g, "\n")
  const expected = oldString.replace(/\r\n|\r/g, "\n")
  const unindent = (value: string) => value.replace(/^[ \t]+/gmu, "")
  if (
    unindent(expected).trim() !== "" &&
    unindent(actual).includes(unindent(expected))
  ) {
    return {
      diagnostic: "indentation_mismatch",
      suggestion: "Use the indentation shown in the current file.",
    }
  }
  const normalized = normalizeUnicodePunctuation(actual)
  const index = normalized.indexOf(normalizeUnicodePunctuation(expected))
  if (
    index !== -1 &&
    actual.slice(index, index + expected.length) !== expected
  ) {
    const lines = matchedEditLocations(actual, [
      { start: index, end: index + expected.length },
    ])
    const found = lines[0]
    if (found !== undefined) {
      return {
        diagnostic: "unicode_punctuation_mismatch",
        locations: lines,
        suggestion: `Use the exact Unicode punctuation or spacing on lines ${found.startLine}–${found.endLine}.`,
      }
    }
  }
  return {}
}

export function matchedEditLocations(
  content: string,
  matches: readonly TextMatch[],
  limit = 5,
): readonly EditMatchLocation[] {
  if (limit <= 0) return []
  return matches.slice(0, limit).map((match) => {
    const startLine = lineNumberAt(content, match.start)
    const matchedLines = splitLines(content.slice(match.start, match.end))
    return {
      startLine,
      endLine: startLine + Math.max(0, matchedLines.length - 1),
    }
  })
}

function candidateScore(
  lines: readonly string[],
  expected: readonly string[],
  start: number,
  windowLength: number,
): number {
  let score = 0
  const compared = Math.min(windowLength, expected.length, MAX_SCORE_LINES)
  for (let index = 0; index < compared; index += 1) {
    const actualLine = lines[start + index] ?? ""
    const expectedLine = expected[index] ?? ""
    if (actualLine === expectedLine) {
      score += 2
    } else if (
      actualLine.length > 0 &&
      expectedLine.length > 0 &&
      (actualLine.includes(expectedLine) || expectedLine.includes(actualLine))
    ) {
      score += 1
    }
  }
  return score
}

function couldEnterRanking(
  candidates: readonly EditDiagnosticCandidate[],
  score: number,
  startLine: number,
  limit: number,
): boolean {
  if (candidates.length < limit) return true
  const last = candidates.at(-1)
  if (last === undefined) return true
  return (
    score > (last.score ?? 0) ||
    (score === (last.score ?? 0) && startLine < last.startLine)
  )
}

function insertRankedCandidate(
  candidates: EditDiagnosticCandidate[],
  candidate: EditDiagnosticCandidate,
  limit: number,
): void {
  const index = candidates.findIndex(
    (existing) =>
      (candidate.score ?? 0) > (existing.score ?? 0) ||
      ((candidate.score ?? 0) === (existing.score ?? 0) &&
        candidate.startLine < existing.startLine),
  )
  candidates.splice(index < 0 ? candidates.length : index, 0, candidate)
  if (candidates.length > limit) candidates.pop()
}

function splitLines(value: string): readonly string[] {
  const normalized = value.replace(/\r\n|\r/g, "\n").replace(/\n$/u, "")
  return normalized.length === 0 ? [] : normalized.split("\n")
}

function lineNumberAt(content: string, offset: number): number {
  return 1 + (content.slice(0, offset).match(/\r\n|\r|\n/g) ?? []).length
}

function formatLines(lines: readonly string[], startLine?: number): string {
  const formatted = lines
    .map((line, index) =>
      startLine === undefined ? `  ${line}` : `  ${startLine + index}| ${line}`,
    )
    .join("\n")
  return truncateUtf8(formatted, MAX_SNIPPET_BYTES)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const marker = "…"
  const available = maxBytes - Buffer.byteLength(marker, "utf8")
  let result = ""
  let bytes = 0
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8")
    if (bytes + width > available) break
    result += character
    bytes += width
  }
  return `${result}${marker}`
}

export function editFailure(
  code: string,
  message: string,
  details: JsonObject = {},
): ToolFailure {
  return {
    ok: false,
    code,
    message,
    content: renderEditFailure(code, message, details),
    ...(Object.keys(details).length === 0 ? {} : { output: details }),
  }
}

function renderEditFailure(
  code: string,
  message: string,
  details: JsonObject,
): string {
  const lines = [`${code}: ${message}`]
  if (typeof details.suggestion === "string") {
    lines.push(`Suggestion: ${details.suggestion}`)
  }
  if (Array.isArray(details.nearMatches)) {
    lines.push("Near matches:")
    for (const match of details.nearMatches) {
      if (!isRecord(match)) continue
      lines.push(
        `Lines ${String(match.startLine)}-${String(match.endLine)} (score ${String(match.score)}):`,
      )
      if (typeof match.text === "string") lines.push(match.text)
    }
  }
  if (Array.isArray(details.locations)) {
    lines.push(
      typeof details.diagnostic === "string"
        ? "Matching locations:"
        : "Exact match locations:",
    )
    for (const location of details.locations) {
      if (!isRecord(location)) continue
      lines.push(
        `- lines ${String(location.startLine)}-${String(location.endLine)}`,
      )
    }
  }
  return lines.join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
