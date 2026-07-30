import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  assertEventStoreSessionId,
  type EventStore,
  type EventStoreAppendOptions,
  type EventStoreListSessionsInput,
  type EventStoreListSessionsResult,
  type EventStoreReadEventsInput,
  type EventStoreRebuildProjectionResult,
  type EventStoreSessionSummary,
  paginateSessionSummaries,
  parseStoredEventEnvelope,
  requireAdmissionFingerprint,
  requireExpectedSequence,
  summarizeSessionProjection,
} from "./event-store.ts"
import {
  createEventEnvelope,
  type EventEnvelope,
  EventType,
  isKernelEvent,
  type KernelEvent,
  type StoredEventEnvelope,
} from "./events.ts"
import { isRequestId } from "./ids.ts"
import {
  invalidEventLog,
  isNotFound,
  type JournalCommitRecord,
  type JournalLine,
  parseJournalLine,
  pathExists,
  readSummaryCache,
  type SessionSummaryCache,
  serializeFactLine,
  summaryVersion,
  summaryWithoutCacheFields,
  syncDirectory,
  writeAll,
  writeSummaryCache,
} from "./jsonl-event-store-format.ts"
import { fingerprintInputAdmission } from "./operation.ts"
import {
  applySessionFacts,
  projectSession,
  type SessionProjection,
} from "./session-projector.ts"

export type JsonlEventStoreOptions = {
  readonly sessionsDir?: string
}

export type JsonlEventStore = EventStore & {
  close(): Promise<void>
}

type AdmissionRecord = {
  readonly fingerprint?: string
  readonly event: StoredEventEnvelope
}

type LoadedSession = {
  readonly handle: FileHandle
  readonly events: StoredEventEnvelope[]
  readonly admissions: Map<string, AdmissionRecord>
  journalBytes: number
  projection?: SessionProjection
}

type SummaryJob = {
  latest: SessionSummaryCache | undefined
  promise: Promise<void>
}

