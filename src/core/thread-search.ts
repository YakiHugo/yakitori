import type { ThreadSummary } from "./rollout.ts"

export type ThreadSearchOccurrence = Readonly<{
  turnId: string
  itemId: string
  snippet: string
  snippetMatchRange: Readonly<{ start: number; end: number }>
}>

export function compareThreadSummaries(
  left: ThreadSummary,
  right: ThreadSummary,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id)
  )
}

export function threadCursor(summary: ThreadSummary): string {
  return JSON.stringify({ updatedAt: summary.updatedAt, id: summary.id })
}

export function startAfterThreadCursor(
  summaries: readonly ThreadSummary[],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 0
  const anchor = parseThreadCursor(cursor)
  const index = summaries.findIndex(
    (summary) =>
      summary.updatedAt < anchor.updatedAt ||
      (summary.updatedAt === anchor.updatedAt && summary.id < anchor.id),
  )
  return index < 0 ? summaries.length : index
}

export function markdownVisibleText(markdown: string): string {
  const withoutFences = markdown.replace(/^\s*```[^\n]*$/gm, "")
  return decodeMarkdownEntities(
    withoutFences
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
      .replace(/^\s*\||\|\s*$/gm, "")
      .replace(/\s*\|\s*/g, " ")
      .replace(/(\*\*|__|~~|\*|_)/g, "")
      .replace(/\\([\\`*{}[\]()#+.!_-])/g, "$1")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/gu, " ")
    .trim()
}

function decodeMarkdownEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  }
  return value.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi,
    (entity, decimal, hex, name) => {
      if (typeof decimal !== "string" && typeof hex !== "string")
        return named[String(name).toLowerCase()] ?? entity
      const code = Number.parseInt(
        typeof decimal === "string" ? decimal : hex,
        typeof decimal === "string" ? 10 : 16,
      )
      // Match the GUI's CommonMark parser for controls, surrogates,
      // noncharacters and code points outside Unicode's range.
      if (
        code < 9 ||
        code === 11 ||
        (code > 13 && code < 32) ||
        (code > 126 && code < 160) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        (code >= 0xfdd0 && code <= 0xfdef) ||
        code % 0x10000 >= 0xfffe ||
        code > 0x10ffff
      )
        return "\uFFFD"
      return String.fromCodePoint(code)
    },
  )
}

export function literalMatches(
  text: string,
  searchTerm: string,
  limit = Number.POSITIVE_INFINITY,
): readonly Readonly<{ start: number; end: number }>[] {
  const matcher = new RegExp(escapeRegularExpression(searchTerm), "giu")
  const matches: Array<Readonly<{ start: number; end: number }>> = []
  for (const match of text.matchAll(matcher)) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
    })
    if (matches.length >= limit) break
  }
  return matches
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function snippetForMatch(
  text: string,
  match: Readonly<{ start: number; end: number }>,
): Readonly<{
  snippet: string
  snippetMatchRange: Readonly<{ start: number; end: number }>
}> {
  const start = Math.max(0, match.start - 48)
  const end = Math.min(text.length, match.end + 96)
  return {
    snippet: text.slice(start, end),
    snippetMatchRange: {
      start: match.start - start,
      end: match.end - start,
    },
  }
}

export function parseThreadCursor(cursor: string): Readonly<{
  updatedAt: string
  id: string
}> {
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch (cause) {
    throw new Error("Thread cursor is invalid.", { cause })
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Thread cursor is invalid.")
  }
  return { updatedAt: value.updatedAt, id: value.id }
}
