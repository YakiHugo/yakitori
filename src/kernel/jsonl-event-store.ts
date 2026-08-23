import { randomUUID } from "node:crypto"
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  appendForkCutTurnClosures,
  assertEventStoreSessionId,
  collapseSessionConversations,
  type EventStore,
  type EventStoreAppendOptions,
  type EventStoreForkSessionInput,
  type EventStoreForkSessionResult,
  type EventStoreListSessionsInput,
  type EventStoreListSessionsResult,
  type EventStoreReadEventsInput,
  type EventStoreRebuildProjectionResult,
  paginateSessionSummaries,
  requireAdmissionFingerprint,
  requireExpectedSequence,
} from "./event-store.ts"
import {
  createEventEnvelope,
  type EventEnvelope,
  EventType,
  isKernelFact,
  isKernelEvent,
  type KernelFact,
  type SessionCreatedEvent,
  type SessionHistoryPosition,
  type StoredEventEnvelope,
} from "./events.ts"
import { isRequestId } from "./ids.ts"
import {
  invalidEventLog,
  isNotFound,
  parseJournalLine,
  parseJournalRecord,
  pathExists,
  readSummaryCache,
  type SessionSummaryCache,
  serializeFactBatchLine,
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
  type SessionSummary,
  summarizeSessionProjection,
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

type ForkReference = {
  readonly parentSessionId: string
  readonly atInputId: string
  readonly historyBase: SessionHistoryPosition
}

type JournalHeader = {
  readonly created: StoredEventEnvelope & {
    readonly type: typeof EventType.SessionCreated
  }
  readonly headerBytes: number
  readonly journalBytes: number
}

type HistorySegment = {
  readonly sessionId: string
  readonly startByteOffset: number
  readonly endByteOffset: number
  readonly startSeq: number
  readonly endSeqExclusive: number
}

type PhysicalEventRecord = {
  readonly event: StoredEventEnvelope
  readonly lineStart: number
  readonly lineEnd: number
  readonly lineEventIndex: number
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
  let graphGate = Promise.resolve()
  let recoveryPromise: Promise<void> | undefined
  let sessionsDirectoryNeedsSync = false
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
    const result = ensureStoreRecovered().then(task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    storeOperations.add(settled)
    return result.finally(() => {
      storeOperations.delete(settled)
    })
  }

  function ensureStoreRecovered(): Promise<void> {
    recoveryPromise ??= cleanupStagingDirectories()
    return recoveryPromise
  }

  async function cleanupStagingDirectories(): Promise<void> {
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNotFound(error)) return []
        throw error
      },
    )
    const staging = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(".staging-"),
    )
    await Promise.all(
      staging.map((entry) =>
        rm(join(sessionsDir, entry.name), { recursive: true, force: true }),
      ),
    )
    if (staging.length > 0) await syncDirectory(sessionsDir)
  }

  function runGraphOperation<T>(task: () => Promise<T>): Promise<T> {
    const result = graphGate.then(task)
    graphGate = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function publishSessionJournal(
    sessionId: string,
    events: readonly StoredEventEnvelope[],
  ): Promise<void> {
    const sessionsDirectoryExisted = await pathExists(sessionsDir)
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 })
    if (!sessionsDirectoryExisted) await syncDirectory(dirname(sessionsDir))
    const target = sessionDirectory(sessionId)
    if (await pathExists(target)) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: `Session ${sessionId} already exists.`,
        details: { sessionId },
      })
    }
    const staging = join(sessionsDir, `.staging-${sessionId}-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    const stagingJournal = join(staging, "events.jsonl")
    let handle: FileHandle | undefined
    try {
      handle = await open(stagingJournal, "wx", 0o600)
      await writeAll(
        handle,
        Buffer.from(events.map(serializeFactLine).join("")),
      )
      await handle.sync()
      await handle.close()
      handle = undefined
      await syncDirectory(staging)
      await rename(staging, target)
      await confirmSessionsDirectoryMutation()
    } catch (cause) {
      await handle?.close()
      await rm(staging, { recursive: true, force: true })
      throw cause
    }
  }

  async function confirmSessionsDirectoryMutation(): Promise<void> {
    try {
      await syncDirectory(sessionsDir)
      sessionsDirectoryNeedsSync = false
    } catch (error) {
      // rename/unlink is the visibility commit point. Reporting the operation
      // as failed after that point would invite a retry even though the target
      // is already published. Keep the durability barrier pending and retry it
      // on a later mutation or close instead.
      sessionsDirectoryNeedsSync = true
      console.warn(
        `Failed to sync Session directory ${sessionsDir}; durability confirmation is pending.`,
        error,
      )
    }
  }

  async function createSession(
    sessionId: string,
    created: SessionCreatedEvent,
  ): Promise<EventEnvelope> {
    assertEventStoreSessionId(sessionId)
    const snapshot = structuredClone(created)
    if (
      snapshot.data.historyBase !== undefined ||
      snapshot.data.forkedFromInputId !== undefined ||
      snapshot.data.forkReason !== undefined
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidArgument,
        message: "A root Session cannot carry fork history metadata.",
        details: { sessionId },
      })
    }
    const event = createEventEnvelope({
      sessionId,
      seq: 1,
      event: {
        ...snapshot,
        data: {
          ...snapshot.data,
          conversationId: snapshot.data.conversationId ?? sessionId,
        },
      },
    })
    return runStoreOperation(() =>
      runForSession(sessionId, async () => {
        if (await pathExists(journalPath(sessionId))) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: `Session ${sessionId} already exists.`,
            details: { sessionId },
          })
        }
        await publishSessionJournal(sessionId, [event])
        const loaded = await loadSession(sessionId, false)
        if (loaded?.projection === undefined) {
          throw new Error(`Failed to load created Session ${sessionId}.`)
        }
        scheduleSummary(sessionId, loaded)
        return structuredClone(event)
      }),
    )
  }

  async function appendEvents(
    sessionId: string,
    events: readonly KernelFact[],
    appendOptions: EventStoreAppendOptions = {},
  ): Promise<EventEnvelope[]> {
    assertEventStoreSessionId(sessionId)
    const eventSnapshot = structuredClone(events)
    const optionsSnapshot = structuredClone(appendOptions)
    if (
      eventSnapshot.some((event) => event.type === EventType.SessionCreated)
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidArgument,
        message: "session.created can only be written by createSession.",
        details: { sessionId },
      })
    }
    requireAdmissionOption(sessionId, eventSnapshot, optionsSnapshot.admission)
    return runStoreOperation(async () => {
      if (eventSnapshot.length === 0) return []
      return runForSession(sessionId, async () => {
        const loaded = await loadSession(sessionId, false)
        if (loaded === undefined) {
          throw createYakitoriError({
            code: YakitoriErrorCode.NotFound,
            message: `Session ${sessionId} has not been created.`,
            details: { sessionId },
          })
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
        const bytes = Buffer.from(
          optionsSnapshot.atomic === true && envelopes.length > 1
            ? serializeFactBatchLine(envelopes)
            : envelopes.map(serializeFactLine).join(""),
        )

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

  async function forkSession(
    input: EventStoreForkSessionInput,
  ): Promise<EventStoreForkSessionResult> {
    assertEventStoreSessionId(input.sourceSessionId)
    assertEventStoreSessionId(input.targetSessionId)
    if (input.sourceSessionId === input.targetSessionId) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidArgument,
        message: "A Session cannot be forked onto itself.",
      })
    }
    if (
      input.created.data.parentSessionId !== input.sourceSessionId ||
      input.created.data.forkedFromInputId !== input.atInputId ||
      input.created.data.forkReason === undefined ||
      input.created.data.historyBase !== undefined
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidArgument,
        message:
          "A forked Session must record its source, input boundary, and reason.",
        details: {
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
        },
      })
    }
    if (
      input.initialEvents?.some(
        (event) => event.type === EventType.SessionCreated,
      )
    ) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidArgument,
        message: "Fork initial events cannot contain session.created.",
        details: { targetSessionId: input.targetSessionId },
      })
    }
    const snapshot = structuredClone(input)
    return runStoreOperation(() =>
      runGraphOperation(() =>
        runForSession(snapshot.sourceSessionId, async () => {
          const source = await loadSession(snapshot.sourceSessionId, false)
          if (source === undefined) {
            throw createYakitoriError({
              code: YakitoriErrorCode.NotFound,
              message: `Session ${snapshot.sourceSessionId} has not been created.`,
              details: { sessionId: snapshot.sourceSessionId },
            })
          }
          const sourceSeq = source.events.at(-1)?.seq ?? 0
          requireExpectedSequence(
            snapshot.sourceSessionId,
            snapshot.expectedSourceSeq,
            sourceSeq,
          )
          const cutIndex = source.events.findIndex(
            (event) =>
              event.type === EventType.InputAdmitted &&
              event.data.inputId === snapshot.atInputId,
          )
          if (cutIndex === -1) {
            throw createYakitoriError({
              code: YakitoriErrorCode.NotFound,
              message: `Input ${snapshot.atInputId} was not found.`,
              details: { inputId: snapshot.atInputId },
            })
          }
          const cutEvent = source.events[cutIndex]
          if (cutEvent === undefined) {
            throw new Error("Fork boundary disappeared from loaded history.")
          }
          const historyBase = await findHistoryPosition(
            snapshot.sourceSessionId,
            cutEvent.seq,
          )

          return runForSession(snapshot.targetSessionId, async () => {
            if (
              (await loadSession(snapshot.targetSessionId, false)) !== undefined
            ) {
              throw createYakitoriError({
                code: YakitoriErrorCode.InvalidState,
                message: `Session ${snapshot.targetSessionId} already exists.`,
                details: { sessionId: snapshot.targetSessionId },
              })
            }
            const created = createEventEnvelope({
              sessionId: snapshot.targetSessionId,
              seq: 1,
              event: {
                ...snapshot.created,
                data: {
                  ...snapshot.created.data,
                  conversationId:
                    snapshot.created.data.conversationId ??
                    source.projection?.conversationId ??
                    snapshot.sourceSessionId,
                  historyBase,
                },
              },
            })
            const events: StoredEventEnvelope[] = [
              created,
              ...source.events.slice(1, cutIndex).map((event) => ({
                ...structuredClone(event),
                sessionId: snapshot.targetSessionId,
              })),
            ]
            appendForkCutTurnClosures(snapshot.targetSessionId, events)
            const inheritedProjection = projectSession(events)
            if (inheritedProjection === undefined) {
              throw new Error("Expected a forked Session projection.")
            }
            for (const pending of inheritedProjection.pendingInputs) {
              events.push(
                createEventEnvelope({
                  sessionId: snapshot.targetSessionId,
                  seq: events.length + 1,
                  event: {
                    type: EventType.InputCancelled,
                    data: {
                      inputId: pending.inputId,
                      reason: "conversation_fork",
                    },
                  },
                }),
              )
            }
            for (const event of snapshot.initialEvents ?? []) {
              events.push(
                createEventEnvelope({
                  sessionId: snapshot.targetSessionId,
                  seq: events.length + 1,
                  event,
                }),
              )
            }
            const localEvents = [created, ...events.slice(cutIndex)]
            const projection = projectSession(events)
            if (projection === undefined) {
              throw createYakitoriError({
                code: YakitoriErrorCode.InvalidState,
                message: `Forking Session ${snapshot.sourceSessionId} did not produce a projection.`,
                details: {
                  sessionId: snapshot.sourceSessionId,
                  targetSessionId: snapshot.targetSessionId,
                },
              })
            }
            collectNewAdmissions(snapshot.targetSessionId, new Map(), events)
            await publishSessionJournal(snapshot.targetSessionId, localEvents)
            const target = await loadSession(snapshot.targetSessionId, false)
            if (target?.projection === undefined) {
              throw new Error(
                `Failed to load forked Session ${snapshot.targetSessionId}.`,
              )
            }
            scheduleSummary(snapshot.targetSessionId, target)
            await discardLoadedSession(snapshot.sourceSessionId)
            return structuredClone({
              historyEndSeqExclusive: historyBase.endSeqExclusive,
              events,
              localEvents,
              projection,
            })
          })
        }),
      ),
    )
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
    const journal = journalPath(sessionId)
    const exists = await pathExists(journal)
    if (!exists && !create) return undefined
    if (!exists) {
      throw new Error(
        `Session journal ${sessionId} must be created atomically.`,
      )
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
    const physicalRecords = parsePhysicalJournal(
      sessionId,
      content,
      committedBytes,
    )
    const storedEvents = await materializeSessionHistory(
      sessionId,
      physicalRecords,
    )
    const admissions = collectJournalAdmissions(sessionId, storedEvents)
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

  async function materializeSessionHistory(
    sessionId: string,
    physicalRecords: readonly PhysicalEventRecord[],
  ): Promise<StoredEventEnvelope[]> {
    const created = physicalRecords[0]?.event
    if (created === undefined) return []
    if (
      created.sessionId !== sessionId ||
      created.seq !== 1 ||
      created.type !== EventType.SessionCreated ||
      !isKernelEvent(created)
    ) {
      throw invalidEventLog(
        "Session journal must begin with session.created at sequence 1.",
        { sessionId },
      )
    }

    const reference = requireForkReference(sessionId, created)
    let inherited: StoredEventEnvelope[] = []
    if (reference !== undefined) {
      if (!(await pathExists(journalPath(reference.parentSessionId)))) {
        throw invalidEventLog("Forked Session history parent was not found.", {
          sessionId,
          parentSessionId: reference.parentSessionId,
        })
      }
      const segments = await resolveHistorySegments(
        reference.historyBase,
        new Set([sessionId]),
      )
      for (const segment of segments) {
        inherited.push(...(await readHistorySegment(segment)))
      }
      inherited = inherited.map((event) => ({
        ...structuredClone(event),
        sessionId,
      }))
    }

    const events = [
      created,
      ...inherited,
      ...physicalRecords.slice(1).map((record) => record.event),
    ]
    for (const [index, event] of events.entries()) {
      const expectedSeq = index + 1
      if (event.sessionId !== sessionId || event.seq !== expectedSeq) {
        throw invalidEventLog("Session history is not contiguous.", {
          sessionId,
          expectedSeq,
          actualSeq: event.seq,
          eventSessionId: event.sessionId,
        })
      }
    }
    return events
  }

  async function resolveHistorySegments(
    position: SessionHistoryPosition,
    lineage: ReadonlySet<string>,
  ): Promise<HistorySegment[]> {
    if (lineage.has(position.sessionId)) {
      throw invalidEventLog("Session history references contain a cycle.", {
        sessionId: position.sessionId,
      })
    }
    const header = await readSessionHeader(position.sessionId)
    const reference = requireForkReference(position.sessionId, header.created)
    if (
      reference !== undefined &&
      !(await pathExists(journalPath(reference.parentSessionId)))
    ) {
      throw invalidEventLog("Forked Session history parent was not found.", {
        sessionId: position.sessionId,
        parentSessionId: reference.parentSessionId,
      })
    }
    const nextLineage = new Set([...lineage, position.sessionId])
    const segments =
      reference === undefined
        ? []
        : await resolveHistorySegments(reference.historyBase, nextLineage)
    const startSeq = reference?.historyBase.endSeqExclusive ?? 2
    const segment = await validateHistorySegment({
      sessionId: position.sessionId,
      startByteOffset: header.headerBytes,
      endByteOffset: position.endByteOffset,
      startSeq,
      endSeqExclusive: position.endSeqExclusive,
    })
    return segment.startSeq === segment.endSeqExclusive
      ? segments
      : [...segments, segment]
  }

  async function resolveFullHistorySegments(
    sessionId: string,
  ): Promise<HistorySegment[]> {
    const header = await readSessionHeader(sessionId)
    const reference = requireForkReference(sessionId, header.created)
    const inherited =
      reference === undefined
        ? []
        : await resolveHistorySegments(
            reference.historyBase,
            new Set([sessionId]),
          )
    const startSeq = reference?.historyBase.endSeqExclusive ?? 2
    const local = await inspectHistorySegment({
      sessionId,
      startByteOffset: header.headerBytes,
      endByteOffset: header.journalBytes,
      startSeq,
    })
    return local.startSeq === local.endSeqExclusive
      ? inherited
      : [...inherited, local]
  }

  async function findHistoryPosition(
    sourceSessionId: string,
    boundarySeq: number,
  ): Promise<SessionHistoryPosition> {
    const segments = await resolveFullHistorySegments(sourceSessionId)
    const segment = segments.find(
      (candidate) =>
        candidate.startSeq <= boundarySeq &&
        boundarySeq < candidate.endSeqExclusive,
    )
    if (segment === undefined) {
      throw invalidEventLog("Fork history boundary has no physical event.", {
        sessionId: sourceSessionId,
        boundarySeq,
      })
    }
    const records = await readHistorySegmentRecords(segment)
    const boundary = records.find((record) => record.event.seq === boundarySeq)
    if (boundary === undefined || boundary.lineEventIndex !== 0) {
      throw invalidEventLog(
        "Fork history boundary is not a stable journal line boundary.",
        { sessionId: segment.sessionId, boundarySeq },
      )
    }
    return {
      sessionId: segment.sessionId,
      endSeqExclusive: boundarySeq,
      endByteOffset: boundary.lineStart,
    }
  }

  async function readSessionHeader(sessionId: string): Promise<JournalHeader> {
    const journal = journalPath(sessionId)
    const handle = await open(journal, "r").catch((error: unknown) => {
      if (isNotFound(error)) return undefined
      throw error
    })
    if (handle === undefined) {
      throw invalidEventLog("Referenced Session journal was not found.", {
        sessionId,
      })
    }
    try {
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const chunk = Buffer.alloc(4_096)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
        if (bytesRead === 0) {
          throw invalidEventLog("Session journal has no committed header.", {
            sessionId,
          })
        }
        const read = chunk.subarray(0, bytesRead)
        const newline = read.indexOf(0x0a)
        if (newline === -1) {
          chunks.push(read)
          offset += bytesRead
          continue
        }
        chunks.push(read.subarray(0, newline))
        const line = Buffer.concat(chunks).toString("utf8")
        const parsed = parseJournalLine(line, 1)
        if (
          parsed.sessionId !== sessionId ||
          parsed.seq !== 1 ||
          parsed.type !== EventType.SessionCreated ||
          !isKernelEvent(parsed)
        ) {
          throw invalidEventLog(
            "Session journal must begin with session.created at sequence 1.",
            { sessionId },
          )
        }
        return {
          created: parsed,
          headerBytes: offset + newline + 1,
          journalBytes: (await handle.stat()).size,
        }
      }
    } finally {
      await handle.close()
    }
  }

  async function validateHistorySegment(
    segment: HistorySegment,
  ): Promise<HistorySegment> {
    const inspected = await inspectHistorySegment(segment)
    if (inspected.endSeqExclusive !== segment.endSeqExclusive) {
      throw invalidEventLog(
        "Fork history position does not match its sequence.",
        {
          sessionId: segment.sessionId,
          expectedSeq: segment.endSeqExclusive,
          actualSeq: inspected.endSeqExclusive,
        },
      )
    }
    return inspected
  }

  async function inspectHistorySegment(
    segment: Omit<HistorySegment, "endSeqExclusive"> & {
      readonly endSeqExclusive?: number
    },
  ): Promise<HistorySegment> {
    const records = await readHistorySegmentRecords(segment)
    let expectedSeq = segment.startSeq
    for (const record of records) {
      if (
        record.event.sessionId !== segment.sessionId ||
        record.event.seq !== expectedSeq ||
        record.event.type === EventType.SessionCreated
      ) {
        throw invalidEventLog("Referenced history segment is not contiguous.", {
          sessionId: segment.sessionId,
          expectedSeq,
          actualSeq: record.event.seq,
        })
      }
      expectedSeq += 1
    }
    return {
      ...segment,
      endSeqExclusive: expectedSeq,
    }
  }

  async function readHistorySegment(
    segment: HistorySegment,
  ): Promise<StoredEventEnvelope[]> {
    return (await readHistorySegmentRecords(segment)).map(
      (record) => record.event,
    )
  }

  async function readHistorySegmentRecords(
    segment: Pick<
      HistorySegment,
      "sessionId" | "startByteOffset" | "endByteOffset"
    >,
  ): Promise<PhysicalEventRecord[]> {
    const content = await readFile(journalPath(segment.sessionId))
    if (
      segment.startByteOffset < 0 ||
      segment.endByteOffset < segment.startByteOffset ||
      segment.endByteOffset > content.byteLength ||
      (segment.startByteOffset > 0 &&
        content[segment.startByteOffset - 1] !== 0x0a) ||
      (segment.endByteOffset > 0 && content[segment.endByteOffset - 1] !== 0x0a)
    ) {
      throw invalidEventLog("Fork history byte offset is invalid.", {
        sessionId: segment.sessionId,
        startByteOffset: segment.startByteOffset,
        endByteOffset: segment.endByteOffset,
      })
    }
    return parsePhysicalJournal(
      segment.sessionId,
      content,
      segment.endByteOffset,
      segment.startByteOffset,
    )
  }

  async function findHistoryDependent(
    parentSessionId: string,
  ): Promise<string | undefined> {
    return (await historyDependents()).get(parentSessionId)?.[0]
  }

  async function historyDependents(): Promise<Map<string, string[]>> {
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNotFound(error)) return []
        throw error
      },
    )
    const dependents = new Map<string, string[]>()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        assertEventStoreSessionId(entry.name)
      } catch {
        continue
      }
      const first = await readSessionHeader(entry.name)
        .then((header) => header.created)
        .catch((error: unknown) => {
          if (isNotFound(error)) return undefined
          throw error
        })
      if (
        first !== undefined &&
        isKernelEvent(first) &&
        first.type === EventType.SessionCreated &&
        first.data.forkReason !== undefined
      ) {
        const referenced = new Set(
          [
            first.data.parentSessionId,
            first.data.historyBase?.sessionId,
          ].filter((sessionId): sessionId is string => sessionId !== undefined),
        )
        for (const sessionId of referenced) {
          const children = dependents.get(sessionId) ?? []
          children.push(entry.name)
          dependents.set(sessionId, children)
        }
      }
    }
    return dependents
  }

  async function conversationSessions(
    conversationId: string,
  ): Promise<Array<{ sessionId: string; parentSessionId?: string }>> {
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNotFound(error)) return []
        throw error
      },
    )
    const sessions: Array<{ sessionId: string; parentSessionId?: string }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        assertEventStoreSessionId(entry.name)
      } catch {
        continue
      }
      const header = await readSessionHeader(entry.name)
      const created = header.created
      if (
        !isKernelEvent(created) ||
        created.type !== EventType.SessionCreated
      ) {
        continue
      }
      if ((created.data.conversationId ?? entry.name) !== conversationId) {
        continue
      }
      sessions.push({
        sessionId: entry.name,
        ...(created.data.parentSessionId === undefined
          ? {}
          : { parentSessionId: created.data.parentSessionId }),
      })
    }
    return sessions
  }

  async function readPhysicalLifecycle(sessionId: string): Promise<{
    readonly activeTurnId?: string
    readonly pendingInputIds: readonly string[]
  }> {
    const header = await readSessionHeader(sessionId)
    const records = await readHistorySegmentRecords({
      sessionId,
      startByteOffset: header.headerBytes,
      endByteOffset: header.journalBytes,
    })
    const activeTurns = new Set<string>()
    const pendingInputs = new Set<string>()
    for (const { event } of records) {
      if (!isKernelEvent(event)) continue
      if (event.type === EventType.InputAdmitted) {
        pendingInputs.add(event.data.inputId)
        continue
      }
      if (event.type === EventType.InputCancelled) {
        pendingInputs.delete(event.data.inputId)
        continue
      }
      if (event.type === EventType.TurnStarted) {
        activeTurns.add(event.data.turnId)
        pendingInputs.delete(event.data.inputId)
        continue
      }
      if (
        event.type === EventType.TurnCompleted ||
        event.type === EventType.TurnFailed ||
        event.type === EventType.TurnCancelled ||
        event.type === EventType.TurnInterrupted
      ) {
        activeTurns.delete(event.data.turnId)
      }
    }
    const activeTurnId = activeTurns.values().next().value
    return {
      ...(activeTurnId === undefined ? {} : { activeTurnId }),
      pendingInputIds: [...pendingInputs],
    }
  }

  function runForSessions<T>(
    sessionIds: readonly string[],
    task: () => Promise<T>,
    index = 0,
  ): Promise<T> {
    const sessionId = sessionIds[index]
    return sessionId === undefined
      ? task()
      : runForSession(sessionId, () =>
          runForSessions(sessionIds, task, index + 1),
        )
  }

  async function removeSessionDirectory(sessionId: string): Promise<void> {
    await discardLoadedSession(sessionId)
    const summaryJob = summaryJobs.get(sessionId)
    if (summaryJob !== undefined) {
      summaryJobs.delete(sessionId)
      await summaryJob.promise
    }
    await rm(sessionDirectory(sessionId), { recursive: true, force: true })
    unconfirmedSessions.delete(sessionId)
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
  ): Promise<SessionSummary | undefined> {
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
    createSession,
    async appendEvent(sessionId, event, appendOptions = {}) {
      const appended = await appendEvents(sessionId, [event], appendOptions)
      const envelope = appended[0]
      if (envelope === undefined) {
        throw new Error("Single event append returned no event.")
      }
      return envelope
    },
    appendEvents,
    forkSession,
    async readEvents(sessionId: string, input: EventStoreReadEventsInput = {}) {
      assertEventStoreSessionId(sessionId)
      return runStoreOperation(() =>
        runForSession(sessionId, async () => {
          const loaded = await loadSession(sessionId, false)
          if (loaded === undefined) return []
          const after = input.after ?? 0
          const start = Math.min(Math.max(after, 0), loaded.events.length)
          const replayEnd = Math.min(
            input.through ?? loaded.events.length,
            loaded.events.length,
          )
          const end = Math.min(
            replayEnd,
            input.limit === undefined ? replayEnd : start + input.limit,
          )
          return structuredClone(
            end <= start ? [] : loaded.events.slice(start, end),
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
        const summaries: SessionSummary[] = []
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
        return paginateSessionSummaries(
          collapseSessionConversations(summaries),
          input,
        )
      })
    },
    async deleteSession(sessionId: string) {
      assertEventStoreSessionId(sessionId)
      return runStoreOperation(() =>
        runForSession(sessionId, async () => {
          if (!(await pathExists(journalPath(sessionId)))) return
          const dependentSessionId = await findHistoryDependent(sessionId)
          if (dependentSessionId !== undefined) {
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: `Session ${sessionId} cannot be deleted because Session ${dependentSessionId} references its history.`,
              details: { sessionId, dependentSessionId },
            })
          }
          await removeSessionDirectory(sessionId)
          await confirmSessionsDirectoryMutation()
        }),
      )
    },
    async deleteConversation(conversationId: string) {
      assertEventStoreSessionId(conversationId)
      return runStoreOperation(() =>
        runGraphOperation(async () => {
          const sessions = await conversationSessions(conversationId)
          if (sessions.length === 0) return
          const byId = new Map(
            sessions.map((session) => [session.sessionId, session]),
          )
          const depths = new Map<string, number>()
          const depth = (
            sessionId: string,
            lineage: ReadonlySet<string> = new Set(),
          ): number => {
            const cached = depths.get(sessionId)
            if (cached !== undefined) return cached
            if (lineage.has(sessionId)) {
              throw invalidEventLog(
                "Session conversation lineage contains a cycle.",
                { sessionId },
              )
            }
            const parent = byId.get(sessionId)?.parentSessionId
            const value =
              parent === undefined || !byId.has(parent)
                ? 0
                : depth(parent, new Set([...lineage, sessionId])) + 1
            depths.set(sessionId, value)
            return value
          }
          const rootFirst = [...byId.keys()].sort(
            (left, right) => depth(left) - depth(right),
          )
          const lockOrder = [...byId.keys()].sort()
          await runForSessions(lockOrder, async () => {
            const dependents = await historyDependents()
            for (const sessionId of [...rootFirst].reverse()) {
              const dependent = dependents
                .get(sessionId)
                ?.find((candidate) => !byId.has(candidate))
              if (dependent !== undefined && !byId.has(dependent)) {
                throw createYakitoriError({
                  code: YakitoriErrorCode.InvalidState,
                  message: `Session ${sessionId} is referenced outside its conversation.`,
                  details: { sessionId, dependentSessionId: dependent },
                })
              }
            }
            for (const sessionId of lockOrder) {
              const lifecycle = await readPhysicalLifecycle(sessionId)
              if (lifecycle.activeTurnId !== undefined) {
                throw createYakitoriError({
                  code: YakitoriErrorCode.InvalidState,
                  message: `Conversation ${conversationId} contains an active Session ${sessionId}; interrupt it before deleting the conversation.`,
                  details: {
                    conversationId,
                    sessionId,
                    activeTurnId: lifecycle.activeTurnId,
                  },
                })
              }
              if (lifecycle.pendingInputIds.length > 0) {
                throw createYakitoriError({
                  code: YakitoriErrorCode.InvalidState,
                  message: `Conversation ${conversationId} contains queued input in Session ${sessionId}; cancel it before deleting the conversation.`,
                  details: { conversationId, sessionId },
                })
              }
            }
            for (const sessionId of [...rootFirst].reverse()) {
              await removeSessionDirectory(sessionId)
            }
            await confirmSessionsDirectoryMutation()
          })
        }),
      )
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
          if (sessionsDirectoryNeedsSync) await syncDirectory(sessionsDir)
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

function parsePhysicalJournal(
  sessionId: string,
  content: Buffer,
  endByteOffset: number,
  startByteOffset = 0,
): PhysicalEventRecord[] {
  const records: PhysicalEventRecord[] = []
  let lineStart = startByteOffset
  let recordNumber = 1
  while (lineStart < endByteOffset) {
    const newline = content.indexOf(0x0a, lineStart)
    if (newline === -1 || newline + 1 > endByteOffset) {
      throw invalidEventLog("Session journal segment ends inside a record.", {
        sessionId,
        recordNumber,
      })
    }
    const lineEnd = newline + 1
    const parsed = parseJournalRecord(
      content.subarray(lineStart, newline).toString("utf8"),
      recordNumber,
    )
    for (const [lineEventIndex, event] of parsed.entries()) {
      if (event.sessionId !== sessionId) {
        throw invalidEventLog(
          `Session journal record ${recordNumber} belongs to another Session.`,
          {
            sessionId,
            recordNumber,
            recordSessionId: event.sessionId,
          },
        )
      }
      records.push({ event, lineStart, lineEnd, lineEventIndex })
    }
    lineStart = lineEnd
    recordNumber += 1
  }
  return records
}

function requireForkReference(
  sessionId: string,
  created: StoredEventEnvelope & {
    readonly type: typeof EventType.SessionCreated
  },
): ForkReference | undefined {
  if (!isKernelEvent(created)) return undefined
  const { parentSessionId, forkedFromInputId, forkReason } = created.data
  const { historyBase } = created.data
  const hasForkMetadata =
    forkedFromInputId !== undefined ||
    forkReason !== undefined ||
    historyBase !== undefined
  if (!hasForkMetadata) return undefined
  if (
    parentSessionId === undefined ||
    forkedFromInputId === undefined ||
    forkReason === undefined ||
    historyBase === undefined
  ) {
    throw invalidEventLog("Forked Session history reference is incomplete.", {
      sessionId,
    })
  }
  return { parentSessionId, atInputId: forkedFromInputId, historyBase }
}

function collectJournalAdmissions(
  sessionId: string,
  events: readonly StoredEventEnvelope[],
): Map<string, AdmissionRecord> {
  const admissions = new Map<string, AdmissionRecord>()
  for (const event of events) {
    const admission = admissionRecord(event)
    if (admission === undefined) continue
    if (admissions.has(admission.requestId)) {
      throw invalidEventLog(
        `Duplicate admission request ${admission.requestId} in Session journal.`,
        { sessionId, requestId: admission.requestId },
      )
    }
    admissions.set(admission.requestId, admission.record)
  }
  return admissions
}

function requireAdmissionOption(
  sessionId: string,
  events: readonly KernelFact[],
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
  events: readonly StoredEventEnvelope[],
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
    !recorded.every(isKernelFact)
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
