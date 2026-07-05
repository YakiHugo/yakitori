import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createEventEnvelope,
  EventType,
  type EventEnvelope,
  type KernelEvent,
} from "./events.ts"
import type { SessionId } from "./ids.ts"

export type EventStore = {
  appendEvent(sessionId: SessionId, event: KernelEvent): Promise<EventEnvelope>
  readEvents(sessionId: SessionId): Promise<EventEnvelope[]>
}

export type JsonlEventStoreOptions = {
  readonly rootDir?: string
}

export function createJsonlEventStore(
  options: JsonlEventStoreOptions = {},
): EventStore {
  const rootDir = options.rootDir ?? ".yakitori"

  return {
    async appendEvent(sessionId, event) {
      // The session runner serializes writes; this store validates order but does not lock.
      const events = await readEventsFromFile(rootDir, sessionId)
      const envelope = createEventEnvelope({
        sessionId,
        seq: nextSeq(events),
        event,
      })

      await mkdir(sessionDir(rootDir, sessionId), { recursive: true })
      await appendFile(
        eventsPath(rootDir, sessionId),
        `${JSON.stringify(envelope)}\n`,
        "utf8",
      )
      return envelope
    },

    readEvents(sessionId) {
      return readEventsFromFile(rootDir, sessionId)
    },
  }
}

async function readEventsFromFile(
  rootDir: string,
  sessionId: SessionId,
): Promise<EventEnvelope[]> {
  const content = await readEventsContent(rootDir, sessionId)
  if (content === "") return []

  const events = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseEventEnvelope(line, index + 1))

  assertSessionEvents(sessionId, events)
  return events
}

async function readEventsContent(
  rootDir: string,
  sessionId: SessionId,
): Promise<string> {
  try {
    return await readFile(eventsPath(rootDir, sessionId), "utf8")
  } catch (error) {
    if (isNotFoundError(error)) return ""
    throw error
  }
}

function parseEventEnvelope(line: string, lineNumber: number): EventEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`Invalid event JSON at line ${lineNumber}.`, {
      cause: error,
    })
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid event envelope at line ${lineNumber}.`)
  }

  if (typeof parsed.id !== "string") {
    throw new Error(`Invalid event id at line ${lineNumber}.`)
  }

  if (typeof parsed.sessionId !== "string") {
    throw new Error(`Invalid event session id at line ${lineNumber}.`)
  }

  if (!isPositiveInteger(parsed.seq)) {
    throw new Error(`Invalid event sequence at line ${lineNumber}.`)
  }

  if (!isPositiveInteger(parsed.version)) {
    throw new Error(`Invalid event version at line ${lineNumber}.`)
  }

  if (!isEventType(parsed.type)) {
    throw new Error(`Invalid event type at line ${lineNumber}.`)
  }

  if (typeof parsed.createdAt !== "string") {
    throw new Error(`Invalid event timestamp at line ${lineNumber}.`)
  }

  if (!isRecord(parsed.data)) {
    throw new Error(`Invalid event data at line ${lineNumber}.`)
  }

  return parsed as EventEnvelope
}

function assertSessionEvents(
  sessionId: SessionId,
  events: EventEnvelope[],
): void {
  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1
    if (event.sessionId !== sessionId) {
      throw new Error(`Event session mismatch at sequence ${event.seq}.`)
    }
    if (event.seq !== expectedSeq) {
      throw new Error(
        `Event sequence must be gap-free. Expected ${expectedSeq}, got ${event.seq}.`,
      )
    }
  }
}

function nextSeq(events: EventEnvelope[]): number {
  const last = events.at(-1)
  if (!last) return 1
  return last.seq + 1
}

function sessionDir(rootDir: string, sessionId: SessionId): string {
  return join(rootDir, "sessions", sessionId)
}

function eventsPath(rootDir: string, sessionId: SessionId): string {
  return join(sessionDir(rootDir, sessionId), "events.jsonl")
}

function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypes.has(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const eventTypes = new Set<string>(Object.values(EventType))
