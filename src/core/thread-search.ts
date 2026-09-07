import type { StoredThread, ThreadSummary } from "./rollout.ts"

export type ThreadSearchOccurrence = Readonly<{
  turnId: string
  itemId: string
  snippet: string
  snippetMatchRange: Readonly<{ start: number; end: number }>
}>

type VisibleSearchMessage = Readonly<{
  seq: number
  turnId: string
  itemId: string
  text: string
}>

export function firstVisibleThreadMatch(
  stored: StoredThread,
  searchTerm: string,
): string | undefined {
  const candidates = [
    ...(stored.metadata.title === undefined
      ? []
      : [{ text: stored.metadata.title }]),
    ...visibleSearchMessages(stored),
  ]
  for (const candidate of candidates) {
    const match = literalMatches(candidate.text, searchTerm)[0]
    if (match !== undefined) return snippetForMatch(candidate.text, match).snippet
  }
  return undefined
}

export function visibleThreadSearchOccurrences(
  stored: StoredThread,
  searchTerm: string,
): readonly ThreadSearchOccurrence[] {
  return visibleSearchMessages(stored).flatMap((message) =>
    literalMatches(message.text, searchTerm).map((match) => ({
      turnId: message.turnId,
      itemId: message.itemId,
      ...snippetForMatch(message.text, match),
    })),
  )
}

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

function visibleSearchMessages(
  stored: StoredThread,
): readonly VisibleSearchMessage[] {
  const users: VisibleSearchMessage[] = []
  const completedTurns = new Set(
    stored.rollout.flatMap(({ item }) =>
      item.type === "turn_completed" && item.outcome === "completed"
        ? [item.turnId]
        : [],
    ),
  )
  const assistantTurns = new Map<
    string,
    { lastToolSeq: number; finalText?: VisibleSearchMessage }
  >()
  for (const record of stored.rollout) {
    if (record.item.type !== "response_item") continue
    const envelope = record.item.item
    const message = envelope.item
    if (message.role === "user" && message.context === undefined) {
      users.push({
        seq: record.seq,
        turnId: envelope.turnId,
        itemId: envelope.id,
        text: markdownVisibleText(
          message.content.map((block) => block.text).join("\n"),
        ),
      })
      continue
    }
    if (message.role === "tool") {
      const state = assistantTurns.get(envelope.turnId) ?? { lastToolSeq: -1 }
      state.lastToolSeq = record.seq
      assistantTurns.set(envelope.turnId, state)
      continue
    }
    if (message.role !== "assistant") continue
    const text = markdownVisibleText(
      message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    )
    if (text === "") continue
    const state = assistantTurns.get(envelope.turnId) ?? { lastToolSeq: -1 }
    state.finalText = {
      seq: record.seq,
      turnId: envelope.turnId,
      itemId: envelope.id,
      text,
    }
    assistantTurns.set(envelope.turnId, state)
  }
  const finalAssistants = [...assistantTurns.entries()].flatMap(
    ([turnId, state]) =>
      completedTurns.has(turnId) &&
      state.finalText !== undefined &&
      state.finalText.seq > state.lastToolSeq
        ? [state.finalText]
        : [],
  )
  return [...users, ...finalAssistants].sort((left, right) => left.seq - right.seq)
}

function markdownVisibleText(markdown: string): string {
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
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
}

function decodeMarkdownEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
    if (typeof decimal === "string") return String.fromCodePoint(Number(decimal))
    if (typeof hex === "string") return String.fromCodePoint(Number.parseInt(hex, 16))
    return named[String(name).toLowerCase()] ?? entity
  })
}

function literalMatches(
  text: string,
  searchTerm: string,
): readonly Readonly<{ start: number; end: number }>[] {
  const matcher = new RegExp(escapeRegularExpression(searchTerm), "giu")
  return [...text.matchAll(matcher)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function snippetForMatch(
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

function parseThreadCursor(cursor: string): Readonly<{
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