export function createJsonlEventStore(
  options: JsonlEventStoreOptions = {},
): JsonlEventStore {
  const sessionsDir = options.sessionsDir ?? join(".yakitori", "sessions")
  const loadedSessions = new Map<string, LoadedSession>()
  const unconfirmedSessions = new Set<string>()
  const sessionGates = new Map<string, Promise<void>>()
  const storeOperations = new Set<Promise<void>>()
  const summaryJobs = new Map<string, SummaryJob>()
  let closing = false
  let closePromise: Promise<void> | undefined

  function runForSession<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = sessionGates.get(sessionId) ?? Promise.resolve()
    const result = previous.then(task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    sessionGates.set(sessionId, settled)
    return result.finally(() => {
      if (sessionGates.get(sessionId) === settled) {
        sessionGates.delete(sessionId)
      }
    })
  }

  function runStoreOperation<T>(task: () => Promise<T>): Promise<T> {
    requireOpen()
    const result = Promise.resolve().then(task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    storeOperations.add(settled)
    return result.finally(() => {
      storeOperations.delete(settled)
    })
  }

  async function appendEvents(
    sessionId: string,
    events: readonly KernelEvent[],
    appendOptions: EventStoreAppendOptions = {},
  ): Promise<EventEnvelope[]> {
    assertEventStoreSessionId(sessionId)
    const eventSnapshot = structuredClone(events)
    const optionsSnapshot = structuredClone(appendOptions)
    requireAdmissionOption(sessionId, eventSnapshot, optionsSnapshot.admission)
    return runStoreOperation(async () => {
      if (eventSnapshot.length === 0) return []
      return runForSession(sessionId, async () => {
        const loaded = await loadSession(sessionId, true)
        if (loaded === undefined) {
          throw new Error(`Failed to create Session journal ${sessionId}.`)
        }
        const admission =
          optionsSnapshot.admission === undefined
            ? undefined
            : loaded.admissions.get(optionsSnapshot.admission.requestId)
        if (
          admission !== undefined &&
          optionsSnapshot.admission !== undefined
        ) {
          return replayAdmission(
            sessionId,
            optionsSnapshot.admission,
            admission,
          )
        }

        const actualSeq = loaded.events.at(-1)?.seq ?? 0
        requireExpectedSequence(
          sessionId,
          optionsSnapshot.expectedSeq,
          actualSeq,
        )
        const envelopes = eventSnapshot.map((event, index) =>
          createEventEnvelope({
            sessionId,
            seq: actualSeq + index + 1,
            event,
          }),
        )
        const newAdmissions = collectNewAdmissions(
          sessionId,
          loaded.admissions,
          envelopes,
        )
        const projection = applySessionFacts(loaded.projection, envelopes)
        if (projection === undefined) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: `Session ${sessionId} append did not produce a projection.`,
            details: { sessionId },
          })
        }
        const bytes = Buffer.from(envelopes.map(serializeFactLine).join(""))

        try {
          await writeAll(loaded.handle, bytes)
          await loaded.handle.sync()
        } catch (cause) {
          let recovered: LoadedSession | undefined
          try {
            await discardLoadedSession(sessionId)
            recovered = await loadSession(sessionId, false)
          } catch (recoveryError) {
            throw appendRecoveryFailure(cause, recoveryError)
          }
          if (recovered !== undefined) {
            unconfirmedSessions.add(sessionId)
            try {
              await synchronizeIfNeeded(sessionId, recovered)
            } catch (recoveryError) {
              throw appendRecoveryFailure(cause, recoveryError)
            }
          }
          const recoveredAdmission =
            optionsSnapshot.admission === undefined
              ? undefined
              : recovered?.admissions.get(optionsSnapshot.admission.requestId)
          if (
            recoveredAdmission !== undefined &&
            optionsSnapshot.admission !== undefined &&
            recovered !== undefined
          ) {
            const replayed = replayAdmission(
              sessionId,
              optionsSnapshot.admission,
              recoveredAdmission,
            )
            scheduleSummary(sessionId, recovered)
            return replayed
          }
          const committed = reconcileCommittedAppend(recovered, envelopes)
          if (committed !== undefined && recovered !== undefined) {
            scheduleSummary(sessionId, recovered)
            return committed
          }
          throw cause
        }

        loaded.events.push(...envelopes)
        loaded.projection = projection
        loaded.journalBytes += bytes.byteLength
        for (const [requestId, record] of newAdmissions) {
          loaded.admissions.set(requestId, record)
        }
        scheduleSummary(sessionId, loaded)
        return structuredClone(envelopes)
      })
    })
  }

  async function loadSession(
    sessionId: string,
    create: boolean,
  ): Promise<LoadedSession | undefined> {
    const cached = loadedSessions.get(sessionId)
    if (cached !== undefined) {
      await synchronizeIfNeeded(sessionId, cached)
      return cached
    }
    const directory = sessionDirectory(sessionId)
    const journal = journalPath(sessionId)
    const exists = await pathExists(journal)
    if (!exists && !create) return undefined
    if (!exists) {
      const directoryExisted = await pathExists(directory)
      const sessionsDirectoryExisted = await pathExists(sessionsDir)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const handle = await open(journal, "a+", 0o600)
      try {
        await syncDirectory(directory)
        if (!directoryExisted) await syncDirectory(sessionsDir)
        if (!sessionsDirectoryExisted) await syncDirectory(dirname(sessionsDir))
      } catch (cause) {
        await handle.close()
        throw cause
      }
      const loaded: LoadedSession = {
        handle,
        events: [],
        admissions: new Map(),
        journalBytes: 0,
      }
      loadedSessions.set(sessionId, loaded)
      try {
        await synchronizeIfNeeded(sessionId, loaded)
        return loaded
      } catch (cause) {
        loadedSessions.delete(sessionId)
        await handle.close()
        throw cause
      }
    }

    const handle = await open(journal, "a+")
    try {
      const loaded = await readCommittedJournal(sessionId, handle, journal)
      loadedSessions.set(sessionId, loaded)
      await synchronizeIfNeeded(sessionId, loaded)
      return loaded
    } catch (cause) {
      loadedSessions.delete(sessionId)
      await handle.close()
      throw cause
    }
  }

  async function readCommittedJournal(
    sessionId: string,
    handle: FileHandle,
    journal: string,
  ): Promise<LoadedSession> {
    const content = await readFile(journal)
    const lastNewline = content.lastIndexOf(0x0a)
    const committedBytes = lastNewline < 0 ? 0 : lastNewline + 1
    if (committedBytes !== content.byteLength) {
      await handle.truncate(committedBytes)
      await handle.sync()
    }
    const lines = content
      .subarray(0, committedBytes)
      .toString("utf8")
      .split("\n")
      .slice(0, -1)
    const storedEvents: StoredEventEnvelope[] = []
    const admissions = new Map<string, AdmissionRecord>()
    let expectedSeq = 1

    for (const [recordIndex, line] of lines.entries()) {
      const recordNumber = recordIndex + 1
      const parsed = parseJournalLine(line, recordNumber)
      const record = isCommitRecord(parsed) ? parsed : undefined
      if (record !== undefined && record.sessionId !== sessionId) {
        throw invalidEventLog(
          `Session journal record ${recordNumber} belongs to another Session.`,
          {
            sessionId,
            recordNumber,
            recordSessionId: record.sessionId,
          },
        )
      }
      if (record !== undefined && record.firstSeq !== expectedSeq) {
        throw invalidEventLog(
          `Session journal record ${recordNumber} is not contiguous.`,
          { sessionId, recordNumber, expectedSeq, actualSeq: record.firstSeq },
        )
      }
      const parsedEvents = isCommitRecord(parsed)
        ? parsed.events.map((event, eventIndex) =>
            parseStoredEventEnvelope(
              JSON.stringify(event),
              recordNumber * 1_000_000 + eventIndex + 1,
            ),
          )
        : [parsed]
      for (const [eventIndex, event] of parsedEvents.entries()) {
        if (event.sessionId !== sessionId || event.seq !== expectedSeq) {
          throw invalidEventLog(
            `Invalid event ordering in Session journal record ${recordNumber}.`,
            {
              sessionId,
              recordNumber,
              eventIndex,
              expectedSeq,
              actualSeq: event.seq,
              eventSessionId: event.sessionId,
            },
          )
        }
        storedEvents.push(event)
        const admission = admissionRecord(event)
        if (admission !== undefined) {
          if (admissions.has(admission.requestId)) {
            throw invalidEventLog(
              `Duplicate admission request ${admission.requestId} in Session journal.`,
              { sessionId, recordNumber, requestId: admission.requestId },
            )
          }
          admissions.set(admission.requestId, admission.record)
        }
        expectedSeq += 1
      }
    }

    const projection = projectSession(storedEvents)
    if (storedEvents.length > 0 && projection === undefined) {
      throw invalidEventLog(`Session journal has no session.created fact.`, {
        sessionId,
      })
    }
    return {
      handle,
      events: storedEvents,
      admissions,
      journalBytes: committedBytes,
      ...(projection === undefined ? {} : { projection }),
    }
  }

  async function discardLoadedSession(sessionId: string): Promise<void> {
    const loaded = loadedSessions.get(sessionId)
    loadedSessions.delete(sessionId)
    await loaded?.handle.close()
  }

  async function synchronizeIfNeeded(
    sessionId: string,
    loaded: LoadedSession,
  ): Promise<void> {
    if (!unconfirmedSessions.has(sessionId)) return
    await loaded.handle.sync()
    unconfirmedSessions.delete(sessionId)
  }

  async function readSummary(
    sessionId: string,
  ): Promise<EventStoreSessionSummary | undefined> {
    const loaded = loadedSessions.get(sessionId)
    if (loaded !== undefined) {
      await synchronizeIfNeeded(sessionId, loaded)
      if (loaded.projection === undefined) return undefined
      return structuredClone(summarizeSessionProjection(loaded.projection))
    }
    const journal = journalPath(sessionId)
    if (!(await pathExists(journal))) return undefined
    const journalBytes = (await stat(journal)).size
    const cached = await readSummaryCache(summaryPath(sessionId))
    if (
      cached !== undefined &&
      cached.sessionId === sessionId &&
      cached.journalBytes === journalBytes
    ) {
      return summaryWithoutCacheFields(cached)
    }
    const session = await loadSession(sessionId, false)
    try {
      if (session?.projection === undefined) return undefined
      const summary = summarizeSessionProjection(session.projection)
      await writeSummaryBestEffort(sessionId, summaryCache(session))
      return structuredClone(summary)
    } finally {
      if (session !== undefined) await discardLoadedSession(sessionId)
    }
  }

  async function writeSummaryBestEffort(
    sessionId: string,
    summary: SessionSummaryCache | undefined,
  ): Promise<void> {
    if (summary === undefined) return
    try {
      await writeSummaryCache(
        summaryPath(sessionId),
        sessionDirectory(sessionId),
        summary,
      )
    } catch (error) {
      console.warn(`Failed to update Session summary ${sessionId}.`, error)
    }
  }

  function scheduleSummary(sessionId: string, loaded: LoadedSession): void {
    const latest = summaryCache(loaded)
    if (latest === undefined) return
    const existing = summaryJobs.get(sessionId)
    if (existing !== undefined) {
      existing.latest = latest
      return
    }
    const job: SummaryJob = {
      latest,
      promise: Promise.resolve(),
    }
    job.promise = new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    }).then(async () => {
      for (;;) {
        const summary = job.latest
        if (summary === undefined) {
          summaryJobs.delete(sessionId)
          return
        }
        job.latest = undefined
        await writeSummaryBestEffort(sessionId, summary)
      }
    })
    summaryJobs.set(sessionId, job)
  }

  function requireOpen(): void {
    if (!closing) return
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: "The Session event store is closed.",
    })
  }

  function sessionDirectory(sessionId: string): string {
    return join(sessionsDir, sessionId)
  }

  function journalPath(sessionId: string): string {
    return join(sessionDirectory(sessionId), "events.jsonl")
  }

  function summaryPath(sessionId: string): string {
    return join(sessionDirectory(sessionId), "summary.json")
  }

  return {
    async appendEvent(sessionId, event, appendOptions = {}) {
      const appended = await appendEvents(sessionId, [event], appendOptions)
      const envelope = appended[0]
      if (envelope === undefined) {
        throw new Error("Single event append returned no event.")
      }
      return envelope
    },
    appendEvents,
    async readEvents(sessionId: string, input: EventStoreReadEventsInput = {}) {
      assertEventStoreSessionId(sessionId)
      return runStoreOperation(() =>
        runForSession(sessionId, async () => {
          const loaded = await loadSession(sessionId, false)
          return structuredClone(
            loaded?.events.filter((event) => event.seq > (input.after ?? 0)) ??
              [],
          )
        }),
      )
    },
    async readProjection(sessionId) {
      assertEventStoreSessionId(sessionId)
      return runStoreOperation(() =>
        runForSession(sessionId, async () => {
          const loaded = await loadSession(sessionId, false)
          return structuredClone(loaded?.projection)
        }),
      )
    },
    async rebuildProjection(
      sessionId: string,
    ): Promise<EventStoreRebuildProjectionResult> {
      assertEventStoreSessionId(sessionId)
      return runStoreOperation(() =>
        runForSession(sessionId, async () => {
          await discardLoadedSession(sessionId)
          const loaded = await loadSession(sessionId, false)
          if (loaded === undefined) return { events: [] }
          await writeSummaryBestEffort(sessionId, summaryCache(loaded))
          return {
            events: structuredClone(loaded.events),
            ...(loaded.projection === undefined
              ? {}
              : { projection: structuredClone(loaded.projection) }),
          }
        }),
      )
    },
    async listSessions(
      input: EventStoreListSessionsInput = {},
    ): Promise<EventStoreListSessionsResult> {
      return runStoreOperation(async () => {
        const entries = await readdir(sessionsDir, {
          withFileTypes: true,
        }).catch((error: unknown) => {
          if (isNotFound(error)) return []
          throw error
        })
        const summaries: EventStoreSessionSummary[] = []
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          try {
            assertEventStoreSessionId(entry.name)
          } catch {
            continue
          }
          const summary = await runForSession(entry.name, () =>
            readSummary(entry.name),
          )
          if (summary !== undefined) summaries.push(summary)
        }
        return paginateSessionSummaries(summaries, input)
      })
    },
    close() {
      if (closePromise !== undefined) return closePromise
      closing = true
      closePromise = Promise.all([...storeOperations])
        .then(() => Promise.all([...sessionGates.values()]))
        .then(() =>
          Promise.all([...summaryJobs.values()].map((job) => job.promise)),
        )
        .then(async () => {
          const loaded = [...loadedSessions.entries()]
          const synchronized = await Promise.allSettled(
            loaded.map(([sessionId, session]) =>
              synchronizeIfNeeded(sessionId, session),
            ),
          )
          const closed = await Promise.allSettled(
            loaded.map(([, session]) => session.handle.close()),
          )
          loadedSessions.clear()
          unconfirmedSessions.clear()
          const errors = [...synchronized, ...closed].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          )
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "Failed to close Session journal handles.",
            )
          }
        })
      return closePromise
    },
  }
}

