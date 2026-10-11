import type {
  ResponseItemEnvelope,
  StoredThread,
  ThreadSummary,
} from "../core/rollout.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import type { ThreadStore } from "../core/thread-store.ts"

export class ThreadCollaborationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "ThreadCollaborationError"
  }
}
export type ListThreadsInput = Readonly<{
  searchTerm?: string
  archived?: boolean
  cursor?: string
  limit?: number
}>
export type ReadThreadInput = Readonly<{
  threadId: string
  searchTerm?: string
  turnId?: string
  itemId?: string
  cursor?: string
  limit?: number
  maxCharacters?: number
}>
// Implementation output-safety bounds, not conversation quotas.
const DEFAULT_PAGE_CHARACTERS = 12_000
const MAX_PAGE_CHARACTERS = 32_000

export function createThreadReader(input: {
  store: ThreadStore
  getThreadManager: () => ThreadManager
}) {
  const summary = (thread: ThreadSummary) => ({
    threadId: thread.id,
    ...(thread.title === undefined ? {} : { title: thread.title }),
    updatedAt: thread.updatedAt,
    ...(thread.workingDirectory === undefined
      ? {}
      : { workingDirectory: thread.workingDirectory }),
    archived: thread.archived ?? false,
    active:
      input.getThreadManager().getThread(thread.id)?.snapshot().activeTurnId !==
      undefined,
  })
  return {
    async list(request: ListThreadsInput = {}) {
      const limit = pageLimit(request.limit)
      const archived = request.archived ?? false
      const scope = JSON.stringify([
        "list",
        request.searchTerm ?? null,
        archived,
      ])
      const cursor = readCursor(request.cursor, scope)?.position
      if (cursor !== undefined && typeof cursor !== "string")
        throw invalidCursor()
      if (request.searchTerm !== undefined) {
        requireSearchTerm(request.searchTerm)
        const result = await input.store.searchThreads({
          view: "sessions",
          searchTerm: request.searchTerm,
          archived,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        })
        return {
          threads: result.matches.map((match) => ({
            ...summary(match.summary),
            snippet: match.snippet,
          })),
          truncated: result.nextCursor !== undefined,
          ...(result.nextCursor === undefined
            ? {}
            : { nextCursor: cursorFor(scope, result.nextCursor) }),
          ...(result.unavailableThreadCount === undefined
            ? {}
            : { unavailableThreadCount: result.unavailableThreadCount }),
        }
      }
      const result = await input.store.listThreads({
        view: "sessions",
        archived,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      })
      return {
        threads: result.threads.map(summary),
        truncated: result.nextCursor !== undefined,
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: cursorFor(scope, result.nextCursor) }),
      }
    },
    async read(request: ReadThreadInput) {
      const limit = pageLimit(request.limit)
      if (request.searchTerm !== undefined) {
        if (request.turnId !== undefined || request.itemId !== undefined)
          throw new ThreadCollaborationError(
            "invalid_input",
            "Search cannot be combined with turn_id or item_id; use an occurrence's IDs to read it.",
          )
        requireSearchTerm(request.searchTerm)
        const scope = JSON.stringify([
          "occurrences",
          request.threadId,
          request.searchTerm,
        ])
        const cursor = readCursor(request.cursor, scope)?.position
        if (cursor !== undefined && typeof cursor !== "string")
          throw invalidCursor()
        const result = await input.store.searchThreadOccurrences({
          threadId: request.threadId,
          searchTerm: request.searchTerm,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        })
        if (result === undefined) throw missingThread(request.threadId)
        return {
          threadId: request.threadId,
          occurrences: result.occurrences,
          truncated: result.nextCursor !== undefined,
          ...(result.nextCursor === undefined
            ? {}
            : { nextCursor: cursorFor(scope, result.nextCursor) }),
        }
      }
      const stored = await input.store.readThread(request.threadId)
      if (stored === undefined) throw missingThread(request.threadId)
      return readTranscriptPage(stored, request, limit)
    },
  }
}
function readTranscriptPage(
  stored: StoredThread,
  request: ReadThreadInput,
  limit: number,
) {
  const maxCharacters = request.maxCharacters ?? DEFAULT_PAGE_CHARACTERS
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > MAX_PAGE_CHARACTERS
  )
    throw new ThreadCollaborationError(
      "invalid_input",
      `max_characters must be between 1 and ${MAX_PAGE_CHARACTERS}.`,
    )
  const scope = JSON.stringify([
    "read",
    request.threadId,
    request.turnId ?? null,
    request.itemId ?? null,
  ])
  const position = readCursor(request.cursor, scope)?.position
  if (
    position !== undefined &&
    (!isRecord(position) ||
      !isNatural(position.index) ||
      !isNatural(position.offset) ||
      !isNatural(position.through) ||
      typeof position.anchor !== "string")
  )
    throw invalidCursor()
  const records = stored.rollout.flatMap((record) =>
    record.item.type === "response_item" || record.item.type === "agent_message"
      ? [{ record, envelope: record.item.item }]
      : [],
  )
  const through =
    position === undefined ? records.length : Number(position.through)
  const anchor = JSON.stringify(
    records[through - 1]?.record
      ? [
          records[through - 1]?.record.rolloutId,
          records[through - 1]?.record.seq,
        ]
      : null,
  )
  if (
    through > records.length ||
    (position !== undefined && position.anchor !== anchor)
  )
    throw invalidCursor()
  const origins = new Map(
    records.map(({ record, envelope }) => [envelope.id, record.threadId]),
  )
  const targetTurns = new Map(
    stored.rollout.flatMap(({ item }) =>
      item.type === "thread_message_admitted"
        ? [[item.inputItemId, item.targetTurnId] as const]
        : [],
    ),
  )
  const envelopes = records
    .slice(0, through)
    .map(({ envelope }) => envelope)
    .filter(
      (envelope) =>
        (request.turnId === undefined ||
          (targetTurns.get(envelope.id) ?? envelope.turnId) ===
            request.turnId) &&
        (request.itemId === undefined || envelope.id === request.itemId),
    )
  if (request.itemId !== undefined && envelopes.length === 0)
    throw new ThreadCollaborationError(
      "item_not_found",
      `Item ${request.itemId} was not found in the requested thread and turn.`,
    )
  let index = position === undefined ? 0 : Number(position.index)
  let offset = position === undefined ? 0 : Number(position.offset)
  if (index > envelopes.length || (index === envelopes.length && offset !== 0))
    throw invalidCursor()
  const items: Array<{
    itemId: string
    originThreadId: string
    turnId: string
    role: string
    text: string
    offset: number
    totalCharacters: number
    complete: boolean
  }> = []
  let remaining = maxCharacters
  while (index < envelopes.length && items.length < limit && remaining > 0) {
    const envelope = envelopes[index]
    if (envelope === undefined) throw invalidCursor()
    const text = transcriptText(envelope)
    if (offset > text.length) throw invalidCursor()
    let end = Math.min(text.length, offset + remaining)
    // Keep astral Unicode characters intact across pages; at most one extra code unit.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end++
    const chunk = text.slice(offset, end)
    items.push({
      itemId: envelope.id,
      originThreadId: origins.get(envelope.id) ?? stored.metadata.id,
      turnId: targetTurns.get(envelope.id) ?? envelope.turnId,
      role: envelope.item.role,
      text: chunk,
      offset,
      totalCharacters: text.length,
      complete: end === text.length,
    })
    remaining -= chunk.length
    if (end === text.length) {
      index++
      offset = 0
    } else {
      offset = end
      break
    }
  }
  const truncated = index < envelopes.length
  return {
    threadId: stored.metadata.id,
    representation: "model_content_json" as const,
    snapshot: {
      itemCount: through,
      newerItemsAvailable: records.length > through,
    },
    items,
    truncated,
    ...(truncated
      ? { nextCursor: cursorFor(scope, { index, offset, through, anchor }) }
      : {}),
  }
}
function transcriptText(envelope: ResponseItemEnvelope): string {
  const item = envelope.item
  // Keep semantic model fields (selected excerpts, errors and discovered
  // tools), excluding opaque provider replay and execution-only file grants.
  const visible =
    item.role === "assistant"
      ? { role: item.role, content: item.content }
      : item.role === "tool"
        ? {
            role: item.role,
            toolCallId: item.toolCallId,
            content: item.content,
            ...(item.isError === undefined ? {} : { isError: item.isError }),
            ...(item.toolSearch === undefined
              ? {}
              : { toolSearch: item.toolSearch }),
          }
        : item
  return JSON.stringify({
    ...visible,
    ...(envelope.submissionMetadata?.metadata === undefined
      ? {}
      : { metadata: envelope.submissionMetadata.metadata }),
  })
}
function cursorFor(scope: string, position: unknown): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, position })).toString(
    "base64url",
  )
}
function readCursor(
  cursor: string | undefined,
  scope: string,
): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw invalidCursor()
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.scope !== scope ||
    parsed.position === undefined
  )
    throw invalidCursor()
  return parsed
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isNatural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function invalidCursor() {
  return new ThreadCollaborationError(
    "invalid_cursor",
    "Cursor is invalid or belongs to a different query. Restart the query without a cursor.",
  )
}
function missingThread(id: string) {
  return new ThreadCollaborationError(
    "thread_not_found",
    `Thread ${id} was not found in this service's store.`,
  )
}
function requireSearchTerm(term: string) {
  if (!term.trim())
    throw new ThreadCollaborationError(
      "invalid_input",
      "search_term must not be empty.",
    )
}
function pageLimit(limit = 20): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ThreadCollaborationError(
      "invalid_input",
      "limit must be between 1 and 100.",
    )
  return limit
}
