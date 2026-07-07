import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  createEventEnvelope,
  EventType,
  type EventEnvelope,
  type EventMetadata,
  InputRole,
  ItemKind,
  ItemStatus,
  type JsonValue,
  type KernelEvent,
  PermissionBehavior,
} from "./events.ts"

export type EventStore = {
  appendEvent(sessionId: string, event: KernelEvent): Promise<EventEnvelope>
  appendEvents(
    sessionId: string,
    events: readonly KernelEvent[],
  ): Promise<EventEnvelope[]>
  readEvents(sessionId: string): Promise<EventEnvelope[]>
}

export type JsonlEventStoreOptions = {
  readonly rootDir?: string
}

export function createJsonlEventStore(
  options: JsonlEventStoreOptions = {},
): EventStore {
  const rootDir = options.rootDir ?? ".yakitori"
  const appendQueues = new Map<string, Promise<void>>()

  return {
    async appendEvent(sessionId, event) {
      assertSessionId(sessionId)
      const envelopes = await serializeSessionAppend(
        appendQueues,
        sessionId,
        () => appendEventsToFile(rootDir, sessionId, [event]),
      )
      const envelope = envelopes.at(0)
      if (!envelope) {
        throw createYakitoriError({
          code: YakitoriErrorCode.InvalidState,
          message: "Expected one appended event.",
          details: {
            sessionId,
          },
        })
      }
      return envelope
    },

    async appendEvents(sessionId, events) {
      assertSessionId(sessionId)
      return serializeSessionAppend(appendQueues, sessionId, () =>
        appendEventsToFile(rootDir, sessionId, events),
      )
    },

    async readEvents(sessionId) {
      assertSessionId(sessionId)
      return readEventsFromFile(rootDir, sessionId)
    },
  }
}

function serializeSessionAppend<T>(
  appendQueues: Map<string, Promise<void>>,
  sessionId: string,
  append: () => Promise<T>,
): Promise<T> {
  const previous = appendQueues.get(sessionId) ?? Promise.resolve()
  // The original caller still receives its own failure; the queue only ignores it
  // so later writes for the same session are not permanently blocked.
  const current = previous.catch(() => undefined).then(append)
  const next = current.then(
    () => undefined,
    () => undefined,
  )

  appendQueues.set(sessionId, next)
  void next.then(() => {
    if (appendQueues.get(sessionId) === next) appendQueues.delete(sessionId)
  })

  return current
}

async function appendEventsToFile(
  rootDir: string,
  sessionId: string,
  eventsToAppend: readonly KernelEvent[],
): Promise<EventEnvelope[]> {
  if (eventsToAppend.length === 0) return []

  const existingEvents = await readEventsFromFile(rootDir, sessionId)
  const nextSequence = nextSeq(existingEvents)
  const envelopes = eventsToAppend.map((event, index) =>
    createEventEnvelope({
      sessionId,
      seq: nextSequence + index,
      event,
    }),
  )

  await mkdir(sessionDir(rootDir, sessionId), { recursive: true })
  await appendFile(
    eventsPath(rootDir, sessionId),
    `${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`,
    "utf8",
  )
  return envelopes
}

async function readEventsFromFile(
  rootDir: string,
  sessionId: string,
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
  sessionId: string,
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
    throw invalidEventLog(`Invalid event JSON at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
      cause: error,
    })
  }

  if (!isRecord(parsed)) {
    throw invalidEventLog(`Invalid event envelope at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (typeof parsed.id !== "string") {
    throw invalidEventLog(`Invalid event id at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (typeof parsed.sessionId !== "string") {
    throw invalidEventLog(`Invalid event session id at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (!isPositiveInteger(parsed.seq)) {
    throw invalidEventLog(`Invalid event sequence at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (!isPositiveInteger(parsed.version)) {
    throw invalidEventLog(`Invalid event version at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (!isEventType(parsed.type)) {
    throw invalidEventLog(`Invalid event type at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (typeof parsed.createdAt !== "string") {
    throw invalidEventLog(`Invalid event timestamp at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }

  if (!isRecord(parsed.data)) {
    throw invalidEventLog(`Invalid event data at line ${lineNumber}.`, {
      details: {
        lineNumber,
      },
    })
  }
  assertEventData(parsed.type, parsed.data, lineNumber)

  return parsed as EventEnvelope
}

function assertSessionEvents(sessionId: string, events: EventEnvelope[]): void {
  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1
    if (event.sessionId !== sessionId) {
      throw invalidEventLog(
        `Event session mismatch at sequence ${event.seq}.`,
        {
          details: {
            expectedSessionId: sessionId,
            actualSessionId: event.sessionId,
            seq: event.seq,
          },
        },
      )
    }
    if (event.seq !== expectedSeq) {
      throw invalidEventLog(
        `Event sequence must be gap-free. Expected ${expectedSeq}, got ${event.seq}.`,
        {
          details: {
            expectedSeq,
            actualSeq: event.seq,
          },
        },
      )
    }
  }
}

function nextSeq(events: EventEnvelope[]): number {
  const last = events.at(-1)
  if (!last) return 1
  return last.seq + 1
}

function sessionDir(rootDir: string, sessionId: string): string {
  return join(rootDir, "sessions", sessionId)
}

function eventsPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "events.jsonl")
}

function assertSessionId(sessionId: string): void {
  if (
    /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      sessionId,
    )
  ) {
    return
  }
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: `Invalid session id ${sessionId}.`,
    details: {
      sessionId,
    },
  })
}

function assertEventData(
  type: EventType,
  data: Record<string, unknown>,
  lineNumber: number,
): void {
  if (isEventData(type, data)) return
  throw invalidEventLog(
    `Invalid event data for ${type} at line ${lineNumber}.`,
    {
      details: {
        type,
        lineNumber,
      },
    },
  )
}