function summaryCache(loaded: LoadedSession): SessionSummaryCache | undefined {
  if (loaded.projection === undefined) return undefined
  return {
    version: summaryVersion,
    journalBytes: loaded.journalBytes,
    ...summarizeSessionProjection(loaded.projection),
  }
}

function isCommitRecord(line: JournalLine): line is JournalCommitRecord {
  return "record" in line
}

function requireAdmissionOption(
  sessionId: string,
  events: readonly KernelEvent[],
  admission: EventStoreAppendOptions["admission"],
): void {
  if (admission === undefined) return
  const event = events[0]
  if (
    !isRequestId(admission.requestId) ||
    admission.fingerprint.length === 0 ||
    events.length !== 1 ||
    event?.type !== EventType.InputAdmitted ||
    event.data.requestId !== admission.requestId ||
    fingerprintInputAdmission(event.data) !== admission.fingerprint
  ) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidArgument,
      message: "Admission reconciliation must match one input.admitted fact.",
      details: { sessionId },
    })
  }
}

function collectNewAdmissions(
  sessionId: string,
  existing: ReadonlyMap<string, AdmissionRecord>,
  events: readonly EventEnvelope[],
): Map<string, AdmissionRecord> {
  const collected = new Map<string, AdmissionRecord>()
  for (const event of events) {
    const admission = admissionRecord(event)
    if (admission === undefined) continue
    if (
      existing.has(admission.requestId) ||
      collected.has(admission.requestId)
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: `Request ${admission.requestId} was already admitted.`,
        details: { sessionId, requestId: admission.requestId },
      })
    }
    collected.set(admission.requestId, admission.record)
  }
  return collected
}