function invalidEventLog(
  message: string,
  input: {
    readonly details?: EventMetadata
    readonly cause?: unknown
  } = {},
): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidEventLog,
    message,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  })
}

function isEventData(type: EventType, data: Record<string, unknown>): boolean {
  switch (type) {
    case EventType.SessionCreated:
      return (
        isOptional(data.title, isString) &&
        isOptional(data.workingDirectory, isString) &&
        isOptional(data.parentSessionId, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.SessionMetadataUpdated:
      return (
        isOptional(data.title, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.InputAdmitted:
      return (
        isString(data.inputId) &&
        isInputRole(data.role) &&
        isTextContent(data.content) &&
        isOptional(data.parentInputId, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.InputPromoted:
      return isString(data.inputId) && isString(data.turnId)
    case EventType.InputCancelled:
      return isString(data.inputId) && isOptional(data.reason, isString)
    case EventType.TurnStarted:
      return (
        isString(data.turnId) &&
        isString(data.inputId) &&
        isOptional(data.parentTurnId, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.TurnCompleted:
      return (
        isString(data.turnId) &&
        isOptional(data.outputItemId, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.TurnFailed:
      return isString(data.turnId) && isKernelError(data.error)
    case EventType.TurnCancelled:
      return isString(data.turnId) && isOptional(data.reason, isString)
    case EventType.ItemAppended:
      return (
        isString(data.itemId) &&
        isString(data.turnId) &&
        isItemKind(data.kind) &&
        isItemContent(data.content) &&
        isOptional(data.parentItemId, isString) &&
        isOptional(data.status, isItemStatus) &&
        isOptional(data.providerMetadata, isJsonObject)
      )
    case EventType.ItemUpdated:
      return (
        isString(data.itemId) &&
        isString(data.turnId) &&
        isOptional(data.content, isItemContent) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.ItemCompleted:
      return (
        isString(data.itemId) &&
        isString(data.turnId) &&
        isCompletedItemStatus(data.status) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.PermissionRequested:
      return (
        isString(data.permissionRequestId) &&
        isString(data.turnId) &&
        isString(data.action) &&
        isOptional(data.subject, isString) &&
        isOptional(data.toolCallId, isString) &&
        isOptional(data.reason, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.PermissionResolved:
      return (
        isString(data.permissionRequestId) &&
        isString(data.turnId) &&
        isPermissionBehavior(data.behavior) &&
        isOptional(data.reason, isPermissionDecisionReason) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.PermissionCancelled:
      return (
        isString(data.permissionRequestId) &&
        isString(data.turnId) &&
        isOptional(data.reason, isString)
      )
    case EventType.ToolRequested:
      return (
        isString(data.toolCallId) &&
        isString(data.turnId) &&
        isString(data.name) &&
        isJsonValue(data.input) &&
        isOptional(data.itemId, isString) &&
        isOptional(data.permissionRequestId, isString) &&
        isOptional(data.providerMetadata, isJsonObject)
      )
    case EventType.ToolStarted:
      return isString(data.toolCallId) && isString(data.turnId)
    case EventType.ToolProgress:
      return (
        isString(data.toolCallId) &&
        isString(data.turnId) &&
        isOptional(data.message, isString) &&
        isOptional(data.data, isJsonValue)
      )
    case EventType.ToolCompleted:
      return (
        isString(data.toolCallId) &&
        isString(data.turnId) &&
        isJsonValue(data.output) &&
        isOptional(data.itemId, isString) &&
        isOptional(data.metadata, isJsonObject)
      )
    case EventType.ToolFailed:
      return (
        isString(data.toolCallId) &&
        isString(data.turnId) &&
        isKernelError(data.error)
      )
    case EventType.ToolCancelled:
      return (
        isString(data.toolCallId) &&
        isString(data.turnId) &&
        isOptional(data.reason, isString)
      )
    default:
      return false
  }
}

function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypes.has(value)
}

function isInputRole(value: unknown): boolean {
  return typeof value === "string" && inputRoles.has(value)
}

function isItemKind(value: unknown): boolean {
  return typeof value === "string" && itemKinds.has(value)
}

function isItemStatus(value: unknown): boolean {
  return typeof value === "string" && itemStatuses.has(value)
}

function isCompletedItemStatus(value: unknown): boolean {
  return value === ItemStatus.Completed || value === ItemStatus.Failed
}

function isPermissionBehavior(value: unknown): boolean {
  return typeof value === "string" && permissionBehaviors.has(value)
}

function isTextContent(value: unknown): boolean {
  return isRecord(value) && value.kind === "text" && isString(value.text)
}

function isItemContent(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === "text") return isString(value.text)
  if (value.kind === "json") return isJsonValue(value.value)
  return false
}

function isKernelError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.message) &&
    isOptional(value.code, isString) &&
    isOptional(value.details, isJsonObject)
  )
}

function isPermissionDecisionReason(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.kind) &&
    isOptional(value.message, isString) &&
    isOptional(value.metadata, isJsonObject)
  )
}

function isJsonObject(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === "string") return true
  if (typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isOptional(
  value: unknown,
  predicate: (value: unknown) => boolean,
): boolean {
  return value === undefined || predicate(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const eventTypes = new Set<string>(Object.values(EventType))
const inputRoles = new Set<string>(Object.values(InputRole))
const itemKinds = new Set<string>(Object.values(ItemKind))
const itemStatuses = new Set<string>(Object.values(ItemStatus))
const permissionBehaviors = new Set<string>(Object.values(PermissionBehavior))