function admissionRecord(event: StoredEventEnvelope):
  | {
      readonly requestId: string
      readonly record: AdmissionRecord
    }
  | undefined {
  if (
    event.type !== EventType.InputAdmitted ||
    typeof event.data.requestId !== "string"
  ) {
    return undefined
  }
  const fingerprint = isKernelEvent(event)
    ? fingerprintInputAdmission(event.data)
    : undefined
  return {
    requestId: event.data.requestId,
    record: {
      event,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    },
  }
}

function replayAdmission(
  sessionId: string,
  admission: NonNullable<EventStoreAppendOptions["admission"]>,
  record: AdmissionRecord,
): EventEnvelope[] {
  if (record.fingerprint === undefined) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: `Admission ${admission.requestId} is unknown to this runtime.`,
      details: { sessionId, requestId: admission.requestId },
    })
  }
  requireAdmissionFingerprint(sessionId, admission, record.fingerprint)
  if (
    record.event.type !== EventType.InputAdmitted ||
    !isKernelEvent(record.event)
  ) {
    throw createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: `Admission ${admission.requestId} is unknown to this runtime.`,
      details: { sessionId, requestId: admission.requestId },
    })
  }
  return [structuredClone(record.event) as EventEnvelope]
}

function reconcileCommittedAppend(
  recovered: LoadedSession | undefined,
  attempted: readonly EventEnvelope[],
): EventEnvelope[] | undefined {
  const firstSeq = attempted[0]?.seq
  if (recovered === undefined || firstSeq === undefined) return undefined
  const recorded = recovered.events.slice(
    firstSeq - 1,
    firstSeq - 1 + attempted.length,
  )
  if (
    recorded.length !== attempted.length ||
    !recorded.every(
      (event, index) =>
        event.id === attempted[index]?.id &&
        JSON.stringify(event) === JSON.stringify(attempted[index]),
    ) ||
    !recorded.every(isKernelEvent)
  ) {
    return undefined
  }
  return structuredClone(recorded) as EventEnvelope[]
}

function appendRecoveryFailure(
  writeError: unknown,
  recoveryError: unknown,
): AggregateError {
  return new AggregateError(
    [writeError, recoveryError],
    "Session journal append failed and recovery also failed.",
    { cause: writeError },
  )
}
