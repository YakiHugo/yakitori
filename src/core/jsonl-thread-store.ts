import { constants } from "node:fs"
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
// Node has no advisory file-lock API; fs-ext supplies the same OS flock
// ownership boundary that Codex uses for cross-process rollout writers.
import { flock } from "fs-ext"
import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import {
  EventType,
  isJsonObject,
  isKernelEvent,
  isModelMessage,
  isModelSelection,
  isSessionConfigurationSnapshot,
  isTokenUsage,
  isTurnMetrics,
} from "../kernel/events.ts"
import { isStorageKey } from "../kernel/ids.ts"
import type {
  HistoryPosition,
  ResponseItemEnvelope,
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadSummary,
} from "./rollout.ts"
import {
  advanceSessionHead,
  type SessionHeads,
  sessionEntries,
} from "./session-navigation.ts"
import {
  changeSessionSidebar,
  compareSectionSessions,
  emptySessionSidebar,
  presentSession,
  type SessionPresentation,
  type SessionSidebar,
  type SidebarChange,
  sectionSessionCursor,
  sessionInView,
  startAfterSectionCursor,
} from "./session-sidebar.ts"
import {
  SqliteThreadSearchProjection,
  type ThreadSearchProjectionStamp,
} from "./sqlite-thread-search-projection.ts"
import {
  SqliteThreadUsageProjection,
  type ThreadUsageSummary,
} from "./sqlite-thread-usage-projection.ts"
import {
  compareThreadSummaries,
  startAfterThreadCursor,
  threadCursor,
} from "./thread-search.ts"
import {
  type CreateForkInput,
  type CreateThreadMetadata,
  PersistContext,
  type PreparedFork,
  type PrepareForkInput,
  type ThreadStore,
  type ThreadStoreForkResult,
  type ThreadStoreListInput,
  type ThreadStoreListResult,
  type ThreadStoreSearchInput,
} from "./thread-store.ts"

type PendingWrite = {
  readonly entry: StoredRolloutItem
  readonly bytes: Buffer
  offset: number
}

type LiveWriter = {
  file: FileHandle
  readonly rolloutId: string
  readonly lock: OwnedFileLock
  readonly pending: PendingWrite[]
  tail: Promise<void>
  shutdownPromise: Promise<void> | undefined
  nextSeq: number
  accepting: boolean
}

type StagedThread = {
  readonly metadata: ThreadMetadata
  readonly lock: OwnedFileLock
  readonly rollout: StoredRolloutItem[]
  materializing: Promise<void> | undefined
  shutdownPromise: Promise<void> | undefined
  sidebar: SessionPresentation | undefined
  pendingDurableAppend:
    | { readonly items: readonly RolloutItem[]; readonly throughSeq: number }
    | undefined
  accepting: boolean
}

type PhysicalRolloutRecord = {
  readonly entry: StoredRolloutItem
  readonly endByteOffset: number
}

type ForkReservation = {
  readonly prepared: PreparedFork
  readonly lock: OwnedFileLock
}

type OwnedFileLock = {
  readonly path: string
  readonly file: FileHandle
  readonly removeOnRelease: boolean
  released: boolean
}

export class JsonlThreadStore implements ThreadStore {
  readonly #searchProjection: SqliteThreadSearchProjection
  readonly #usageProjection: SqliteThreadUsageProjection
  readonly #sessionSidebarPath: string
  readonly #sessionHeadsPath: string
  readonly #threadsDirectory: string
  readonly #rolloutsDirectory: string
  readonly #writerLocksDirectory: string
  readonly #reservationLocksDirectory: string
  readonly #coordinationLockPath: string
  readonly #writers = new Map<string, LiveWriter>()
  readonly #staged = new Map<string, StagedThread>()
  readonly #reservations = new Map<string, ForkReservation>()
  readonly #ephemeralAssetOwners = new Set<string>()
  readonly #ready: Promise<void>
  readonly #searchProjectionErrors = new Map<string, unknown>()
  #searchProjectionDirty = false
  #searchProjectionTail: Promise<void> = Promise.resolve()
  #usageProjectionTail: Promise<void> = Promise.resolve()

  constructor(input: { readonly root: string }) {
    const root = resolve(input.root)
    this.#searchProjection = new SqliteThreadSearchProjection(
      join(root, "thread-search.sqlite"),
    )
    this.#usageProjection = new SqliteThreadUsageProjection(
      join(root, "thread-usage.sqlite"),
    )
    this.#sessionSidebarPath = join(root, "session-sidebar.json")
    this.#sessionHeadsPath = join(root, "session-heads.json")
    this.#threadsDirectory = join(root, "threads")
    this.#rolloutsDirectory = join(root, "rollouts")
    this.#writerLocksDirectory = join(root, "locks", "writers")
    this.#reservationLocksDirectory = join(root, "locks", "reservations")
    this.#coordinationLockPath = join(root, "locks", "storage.lock")
    this.#ready = Promise.all([
      mkdir(this.#threadsDirectory, { recursive: true }),
      mkdir(this.#rolloutsDirectory, { recursive: true }),
      mkdir(this.#writerLocksDirectory, { recursive: true }),
      mkdir(this.#reservationLocksDirectory, { recursive: true }),
    ])
      .then(() => this.#collectUnreferencedRollouts())
      .then(() => this.#synchronizeSearchProjection())
      .then(() => undefined)
  }

  async initialize(): Promise<void> {
    await this.#ready
  }

  // Ephemeral owners (side chats and unsent composer drafts) keep files
  // without a durable thread index. A live host lease protects those files
  // from GC; restart deliberately drops the lease.
  retainEphemeralRolloutAssets(rolloutId: string): () => void {
    requireThreadId(rolloutId)
    if (this.#ephemeralAssetOwners.has(rolloutId))
      throw new Error(`Ephemeral rollout ${rolloutId} already has an owner.`)
    this.#ephemeralAssetOwners.add(rolloutId)
    return () => {
      this.#ephemeralAssetOwners.delete(rolloutId)
    }
  }

  async withRolloutAssetMutation<T>(
    rolloutId: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    await this.#ready
    requireThreadId(rolloutId)
    const coordinationLock = await acquireOwnedLock(
      this.#coordinationLockPath,
      "Thread storage is being updated.",
      false,
      true,
    )
    try {
      if (this.#ephemeralAssetOwners.has(rolloutId)) return await mutate()
      if (this.#staged.has(rolloutId)) {
        const directory = this.#rolloutDirectory(rolloutId)
        if (!(await pathExists(directory))) {
          await mkdir(directory)
          await syncDirectory(this.#rolloutsDirectory)
        }
        return await mutate()
      }
      const metadataFiles = (await readdir(this.#threadsDirectory)).filter(
        (file) => file.endsWith(".json"),
      )
      let owned = false
      for (const file of metadataFiles) {
        try {
          const metadata = await this.#readMetadata(basename(file, ".json"))
          if (metadata.rolloutId === rolloutId) {
            owned = true
            break
          }
        } catch {
          // A corrupt unrelated index cannot grant ownership of this bundle.
        }
      }
      if (!owned) {
        throw createYakitoriError({
          code: YakitoriErrorCode.NotFound,
          message: `Physical rollout ${rolloutId} is not owned by a Thread.`,
          details: { rolloutId },
        })
      }
      const journal = await open(
        this.#rolloutPath(rolloutId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        if (!(await journal.stat()).isFile()) {
          throw new Error(
            `Physical rollout ${rolloutId} has no regular journal.`,
          )
        }
      } finally {
        await journal.close()
      }
      return await mutate()
    } finally {
      await releaseOwnedLock(coordinationLock)
    }
  }

  async createThread(metadata: CreateThreadMetadata): Promise<StoredThread> {
    await this.#ready
    requireThreadId(metadata.id)
    if ("rolloutId" in metadata || "historyBase" in metadata) {
      throw new Error(
        "New Threads cannot provide physical rollout or inherited history.",
      )
    }
    const normalized = normalizeMetadata({
      ...metadata,
      rolloutId: metadata.id,
    })
    if (normalized.parentThreadId !== undefined) {
      await this.#createPhysicalThread(normalized)
      try {
        const stored = await this.#readRequiredThread(normalized.id)
        await this.#withSearchProjection(async () =>
          this.#searchProjection.rebuild(
            stored,
            await this.#searchProjectionStamp(normalized),
          ),
        )
        return stored
      } catch (error) {
        await this.#rollbackCreatedThread(normalized.id)
        throw error
      }
    }
    const lock = await acquireOwnedLock(
      this.#writerLockPath(normalized.id),
      `Thread ${normalized.id} already has an active writer.`,
    )
    try {
      if (
        (await pathExists(this.#metadataPath(normalized.id))) ||
        (await pathExists(this.#rolloutDirectory(normalized.id)))
      ) {
        throw new Error(`Thread ${normalized.id} already exists.`)
      }
      const sessionMeta: StoredRolloutItem = {
        threadId: normalized.id,
        rolloutId: normalized.rolloutId,
        seq: 0,
        createdAt: normalized.createdAt,
        item: { type: "session_meta", metadata: normalized },
      }
      this.#staged.set(normalized.id, {
        metadata: normalized,
        lock,
        rollout: [sessionMeta],
        materializing: undefined,
        shutdownPromise: undefined,
        sidebar: undefined,
        pendingDurableAppend: undefined,
        accepting: true,
      })
      return structuredClone({ metadata: normalized, rollout: [sessionMeta] })
    } catch (error) {
      await releaseOwnedLock(lock)
      throw error
    }
  }

  async resumeThread(threadId: string): Promise<StoredThread | undefined> {
    await this.#ready
    requireThreadId(threadId)
    if (!(await pathExists(this.#metadataPath(threadId)))) return undefined
    if (this.#writers.has(threadId)) {
      throw new Error(`Thread ${threadId} already has a live writer.`)
    }
    await this.#openWriter(threadId, true)
    try {
      return await this.#readRequiredThread(threadId)
    } catch (error) {
      await this.discardThread(threadId)
      throw error
    }
  }

  appendItems(
    threadId: string,
    items: readonly RolloutItem[],
  ): Promise<number> {
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) {
      if (!staged.accepting) throw new Error(`Thread ${threadId} is closing.`)
      if (staged.materializing !== undefined) {
        return staged.materializing.then(() =>
          this.appendItems(threadId, items),
        )
      }
      const copied = structuredClone([...items])
      const pending = staged.pendingDurableAppend
      if (pending !== undefined) {
        const sameBatch =
          JSON.stringify(copied) === JSON.stringify(pending.items)
        staged.materializing = this.#materializeStagedThread(threadId, staged)
        return staged.materializing.then(() =>
          sameBatch ? pending.throughSeq : this.appendItems(threadId, items),
        )
      }
      for (const item of copied) {
        staged.rollout.push({
          threadId,
          rolloutId: staged.metadata.rolloutId,
          seq: staged.rollout.length,
          createdAt: new Date().toISOString(),
          item,
        })
      }
      const throughSeq = staged.rollout.length
      if (
        copied.some(
          ({ type }) => type === "agent_message" || type === "agent_status",
        )
      ) {
        staged.pendingDurableAppend = { items: copied, throughSeq }
        staged.materializing = this.#materializeStagedThread(threadId, staged)
        return staged.materializing.then(() => throughSeq)
      }
      return Promise.resolve(throughSeq)
    }
    const writer = this.#requireWriter(threadId)
    for (const item of structuredClone([...items])) {
      const entry: StoredRolloutItem = {
        threadId,
        rolloutId: writer.rolloutId,
        seq: writer.nextSeq,
        createdAt: new Date().toISOString(),
        item,
      }
      writer.nextSeq += 1
      writer.pending.push({
        entry,
        bytes: Buffer.from(`${JSON.stringify(entry)}\n`),
        offset: 0,
      })
    }
    const endSeqExclusive = writer.nextSeq
    return this.#enqueue(writer, async () => {
      await this.#drain(threadId, writer, endSeqExclusive)
      return endSeqExclusive
    })
  }

  persistThread(threadId: string, context: PersistContext): Promise<void> {
    const staged = this.#staged.get(threadId)
    if (staged !== undefined && context === PersistContext.TurnStart) {
      staged.materializing ??= this.#materializeStagedThread(threadId, staged)
      return staged.materializing
    }
    return this.flushThread(threadId)
  }

  flushThread(threadId: string): Promise<void> {
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) return staged.materializing ?? Promise.resolve()
    const writer = this.#requireWriter(threadId)
    const endSeqExclusive = writer.nextSeq
    return this.#enqueue(writer, async () => {
      await this.#drain(threadId, writer, endSeqExclusive)
      await this.#syncWriter(writer)
    })
  }

  shutdownThread(threadId: string): Promise<void> {
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) {
      if (staged.shutdownPromise !== undefined) return staged.shutdownPromise
      staged.accepting = false
      staged.shutdownPromise =
        staged.materializing !== undefined
          ? staged.materializing.then(
              () => this.shutdownThread(threadId),
              (error: unknown) => {
                staged.shutdownPromise = undefined
                staged.accepting = true
                throw error
              },
            )
          : this.#discardStagedThread(staged).then(
              () => {
                this.#staged.delete(threadId)
              },
              (error: unknown) => {
                staged.shutdownPromise = undefined
                staged.accepting = true
                throw error
              },
            )
      return staged.shutdownPromise
    }
    const writer = this.#writers.get(threadId)
    if (writer === undefined) {
      return Promise.reject(
        new Error(`Thread ${threadId} does not have a live writer.`),
      )
    }
    if (writer.shutdownPromise !== undefined) return writer.shutdownPromise
    writer.accepting = false
    const endSeqExclusive = writer.nextSeq
    writer.shutdownPromise = this.#finishWriterShutdown(
      threadId,
      writer,
      endSeqExclusive,
    )
    return writer.shutdownPromise
  }

  async #finishWriterShutdown(
    threadId: string,
    writer: LiveWriter,
    endSeqExclusive: number,
  ): Promise<void> {
    try {
      await this.#enqueue(writer, async () => {
        await this.#drain(threadId, writer, endSeqExclusive)
        await this.#syncWriter(writer)
      })
    } catch (error) {
      writer.accepting = true
      writer.shutdownPromise = undefined
      throw error
    }
    this.#writers.delete(threadId)
    try {
      await writer.file.close()
    } finally {
      await releaseOwnedLock(writer.lock)
    }
  }

  async discardThread(threadId: string): Promise<void> {
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) {
      if (staged.materializing !== undefined) {
        await staged.materializing
        return this.discardThread(threadId)
      }
      staged.accepting = false
      this.#staged.delete(threadId)
      await this.#discardStagedThread(staged)
      return
    }
    const writer = this.#writers.get(threadId)
    if (writer === undefined) return
    if (writer.shutdownPromise !== undefined) {
      await writer.shutdownPromise
      return
    }
    writer.accepting = false
    this.#writers.delete(threadId)
    await writer.tail.catch(() => undefined)
    try {
      await writer.file.close()
    } finally {
      await releaseOwnedLock(writer.lock)
    }
  }

  async prepareFork(input: PrepareForkInput): Promise<PreparedFork> {
    await this.#ready
    requireThreadId(input.sourceThreadId)
    const staged = this.#staged.get(input.sourceThreadId)
    if (staged !== undefined) {
      // Explicit forks need a physical byte cutoff for inherited history.
      await this.persistThread(input.sourceThreadId, PersistContext.TurnStart)
    }
    const reservationId = `fork_${globalThis.crypto.randomUUID()}`
    const localWriter = this.#writers.get(input.sourceThreadId)
    const coordinationLock =
      localWriter === undefined
        ? await acquireOwnedLock(
            this.#writerLockPath(input.sourceThreadId),
            `Thread ${input.sourceThreadId} already has an active writer.`,
          )
        : undefined
    let reservationLock: OwnedFileLock
    try {
      reservationLock = await acquireOwnedLock(
        this.#reservationLockPath(input.sourceThreadId, reservationId),
        "Fork reservation already exists.",
        true,
      )
    } catch (error) {
      if (coordinationLock !== undefined) {
        await releaseOwnedLock(coordinationLock)
      }
      throw error
    }
    const provisional: PreparedFork = {
      reservationId,
      sourceThreadId: input.sourceThreadId,
      modelContext: [],
    }
    this.#reservations.set(reservationId, {
      prepared: provisional,
      lock: reservationLock,
    })
    try {
      const source =
        localWriter === undefined
          ? await this.#readRequiredThread(input.sourceThreadId)
          : await this.#snapshotForFork(input.sourceThreadId, localWriter)
      const content = source.rollout.filter(
        (entry) => entry.item.type !== "session_meta",
      )
      const boundary = forkBoundaryIndex(content, input)
      if (boundary === -1) throw new Error("Fork boundary was not found.")
      const prefix = content.slice(0, boundary)
      const last = prefix.at(-1)
      const historyPosition =
        last === undefined
          ? undefined
          : await this.#positionAfter(last.rolloutId, last.seq)
      const prepared: PreparedFork = {
        reservationId,
        sourceThreadId: input.sourceThreadId,
        ...(historyPosition === undefined ? {} : { historyPosition }),
        modelContext: modelContextAt(prefix),
      }
      this.#reservations.set(reservationId, {
        prepared,
        lock: reservationLock,
      })
      return prepared
    } catch (error) {
      await releaseOwnedLock(reservationLock)
      this.#reservations.delete(reservationId)
      throw error
    } finally {
      if (coordinationLock !== undefined) {
        await releaseOwnedLock(coordinationLock)
      }
    }
  }

  async createFork(input: CreateForkInput): Promise<ThreadStoreForkResult> {
    await this.#ready
    const reservation = this.#reservations.get(input.prepared.reservationId)
    if (reservation?.prepared !== input.prepared) {
      throw new Error("Fork reservation is not live in this store.")
    }
    const target = structuredClone(input.target)
    if ("rolloutId" in target || "historyBase" in target) {
      throw new Error(
        "Fork targets cannot provide physical rollout or inherited history.",
      )
    }
    const metadata: ThreadMetadata = {
      ...target,
      rolloutId: target.id,
      ...(input.prepared.historyPosition === undefined
        ? {}
        : { historyBase: input.prepared.historyPosition }),
    }
    let created = false
    try {
      await this.#createPhysicalThread(metadata)
      created = true
      await releaseOwnedLock(reservation.lock)
      this.#reservations.delete(input.prepared.reservationId)
      const thread = await this.#readRequiredThread(metadata.id)
      await this.#withSearchProjection(async () =>
        this.#searchProjection.rebuild(
          thread,
          await this.#searchProjectionStamp(metadata),
        ),
      )
      return {
        thread,
        ...(input.prepared.historyPosition === undefined
          ? {}
          : {
              historyEndSeqExclusive:
                input.prepared.historyPosition.endSeqExclusive,
            }),
      }
    } catch (error) {
      if (created) await this.#rollbackCreatedThread(metadata.id)
      throw error
    }
  }

  async releasePreparedFork(prepared: PreparedFork): Promise<void> {
    const reservation = this.#reservations.get(prepared.reservationId)
    if (reservation?.prepared === prepared) {
      await releaseOwnedLock(reservation.lock)
      this.#reservations.delete(prepared.reservationId)
    }
  }

  async readThread(threadId: string): Promise<StoredThread | undefined> {
    await this.#ready
    requireThreadId(threadId)
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) {
      if (staged.materializing !== undefined) await staged.materializing
      else {
        // A rejected durable append remains in the retry buffer, but its
        // entire batch is an unpublished suffix of the staged rollout.
        const pending = staged.pendingDurableAppend
        const visibleThrough =
          pending === undefined
            ? staged.rollout.length
            : pending.throughSeq - pending.items.length
        return structuredClone({
          metadata: staged.metadata,
          rollout: staged.rollout.filter(
            ({ item, seq }) =>
              seq < visibleThrough &&
              item.type !== "response_item" &&
              item.type !== "turn_context" &&
              item.type !== "turn_started",
          ),
        })
      }
    }
    if (!(await pathExists(this.#metadataPath(threadId)))) return undefined
    return this.#readRequiredThread(threadId)
  }

  async listThreadIds(): Promise<readonly string[]> {
    await this.#ready
    return (await readdir(this.#threadsDirectory))
      .filter((file) => file.endsWith(".json"))
      .map((file) => basename(file, ".json"))
      .filter(isStorageKey)
      .sort()
  }

  async listThreads(
    input: ThreadStoreListInput = {},
  ): Promise<ThreadStoreListResult> {
    await this.#ready
    const summaries = await this.#threadSummaries()
    const sidebar =
      input.view === "sessions"
        ? await this.readSessionSidebar()
        : emptySessionSidebar()
    const entries =
      input.view === "sessions"
        ? sessionEntries(summaries, await this.#readSessionHeads())
            .map((entry) => presentSession(entry, sidebar))
            .filter((entry) => sessionInView(entry, input))
        : summaries
    const ordered =
      input.view === "sessions" && typeof input.sectionId === "string"
    const matching = entries
      .filter(
        (thread) =>
          (input.workingDirectory === undefined ||
            thread.workingDirectory === input.workingDirectory) &&
          (input.projectId === undefined ||
            thread.projectId === input.projectId),
      )
      .sort(ordered ? compareSectionSessions : compareThreadSummaries)
    const start = ordered
      ? startAfterSectionCursor(matching, input.cursor)
      : startAfterThreadCursor(matching, input.cursor)
    const limit = input.limit ?? 50
    const threads = matching.slice(start, start + limit)
    const last = threads.at(-1)
    return {
      threads: structuredClone(threads),
      ...(last !== undefined && start + limit < matching.length
        ? {
            nextCursor: ordered
              ? sectionSessionCursor(last)
              : threadCursor(last),
          }
        : {}),
    }
  }

  async #threadSummaries(): Promise<ThreadSummary[]> {
    const files = await readdir(this.#threadsDirectory)
    return this.#withSearchProjection(async () => {
      const summaries = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file): Promise<ThreadSummary | undefined> => {
            const threadId = basename(file, ".json")
            try {
              const metadata = await this.#readMetadata(threadId)
              const stamp = await this.#searchProjectionStamp(metadata)
              if (!this.#searchProjection.isCurrent(threadId, stamp)) {
                this.#searchProjection.rebuild(
                  await this.#readRequiredThread(threadId),
                  stamp,
                )
              }
              return this.#searchProjection.readSummary(threadId)
            } catch {
              // One damaged index entry cannot make every healthy Thread unlistable.
              return undefined
            }
          }),
      )
      return summaries.filter(
        (summary): summary is ThreadSummary => summary !== undefined,
      )
    })
  }

  async #navigationMetadata(): Promise<ThreadMetadata[]> {
    const files = await readdir(this.#threadsDirectory)
    const entries = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            return await this.#readMetadata(basename(file, ".json"))
          } catch (error) {
            // A thread may be deleted between directory enumeration and its read.
            if (isRecord(error) && error.code === "ENOENT") return undefined
            throw error
          }
        }),
    )
    return entries.filter(
      (entry): entry is ThreadMetadata => entry !== undefined,
    )
  }

  async #readSessionHeads(): Promise<SessionHeads> {
    let contents: string
    try {
      contents = await readFile(this.#sessionHeadsPath, "utf8")
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return {}
      throw error
    }
    const value: unknown = JSON.parse(contents)
    if (
      !isRecord(value) ||
      !Object.entries(value).every(
        ([key, head]) =>
          isStorageKey(key) && typeof head === "string" && isStorageKey(head),
      )
    ) {
      throw new Error("Invalid session navigation state.")
    }
    return value as SessionHeads
  }

  async readSessionSidebar(): Promise<SessionSidebar> {
    await this.#ready
    const state = await this.#readDurableSessionSidebar()
    return {
      ...state,
      entries: {
        ...state.entries,
        ...Object.fromEntries(
          [...this.#staged].flatMap(([id, staged]) =>
            staged.sidebar === undefined ? [] : [[id, staged.sidebar]],
          ),
        ),
      },
    }
  }

  async #readDurableSessionSidebar(): Promise<SessionSidebar> {
    try {
      // Canonical UI state is separate from the disposable search projection.
      const value: unknown = JSON.parse(
        await readFile(this.#sessionSidebarPath, "utf8"),
      )
      if (
        !isRecord(value) ||
        !Array.isArray(value.sections) ||
        !isRecord(value.entries) ||
        !value.sections.every(
          (section) =>
            isRecord(section) &&
            typeof section.id === "string" &&
            typeof section.name === "string",
        ) ||
        !Object.values(value.entries).every(
          (entry) =>
            isRecord(entry) &&
            (entry.title === undefined || typeof entry.title === "string") &&
            (entry.archived === undefined ||
              typeof entry.archived === "boolean") &&
            (entry.sectionId === undefined ||
              typeof entry.sectionId === "string") &&
            (entry.sectionPosition === undefined ||
              (typeof entry.sectionPosition === "number" &&
                Number.isSafeInteger(entry.sectionPosition))) &&
            (entry.goal === undefined || typeof entry.goal === "string"),
        )
      ) {
        throw new Error("Invalid session sidebar state.")
      }
      return value as SessionSidebar
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT")
        return emptySessionSidebar()
      throw error
    }
  }

  async sessionPresentation(
    threadId: string,
  ): Promise<SessionPresentation & { navigationId?: string }> {
    await this.#ready
    const entries = sessionEntries(
      [
        ...(await this.#navigationMetadata()),
        ...[...this.#staged.values()].map(({ metadata }) => metadata),
      ],
      await this.#readSessionHeads(),
    )
    const session = entries.find((entry) => entry.id === threadId)
    if (!session) return {}
    const state = await this.readSessionSidebar()
    return {
      navigationId: session.navigationId,
      ...state.entries[session.navigationId],
    }
  }

  async updateSessionSidebar(change: SidebarChange): Promise<SessionSidebar> {
    await this.#ready
    if ("sessionId" in change) {
      await this.#staged.get(change.sessionId)?.materializing
    }
    const lock = await acquireOwnedLock(
      this.#coordinationLockPath,
      "Sidebar is being updated.",
      false,
      true,
    )
    try {
      const metadata = await this.#navigationMetadata()
      const sessions = sessionEntries(
        [
          ...metadata,
          ...[...this.#staged.values()]
            .filter(
              ({ metadata: staged }) =>
                !metadata.some(({ id }) => id === staged.id),
            )
            .map(({ metadata }) => metadata),
        ],
        await this.#readSessionHeads(),
      )
      const durable = await this.#readDurableSessionSidebar()
      const state = changeSessionSidebar(
        await this.readSessionSidebar(),
        change,
        sessions,
      )
      const stagedIds = new Set(this.#staged.keys())
      const persisted: SessionSidebar = {
        sections: state.sections,
        entries: Object.fromEntries(
          Object.entries(state.entries).filter(([id]) => !stagedIds.has(id)),
        ),
      }
      if (JSON.stringify(persisted) !== JSON.stringify(durable)) {
        await atomicWrite(this.#sessionSidebarPath, JSON.stringify(persisted))
      }
      for (const [id, staged] of this.#staged) {
        staged.sidebar = state.entries[id]
      }
      return state
    } finally {
      await releaseOwnedLock(lock)
    }
  }

  async setSessionHead(
    sourceThreadId: string,
    targetThreadId: string,
  ): Promise<void> {
    await this.#ready
    const lock = await acquireOwnedLock(
      this.#coordinationLockPath,
      "Session navigation is being updated.",
      false,
      true,
    )
    try {
      const heads = advanceSessionHead(
        await this.#navigationMetadata(),
        await this.#readSessionHeads(),
        sourceThreadId,
        targetThreadId,
      )
      await atomicWrite(this.#sessionHeadsPath, JSON.stringify(heads))
    } finally {
      await releaseOwnedLock(lock)
    }
  }

  async searchThreads(input: ThreadStoreSearchInput) {
    await this.#ready
    const sidebar =
      input.view === "sessions"
        ? await this.readSessionSidebar()
        : emptySessionSidebar()
    const entries =
      input.view === "sessions"
        ? sessionEntries(
            await this.#navigationMetadata(),
            await this.#readSessionHeads(),
          )
            .map((entry) => presentSession(entry, sidebar))
            .filter((entry) => sessionInView(entry, input))
        : undefined
    return this.#withSearchProjection(async () => {
      await this.#repairSearchProjection()
      const result = this.#searchProjection.searchThreads({
        ...input,
        ...(entries === undefined
          ? {}
          : {
              threadIds: entries.map((entry) => entry.id),
              titles: Object.fromEntries(
                entries.flatMap((entry) =>
                  entry.title === undefined ? [] : [[entry.id, entry.title]],
                ),
              ),
            }),
      })
      const navigationIds = new Map(
        entries?.map((entry) => [entry.id, entry.navigationId]),
      )
      const unavailableThreadCount =
        entries === undefined
          ? this.#searchProjectionErrors.size
          : entries.filter((entry) =>
              this.#searchProjectionErrors.has(entry.id),
            ).length
      return {
        ...result,
        ...(unavailableThreadCount === 0 ? {} : { unavailableThreadCount }),
        matches: result.matches.map((match) => {
          const navigationId = navigationIds.get(match.summary.id)
          return {
            ...match,
            summary: {
              ...match.summary,
              ...(navigationId === undefined
                ? {}
                : sidebar.entries[navigationId]),
              ...(navigationId === undefined ? {} : { navigationId }),
            },
          }
        }),
      }
    })
  }

  async searchThreadOccurrences(input: {
    readonly threadId: string
    readonly searchTerm: string
    readonly cursor?: string
    readonly limit: number
  }) {
    await this.#ready
    return this.#withSearchProjection(async () => {
      await this.#repairSearchProjection()
      if (this.#searchProjectionErrors.has(input.threadId)) {
        throw new Error(`Cannot search unreadable Thread ${input.threadId}.`, {
          cause: this.#searchProjectionErrors.get(input.threadId),
        })
      }
      return this.#searchProjection.searchThreadOccurrences(input)
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.#ready
    requireThreadId(threadId)
    const staged = this.#staged.get(threadId)
    if (staged !== undefined) {
      if (staged.materializing !== undefined) await staged.materializing
      else {
        await this.discardThread(threadId)
        return
      }
    }
    if (this.#writers.has(threadId)) {
      throw new Error(`Thread ${threadId} still has a live writer.`)
    }
    const lock = await acquireOwnedLock(
      this.#writerLockPath(threadId),
      `Thread ${threadId} still has a live writer.`,
    )
    let coordinationLock: OwnedFileLock | undefined
    try {
      coordinationLock = await acquireOwnedLock(
        this.#coordinationLockPath,
        "Thread storage is being updated.",
        false,
        true,
      )
      if (
        [...this.#reservations.values()].some(
          ({ prepared }) => prepared.sourceThreadId === threadId,
        ) ||
        (await this.#hasLiveReservation(threadId))
      ) {
        throw new Error(`Thread ${threadId} has an active fork reservation.`)
      }
      await durableRemove(this.#metadataPath(threadId))
    } finally {
      try {
        if (coordinationLock !== undefined) {
          await releaseOwnedLock(coordinationLock)
        }
      } finally {
        await releaseOwnedLock(lock)
      }
    }
    await this.#withSearchProjection(() => {
      try {
        this.#searchProjection.delete(threadId)
      } catch {
        this.#searchProjectionDirty = true
      }
    })
    await this.#withUsageProjection(() =>
      this.#usageProjection.delete(threadId),
    )
    await this.#collectUnreferencedRollouts()
  }

  async #materializeStagedThread(
    threadId: string,
    staged: StagedThread,
  ): Promise<void> {
    try {
      await this.#createPhysicalThread(
        staged.metadata,
        staged.rollout,
        staged.lock,
      )
      this.#staged.delete(threadId)
      await this.#withSearchProjection(async () => {
        try {
          this.#searchProjection.rebuild(
            await this.#readRequiredThread(threadId),
            await this.#searchProjectionStamp(staged.metadata),
          )
        } catch {
          this.#searchProjectionDirty = true
        }
      })
    } catch (error) {
      staged.materializing = undefined
      throw error
    }
  }

  async #discardStagedThread(staged: StagedThread): Promise<void> {
    try {
      const lock = await acquireOwnedLock(
        this.#coordinationLockPath,
        "Thread storage is being updated.",
        false,
        true,
      )
      try {
        await durableRemoveTree(
          this.#rolloutDirectory(staged.metadata.rolloutId),
        )
      } finally {
        await releaseOwnedLock(lock)
      }
    } finally {
      await releaseOwnedLock(staged.lock)
    }
  }

  async #createPhysicalThread(
    metadata: ThreadMetadata,
    initialRollout?: readonly StoredRolloutItem[],
    stagedLock?: OwnedFileLock,
  ): Promise<void> {
    const normalized = normalizeMetadata(metadata)
    requireThreadId(normalized.id)
    if (
      this.#writers.has(normalized.id) ||
      (stagedLock === undefined && this.#staged.has(normalized.id))
    ) {
      throw new Error(`Thread ${normalized.id} already has a live writer.`)
    }
    const writerLock =
      stagedLock ??
      (await acquireOwnedLock(
        this.#writerLockPath(normalized.id),
        `Thread ${normalized.id} already has an active writer.`,
      ))
    const rolloutId = normalized.rolloutId
    const rolloutDirectory = this.#rolloutDirectory(rolloutId)
    const rolloutPath = this.#rolloutPath(rolloutId)
    const metadataPath = this.#metadataPath(normalized.id)
    const sessionMeta: StoredRolloutItem = {
      threadId: normalized.id,
      rolloutId,
      seq: 0,
      createdAt: normalized.createdAt,
      item: { type: "session_meta", metadata: normalized },
    }
    let lockTransferred = false
    let ownsCreationPaths = false
    let hadAssetDirectory = false
    let coordinationLock: OwnedFileLock | undefined
    let priorSidebar: SessionSidebar | undefined
    let hadSidebarFile = false
    let sidebarWriteAttempted = false
    try {
      coordinationLock = await acquireOwnedLock(
        this.#coordinationLockPath,
        "Thread storage is being updated.",
        false,
        true,
      )
      if (
        (await pathExists(metadataPath)) ||
        (await pathExists(rolloutPath)) ||
        (stagedLock === undefined && (await pathExists(rolloutDirectory)))
      ) {
        throw new Error(`Thread ${normalized.id} already exists.`)
      }
      hadAssetDirectory = await pathExists(rolloutDirectory)
      ownsCreationPaths = true
      if (!hadAssetDirectory) {
        await mkdir(rolloutDirectory)
        await syncDirectory(this.#rolloutsDirectory)
      }
      await atomicWrite(
        rolloutPath,
        `${(initialRollout ?? [sessionMeta]).map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      )
      await atomicWrite(metadataPath, `${JSON.stringify(normalized)}\n`)
      const sidebar =
        stagedLock === undefined
          ? undefined
          : this.#staged.get(normalized.id)?.sidebar
      if (sidebar !== undefined) {
        hadSidebarFile = await pathExists(this.#sessionSidebarPath)
        priorSidebar = await this.#readDurableSessionSidebar()
        sidebarWriteAttempted = true
        await atomicWrite(
          this.#sessionSidebarPath,
          JSON.stringify({
            ...priorSidebar,
            entries: { ...priorSidebar.entries, [normalized.id]: sidebar },
          }),
        )
      }
      await this.#openClaimedWriter(normalized, false, writerLock)
      lockTransferred = true
    } catch (error) {
      if (sidebarWriteAttempted && priorSidebar !== undefined) {
        if (hadSidebarFile)
          await atomicWrite(
            this.#sessionSidebarPath,
            JSON.stringify(priorSidebar),
          )
        else await durableRemove(this.#sessionSidebarPath)
      }
      // atomicWrite can publish its final path before a directory fsync fails.
      // Both names were absent under the storage lock, so unconditional rollback
      // cannot remove another creator's state.
      if (ownsCreationPaths) {
        await durableRemove(metadataPath)
        if (!hadAssetDirectory) await durableRemoveTree(rolloutDirectory)
        else await durableRemove(rolloutPath)
      }
      throw error
    } finally {
      if (coordinationLock !== undefined) {
        await releaseOwnedLock(coordinationLock)
      }
      if (!lockTransferred && stagedLock === undefined)
        await releaseOwnedLock(writerLock)
    }
  }

  async #openWriter(threadId: string, repairTrailingLine: boolean) {
    const metadata = await this.#readMetadata(threadId)
    const writerLock = await acquireOwnedLock(
      this.#writerLockPath(threadId),
      `Thread ${threadId} already has an active writer.`,
    )
    let lockTransferred = false
    try {
      await this.#openClaimedWriter(metadata, repairTrailingLine, writerLock)
      lockTransferred = true
    } finally {
      if (!lockTransferred) await releaseOwnedLock(writerLock)
    }
  }

  async #openClaimedWriter(
    metadata: ThreadMetadata,
    repairTrailingLine: boolean,
    writerLock: OwnedFileLock,
  ) {
    const threadId = metadata.id
    const rolloutId = metadata.rolloutId
    const rolloutPath = this.#rolloutPath(rolloutId)
    if (repairTrailingLine) await repairTrailingJsonLine(rolloutPath)
    const entries = await readPhysicalRollout(rolloutPath, {
      threadId,
      rolloutId,
    })
    const lastLocal = entries
      .filter((entry) => entry.item.type !== "session_meta")
      .at(-1)
    const nextSeq =
      (lastLocal === undefined ? undefined : lastLocal.seq + 1) ??
      metadata.historyBase?.endSeqExclusive ??
      1
    const file = await open(rolloutPath, constants.O_APPEND | constants.O_RDWR)
    this.#writers.set(threadId, {
      file,
      rolloutId,
      lock: writerLock,
      pending: [],
      tail: Promise.resolve(),
      shutdownPromise: undefined,
      nextSeq,
      accepting: true,
    })
  }

  async #drain(
    threadId: string,
    writer: LiveWriter,
    endSeqExclusive: number,
  ): Promise<void> {
    const drained: StoredRolloutItem[] = []
    while (writer.pending.length > 0) {
      const pending = writer.pending[0]
      if (pending === undefined) break
      if (pending.entry.seq >= endSeqExclusive) break
      while (pending.offset < pending.bytes.length) {
        const result = await this.#writePending(writer, pending)
        if (result.bytesWritten === 0) {
          throw new Error("Rollout writer made no forward progress.")
        }
        pending.offset += result.bytesWritten
      }
      writer.pending.shift()
      drained.push(pending.entry)
    }
    await this.#touchMetadata(threadId)
    await this.#withSearchProjection(async () => {
      if (this.#searchProjectionDirty) return
      try {
        const metadata = await this.#readMetadata(threadId)
        this.#searchProjection.append(
          metadata,
          drained,
          await this.#searchProjectionStamp(metadata),
        )
      } catch {
        // Search is a rebuildable projection. A later search repairs it and
        // surfaces any canonical rollout read failure instead of omitting it.
        this.#searchProjectionDirty = true
      }
    })
  }

  async #writePending(writer: LiveWriter, pending: PendingWrite) {
    try {
      return await writer.file.write(
        pending.bytes,
        pending.offset,
        pending.bytes.length - pending.offset,
      )
    } catch {
      const committed = await this.#recoverWriterAfterWriteError(
        writer,
        pending,
      )
      if (committed) {
        return {
          bytesWritten: pending.bytes.length - pending.offset,
          buffer: pending.bytes,
        }
      }
      return writer.file.write(
        pending.bytes,
        pending.offset,
        pending.bytes.length - pending.offset,
      )
    }
  }

  async #syncWriter(writer: LiveWriter): Promise<void> {
    try {
      await writer.file.sync()
    } catch {
      await this.#reopenWriterFile(writer)
      await writer.file.sync()
    }
  }

  async #reopenWriterFile(writer: LiveWriter): Promise<void> {
    await writer.file.close().catch(() => undefined)
    writer.file = await open(
      this.#rolloutPath(writer.rolloutId),
      constants.O_APPEND | constants.O_RDWR,
    )
  }

  async #recoverWriterAfterWriteError(
    writer: LiveWriter,
    pending: PendingWrite,
  ): Promise<boolean> {
    await writer.file.close().catch(() => undefined)
    const rolloutPath = this.#rolloutPath(writer.rolloutId)
    const committed = await reconcilePendingTail(rolloutPath, pending)
    if (!committed) pending.offset = 0
    writer.file = await open(rolloutPath, constants.O_APPEND | constants.O_RDWR)
    return committed
  }

  #enqueue<T>(writer: LiveWriter, operation: () => Promise<T>): Promise<T> {
    const result = writer.tail.then(operation)
    writer.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #touchMetadata(threadId: string): Promise<void> {
    try {
      const metadata = await this.#readMetadata(threadId)
      await atomicWrite(
        this.#metadataPath(threadId),
        `${JSON.stringify({
          ...metadata,
          updatedAt: new Date().toISOString(),
        })}\n`,
      )
    } catch {
      // Rollout durability is authoritative; summary projection is repairable.
    }
  }

  async #readRequiredThread(threadId: string): Promise<StoredThread> {
    const metadata = await this.#readMetadata(threadId)
    const rollout = await this.#materialize(metadata.rolloutId, new Set())
    return { metadata, rollout }
  }

  async #materialize(
    rolloutId: string,
    seen: Set<string>,
  ): Promise<readonly StoredRolloutItem[]> {
    if (seen.has(rolloutId)) throw new Error("Thread history contains a cycle.")
    seen.add(rolloutId)
    try {
      const local = await readPhysicalRollout(this.#rolloutPath(rolloutId), {
        rolloutId,
      })
      const sessionMeta = local[0]
      if (sessionMeta?.item.type !== "session_meta") {
        throw new Error(`Rollout ${rolloutId} has no Session metadata item.`)
      }
      const historyBase = sessionMeta.item.metadata.historyBase
      const inherited =
        historyBase === undefined
          ? []
          : await this.#materializePrefix(historyBase, seen)
      return [sessionMeta, ...inherited, ...local.slice(1)]
    } finally {
      seen.delete(rolloutId)
    }
  }

  async #materializePrefix(
    position: HistoryPosition,
    seen: Set<string>,
  ): Promise<readonly StoredRolloutItem[]> {
    await this.#validateHistoryPosition(position)
    const history = await this.#materialize(position.rolloutId, seen)
    return history.filter(
      (entry) =>
        entry.item.type !== "session_meta" &&
        entry.seq < position.endSeqExclusive,
    )
  }

  async #snapshotForFork(
    threadId: string,
    writer: LiveWriter,
  ): Promise<StoredThread> {
    if (!writer.accepting) throw new Error(`Thread ${threadId} is closing.`)
    const endSeqExclusive = writer.nextSeq
    return this.#enqueue(writer, async () => {
      await this.#drain(threadId, writer, endSeqExclusive)
      await this.#syncWriter(writer)
      return this.#readRequiredThread(threadId)
    })
  }

  async #positionAfter(
    rolloutId: string,
    seq: number,
  ): Promise<HistoryPosition> {
    const record = (
      await readRolloutRecords(this.#rolloutPath(rolloutId))
    ).find((candidate) => candidate.entry.seq === seq)
    if (record === undefined || record.entry.rolloutId !== rolloutId) {
      throw new Error("Fork boundary is outside its physical rollout.")
    }
    return {
      rolloutId,
      endSeqExclusive: seq + 1,
      endByteOffset: record.endByteOffset,
    }
  }

  async #validateHistoryPosition(position: HistoryPosition): Promise<void> {
    const record = (
      await readRolloutRecords(this.#rolloutPath(position.rolloutId))
    ).find(
      (candidate) =>
        candidate.entry.rolloutId === position.rolloutId &&
        candidate.entry.seq + 1 === position.endSeqExclusive,
    )
    if (record?.endByteOffset !== position.endByteOffset) {
      throw new Error("Thread history contains an invalid cutoff position.")
    }
  }

  async #readMetadata(threadId: string): Promise<ThreadMetadata> {
    const value: unknown = JSON.parse(
      await readFile(this.#metadataPath(threadId), "utf8"),
    )
    if (!isThreadMetadata(value) || value.id !== threadId) {
      throw new Error(`Thread ${threadId} has invalid metadata.`)
    }
    return value
  }

  async #rollbackCreatedThread(threadId: string): Promise<void> {
    const writer = this.#writers.get(threadId)
    const metadata = await this.#readMetadata(threadId).catch(() => undefined)
    if (writer !== undefined) {
      writer.accepting = false
      await writer.tail.catch(() => undefined)
    }
    const coordinationLock = await acquireOwnedLock(
      this.#coordinationLockPath,
      "Thread storage is being updated.",
      false,
      true,
    )
    try {
      await durableRemove(this.#metadataPath(threadId))
      await durableRemoveTree(
        this.#rolloutDirectory(
          writer?.rolloutId ?? metadata?.rolloutId ?? threadId,
        ),
      )
    } finally {
      await releaseOwnedLock(coordinationLock)
      if (writer !== undefined) {
        this.#writers.delete(threadId)
        try {
          await writer.file.close()
        } finally {
          await releaseOwnedLock(writer.lock)
        }
      }
    }
    await this.#withSearchProjection(() => {
      this.#searchProjection.delete(threadId)
    })
    await this.#withUsageProjection(() =>
      this.#usageProjection.delete(threadId),
    )
  }

  async #synchronizeSearchProjection(): Promise<void> {
    const threadIds = new Set(
      (await readdir(this.#threadsDirectory))
        .filter((file) => file.endsWith(".json"))
        .map((file) => basename(file, ".json"))
        .filter(isStorageKey),
    )
    this.#searchProjectionErrors.clear()
    for (const threadId of threadIds) {
      try {
        const metadata = await this.#readMetadata(threadId)
        const stamp = await this.#searchProjectionStamp(metadata)
        if (this.#searchProjection.isCurrent(threadId, stamp)) continue
        this.#searchProjection.rebuild(
          await this.#readRequiredThread(threadId),
          stamp,
        )
      } catch (error) {
        this.#searchProjection.delete(threadId)
        this.#searchProjectionErrors.set(threadId, error)
      }
    }
    for (const indexedThreadId of this.#searchProjection.indexedThreadIds()) {
      if (!threadIds.has(indexedThreadId)) {
        this.#searchProjection.delete(indexedThreadId)
      }
    }
    this.#searchProjectionDirty = this.#searchProjectionErrors.size > 0
  }

  async #repairSearchProjection(): Promise<void> {
    // A retained invalid rollout must not disable search of healthy histories.
    // Callers report unavailable sessions or fail only the requested Thread.
    if (this.#searchProjectionDirty) await this.#synchronizeSearchProjection()
  }

  // Usage is a rebuildable projection synchronized lazily on read: threads
  // whose rollout files changed since the last read are rebuilt in full.
  async readUsageSummary(): Promise<ThreadUsageSummary> {
    await this.#ready
    return this.#withUsageProjection(async () => {
      await this.#synchronizeUsageProjection()
      return this.#usageProjection.readUsage()
    })
  }

  async #synchronizeUsageProjection(): Promise<void> {
    const threadIds = new Set(
      (await readdir(this.#threadsDirectory))
        .filter((file) => file.endsWith(".json"))
        .map((file) => basename(file, ".json"))
        .filter(isStorageKey),
    )
    for (const threadId of threadIds) {
      try {
        const metadata = await this.#readMetadata(threadId)
        const stamp = await this.#searchProjectionStamp(metadata)
        if (this.#usageProjection.isCurrent(threadId, stamp)) continue
        this.#usageProjection.rebuild(
          await this.#readRequiredThread(threadId),
          stamp,
        )
      } catch {
        // A retained invalid rollout drops out of the usage summary, matching
        // the search projection's isolation of corrupt histories.
        this.#usageProjection.delete(threadId)
      }
    }
    for (const indexedThreadId of this.#usageProjection.indexedThreadIds()) {
      if (!threadIds.has(indexedThreadId)) {
        this.#usageProjection.delete(indexedThreadId)
      }
    }
  }

  #withUsageProjection<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#usageProjectionTail.then(operation)
    this.#usageProjectionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #searchProjectionStamp(
    metadata: ThreadMetadata,
  ): Promise<ThreadSearchProjectionStamp> {
    const [metadataStat, rolloutStat] = await Promise.all([
      stat(this.#metadataPath(metadata.id)),
      stat(this.#rolloutPath(metadata.rolloutId)),
    ])
    return {
      metadataSize: metadataStat.size,
      metadataMtimeMs: metadataStat.mtimeMs,
      rolloutSize: rolloutStat.size,
      rolloutMtimeMs: rolloutStat.mtimeMs,
    }
  }

  #withSearchProjection<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#searchProjectionTail.then(operation)
    this.#searchProjectionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #collectUnreferencedRollouts(): Promise<void> {
    const coordinationLock = await acquireOwnedLock(
      this.#coordinationLockPath,
      "Thread storage is being updated.",
      false,
      true,
    )
    try {
      await this.#collectUnreferencedRolloutsLocked()
    } finally {
      await releaseOwnedLock(coordinationLock)
    }
  }

  async #collectUnreferencedRolloutsLocked(): Promise<void> {
    if (
      (await hasAnyLiveLock(this.#writerLocksDirectory)) ||
      (await hasAnyLiveLock(this.#reservationLocksDirectory))
    ) {
      return
    }
    const metadataFiles = (await readdir(this.#threadsDirectory)).filter(
      (file) => file.endsWith(".json"),
    )
    const metadata: ThreadMetadata[] = []
    for (const file of metadataFiles) {
      try {
        metadata.push(await this.#readMetadata(basename(file, ".json")))
      } catch {
        // A corrupt index may still be the only owner of a rollout. Skip GC
        // conservatively while allowing healthy Threads to remain available.
        return
      }
    }
    const retained = new Set(metadata.map((thread) => thread.rolloutId))
    const pending: string[] = [...retained]
    for (const thread of metadata) {
      if (thread.historyBase !== undefined) {
        if (!retained.has(thread.historyBase.rolloutId)) {
          retained.add(thread.historyBase.rolloutId)
          pending.push(thread.historyBase.rolloutId)
        }
      }
    }
    for (const { prepared } of this.#reservations.values()) {
      if (prepared.historyPosition !== undefined) {
        if (!retained.has(prepared.historyPosition.rolloutId)) {
          retained.add(prepared.historyPosition.rolloutId)
          pending.push(prepared.historyPosition.rolloutId)
        }
      }
    }
    for (let index = 0; index < pending.length; index += 1) {
      const rolloutId = pending[index]
      if (rolloutId === undefined) continue
      const path = this.#rolloutPath(rolloutId)
      if (!(await pathExists(path))) continue
      let sessionMeta: StoredRolloutItem | undefined
      try {
        sessionMeta = (await readPhysicalRollout(path, { rolloutId }))[0]
      } catch {
        // If retained lineage is unreadable, ownership cannot be proven. Abort
        // collection without making healthy Threads unavailable.
        return
      }
      if (sessionMeta?.item.type !== "session_meta") continue
      const base = sessionMeta.item.metadata.historyBase
      if (base !== undefined && !retained.has(base.rolloutId)) {
        retained.add(base.rolloutId)
        pending.push(base.rolloutId)
      }
    }
    const rolloutDirectories = await readdir(this.#rolloutsDirectory, {
      withFileTypes: true,
    })
    const unreferenced = rolloutDirectories
      .filter((entry) => entry.isDirectory() && isStorageKey(entry.name))
      .map((entry) => entry.name)
      .filter(
        (rolloutId) =>
          !retained.has(rolloutId) &&
          !this.#ephemeralAssetOwners.has(rolloutId),
      )
    await Promise.all(
      unreferenced.map((rolloutId) =>
        rm(join(this.#rolloutsDirectory, rolloutId), {
          recursive: true,
          force: true,
        }),
      ),
    )
    if (unreferenced.length > 0) await syncDirectory(this.#rolloutsDirectory)
  }

  #requireWriter(threadId: string): LiveWriter {
    const writer = this.#writers.get(threadId)
    if (writer === undefined) {
      throw new Error(`Thread ${threadId} does not have a live writer.`)
    }
    if (!writer.accepting) throw new Error(`Thread ${threadId} is closing.`)
    return writer
  }

  #metadataPath(threadId: string): string {
    return join(this.#threadsDirectory, `${threadId}.json`)
  }

  #rolloutDirectory(rolloutId: string): string {
    return join(this.#rolloutsDirectory, rolloutId)
  }

  #rolloutPath(rolloutId: string): string {
    return join(this.#rolloutDirectory(rolloutId), "rollout.jsonl")
  }

  #writerLockPath(threadId: string): string {
    return join(this.#writerLocksDirectory, `${threadId}.lock`)
  }

  #reservationLockPath(threadId: string, reservationId: string): string {
    return join(
      this.#reservationLocksDirectory,
      `${threadId}.${reservationId}.lock`,
    )
  }

  async #hasLiveReservation(threadId: string): Promise<boolean> {
    const prefix = `${threadId}.fork_`
    const files = await readdir(this.#reservationLocksDirectory)
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(".lock")) continue
      if (await lockPathIsHeld(join(this.#reservationLocksDirectory, file))) {
        return true
      }
    }
    return false
  }
}

function forkBoundaryIndex(
  history: readonly StoredRolloutItem[],
  input: PrepareForkInput,
): number {
  if (input.boundary.type === "latest") return history.length
  if (input.boundary.type === "before_turn") {
    const turnId = input.boundary.turnId
    return history.findIndex(
      (entry) =>
        entry.item.type === "response_item" &&
        entry.item.item.turnId === turnId &&
        entry.item.item.item.role === "user",
    )
  }
  const turnId = input.boundary.turnId
  const terminal = findLastIndex(
    history,
    (entry) =>
      entry.item.type === "turn_completed" && entry.item.turnId === turnId,
  )
  return terminal === -1 ? -1 : terminal + 1
}

function modelContextAt(
  rollout: readonly StoredRolloutItem[],
): readonly ResponseItemEnvelope[] {
  let context: readonly ResponseItemEnvelope[] = []
  for (const entry of rollout) {
    if (
      entry.item.type === "response_item" ||
      entry.item.type === "agent_message"
    ) {
      context = [...context, entry.item.item]
    } else if (entry.item.type === "compacted") {
      context = entry.item.replacement
    }
  }
  return structuredClone(context)
}

async function readPhysicalRollout(
  path: string,
  expected: { readonly rolloutId: string; readonly threadId?: string },
): Promise<readonly StoredRolloutItem[]> {
  const entries = (await readRolloutRecords(path)).map((record) => record.entry)
  const sessionMeta = entries[0]
  if (sessionMeta?.item.type !== "session_meta" || sessionMeta.seq !== 0) {
    throw new Error(
      `Rollout ${expected.rolloutId} has invalid Session metadata.`,
    )
  }
  const logicalThreadId = sessionMeta.item.metadata.id
  if (
    sessionMeta.rolloutId !== expected.rolloutId ||
    sessionMeta.item.metadata.rolloutId !== expected.rolloutId ||
    (expected.threadId !== undefined && logicalThreadId !== expected.threadId)
  ) {
    throw new Error(`Rollout ${expected.rolloutId} has mismatched identity.`)
  }
  let expectedSeq = sessionMeta.item.metadata.historyBase?.endSeqExclusive ?? 1
  for (const entry of entries.slice(1)) {
    if (
      entry.item.type === "session_meta" ||
      entry.threadId !== logicalThreadId ||
      entry.rolloutId !== expected.rolloutId ||
      entry.seq !== expectedSeq
    ) {
      throw new Error(
        `Rollout ${expected.rolloutId} has invalid local ordering.`,
      )
    }
    expectedSeq += 1
  }
  return entries
}

async function readRolloutRecords(
  path: string,
): Promise<readonly PhysicalRolloutRecord[]> {
  const bytes = await readFile(path)
  if (bytes.length === 0) return []
  const completeLength =
    bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1
  const records: PhysicalRolloutRecord[] = []
  let start = 0
  for (let index = 0; index < completeLength; index += 1) {
    if (bytes[index] !== 10) continue
    if (index === start) {
      start = index + 1
      continue
    }
    const value: unknown = JSON.parse(
      bytes.subarray(start, index).toString("utf8"),
    )
    if (!isStoredRolloutItem(value)) {
      throw new Error(`Rollout ${path} contains an invalid item.`)
    }
    records.push({ entry: value, endByteOffset: index + 1 })
    start = index + 1
  }
  return records
}

async function repairTrailingJsonLine(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (bytes.length === 0 || bytes.at(-1) === 10) return
  const completeLength = bytes.lastIndexOf(10) + 1
  const trailing = bytes.subarray(completeLength)
  try {
    const value: unknown = JSON.parse(trailing.toString("utf8"))
    if (!isStoredRolloutItem(value)) throw new Error("invalid rollout item")
    await appendFileNewline(path)
  } catch {
    await truncate(path, completeLength)
  }
}

async function reconcilePendingTail(
  path: string,
  pending: PendingWrite,
): Promise<boolean> {
  const bytes = await readFile(path)
  if (
    bytes.length >= pending.bytes.length &&
    bytes.subarray(bytes.length - pending.bytes.length).equals(pending.bytes)
  ) {
    return true
  }
  const completeLength = bytes.lastIndexOf(10) + 1
  if (bytes.length === completeLength) return false
  const expectedWithoutNewline = pending.bytes.subarray(
    0,
    pending.bytes.length - 1,
  )
  const trailing = bytes.subarray(completeLength)
  if (trailing.equals(expectedWithoutNewline)) {
    await appendFileNewline(path)
    return true
  }
  let value: unknown
  try {
    value = JSON.parse(trailing.toString("utf8"))
  } catch {
    await truncate(path, completeLength)
    return false
  }
  if (isStoredRolloutItem(value)) {
    throw new Error("Rollout contains an unexpected complete trailing item.")
  }
  await truncate(path, completeLength)
  return false
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && predicate(value)) return index
  }
  return -1
}

async function appendFileNewline(path: string): Promise<void> {
  const file = await open(path, "a")
  try {
    await file.writeFile("\n")
    await file.sync()
  } finally {
    await file.close()
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${globalThis.crypto.randomUUID()}.tmp`,
  )
  try {
    const file = await open(temporary, "wx")
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function durableRemove(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await syncDirectory(dirname(path))
}

async function durableRemoveTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: string }).code === "ENOENT"
  )
}

function requireThreadId(threadId: string): void {
  if (!isStorageKey(threadId)) {
    throw new Error("Thread id contains unsupported characters.")
  }
}

function normalizeMetadata(metadata: ThreadMetadata): ThreadMetadata {
  const copy = structuredClone(metadata)
  requireThreadId(copy.id)
  requireThreadId(copy.rolloutId)
  return copy
}

function isThreadMetadata(value: unknown): value is ThreadMetadata {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "rolloutId",
      "conversationId",
      "createdAt",
      "updatedAt",
      "title",
      "workingDirectory",
      "gitInfo",
      "projectId",
      "mateId",
      "mateRevisionId",
      "parentThreadId",
      "forkedFromTurnId",
      "forkedFromInputId",
      "forkReason",
      "historyBase",
      "metadata",
    ]) &&
    isStorageKey(value.id) &&
    isStorageKey(value.rolloutId) &&
    typeof value.conversationId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    optionalString(value.title) &&
    optionalString(value.workingDirectory) &&
    (value.gitInfo === undefined || isGitInfo(value.gitInfo)) &&
    optionalString(value.projectId) &&
    optionalString(value.mateId) &&
    optionalString(value.mateRevisionId) &&
    optionalString(value.parentThreadId) &&
    optionalString(value.forkedFromTurnId) &&
    optionalString(value.forkedFromInputId) &&
    (value.forkReason === undefined ||
      value.forkReason === "undo" ||
      value.forkReason === "edit") &&
    (value.historyBase === undefined || isHistoryPosition(value.historyBase)) &&
    (value.metadata === undefined || isJsonObject(value.metadata))
  )
}

function isGitInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["sha", "branch", "originUrl"]) &&
    optionalString(value.sha) &&
    optionalString(value.branch) &&
    optionalString(value.originUrl) &&
    (value.sha !== undefined ||
      value.branch !== undefined ||
      value.originUrl !== undefined)
  )
}

function isStoredRolloutItem(value: unknown): value is StoredRolloutItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["threadId", "rolloutId", "seq", "createdAt", "item"]) &&
    isStorageKey(value.threadId) &&
    isStorageKey(value.rolloutId) &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    typeof value.createdAt === "string" &&
    isRolloutItem(value.item)
  )
}

function isRolloutItem(value: unknown): value is RolloutItem {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "session_meta") {
    return (
      hasOnlyKeys(value, ["type", "metadata"]) &&
      isThreadMetadata(value.metadata)
    )
  }
  if (value.type === "response_item") {
    return hasOnlyKeys(value, ["type", "item"]) && isResponseItem(value.item)
  }
  if (value.type === "turn_context") {
    return (
      hasOnlyKeys(value, ["type", "context"]) &&
      isRecord(value.context) &&
      hasOnlyKeys(value.context, ["turnId", "configuration", "selection"]) &&
      typeof value.context.turnId === "string" &&
      isSessionConfigurationSnapshot(value.context.configuration) &&
      isModelSelection(value.context.selection)
    )
  }
  if (value.type === "model_context") {
    return (
      hasOnlyKeys(value, ["type", "settings"]) &&
      isRecord(value.settings) &&
      hasOnlyKeys(value.settings, ["provider", "model", "compactionHash"]) &&
      typeof value.settings.provider === "string" &&
      value.settings.provider.length > 0 &&
      typeof value.settings.model === "string" &&
      value.settings.model.length > 0 &&
      (value.settings.compactionHash === undefined ||
        typeof value.settings.compactionHash === "string")
    )
  }
  if (value.type === "turn_started") {
    return (
      hasOnlyKeys(value, [
        "type",
        "turnId",
        "inputItemId",
        "requestFingerprint",
      ]) &&
      typeof value.turnId === "string" &&
      typeof value.inputItemId === "string" &&
      (value.requestFingerprint === undefined ||
        typeof value.requestFingerprint === "string")
    )
  }
  if (value.type === "turn_completed") {
    return (
      hasOnlyKeys(value, [
        "type",
        "turnId",
        "outcome",
        "usage",
        "metrics",
        "error",
      ]) &&
      typeof value.turnId === "string" &&
      (value.outcome === "completed" ||
        value.outcome === "failed" ||
        value.outcome === "interrupted") &&
      (value.usage === undefined || isTokenUsage(value.usage)) &&
      (value.metrics === undefined || isTurnMetrics(value.metrics)) &&
      (value.error === undefined || isRolloutError(value.error))
    )
  }
  if (value.type === "input_cancelled") {
    return (
      hasOnlyKeys(value, ["type", "inputId"]) &&
      typeof value.inputId === "string"
    )
  }
  if (value.type === "agent_status") {
    return (
      hasOnlyKeys(value, ["type", "status", "error"]) &&
      value.status === "errored" &&
      typeof value.error === "string"
    )
  }
  if (value.type === "agent_message") {
    return (
      hasOnlyKeys(value, ["type", "messageId", "item"]) &&
      typeof value.messageId === "string" &&
      isResponseItem(value.item)
    )
  }
  if (value.type === "item_completed") {
    return (
      hasOnlyKeys(value, ["type", "turnId", "item"]) &&
      typeof value.turnId === "string" &&
      isKernelEvent({
        type: EventType.ItemCompleted,
        data: { turnId: value.turnId, item: value.item },
      })
    )
  }
  if (value.type === "world_state") {
    return (
      hasOnlyKeys(value, ["type", "turnId", "full", "state"]) &&
      typeof value.turnId === "string" &&
      typeof value.full === "boolean" &&
      isJsonObject(value.state)
    )
  }
  if (value.type === "compacted") {
    return (
      hasOnlyKeys(value, ["type", "turnId", "replacement", "summary"]) &&
      typeof value.turnId === "string" &&
      typeof value.summary === "string" &&
      Array.isArray(value.replacement) &&
      value.replacement.every(isResponseItem)
    )
  }
  if (value.type === "token_count") {
    return (
      hasOnlyKeys(value, [
        "type",
        "turnId",
        "activeContextTokens",
        "autoCompactPrefillTokens",
        "autoCompactPrefillEstimated",
        "historyAnchorItemId",
        "provider",
        "model",
      ]) &&
      typeof value.turnId === "string" &&
      typeof value.activeContextTokens === "number" &&
      Number.isSafeInteger(value.activeContextTokens) &&
      value.activeContextTokens >= 0 &&
      (value.autoCompactPrefillTokens === undefined ||
        (typeof value.autoCompactPrefillTokens === "number" &&
          Number.isSafeInteger(value.autoCompactPrefillTokens) &&
          value.autoCompactPrefillTokens >= 0)) &&
      (value.autoCompactPrefillEstimated === undefined ||
        typeof value.autoCompactPrefillEstimated === "boolean") &&
      (value.historyAnchorItemId === undefined ||
        typeof value.historyAnchorItemId === "string") &&
      (value.provider === undefined || typeof value.provider === "string") &&
      (value.model === undefined || typeof value.model === "string")
    )
  }
  return false
}

function isResponseItem(value: unknown): value is ResponseItemEnvelope {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "turnId",
      "createdAt",
      "item",
      "providerMetadata",
      "submissionMetadata",
    ]) &&
    typeof value.id === "string" &&
    typeof value.turnId === "string" &&
    typeof value.createdAt === "string" &&
    isModelMessage(value.item) &&
    (value.providerMetadata === undefined ||
      isJsonObject(value.providerMetadata)) &&
    (value.submissionMetadata === undefined ||
      isSubmissionMetadata(value.submissionMetadata))
  )
}

function isSubmissionMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "modelSelection",
      "parentInputId",
      "metadata",
      "queued",
    ]) &&
    (value.modelSelection === undefined ||
      isModelSelection(value.modelSelection)) &&
    optionalString(value.parentInputId) &&
    (value.metadata === undefined || isJsonObject(value.metadata)) &&
    (value.queued === undefined || value.queued === true)
  )
}

function isRolloutError(
  value: unknown,
): value is import("../kernel/index.ts").KernelError {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["message", "code", "details"]) &&
    typeof value.message === "string" &&
    optionalString(value.code) &&
    (value.details === undefined || isJsonObject(value.details))
  )
}

function isHistoryPosition(value: unknown): value is HistoryPosition {
  return (
    isRecord(value) &&
    isStorageKey(value.rolloutId) &&
    Number.isInteger(value.endSeqExclusive) &&
    Number(value.endSeqExclusive) >= 1 &&
    Number.isInteger(value.endByteOffset) &&
    Number(value.endByteOffset) > 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

async function acquireOwnedLock(
  path: string,
  conflictMessage: string,
  removeOnRelease = false,
  waitForOwnership = false,
): Promise<OwnedFileLock> {
  const file = await open(path, "a+")
  try {
    await flockPromise(file.fd, waitForOwnership ? "ex" : "exnb")
    return { path, file, removeOnRelease, released: false }
  } catch (error) {
    await file.close()
    if (isLockConflict(error)) throw new Error(conflictMessage)
    throw error
  }
}

async function lockPathIsHeld(path: string): Promise<boolean> {
  const file = await open(path, "a+")
  try {
    await flockPromise(file.fd, "exnb")
    await flockPromise(file.fd, "un")
    return false
  } catch (error) {
    if (isLockConflict(error)) return true
    throw error
  } finally {
    await file.close()
  }
}

async function hasAnyLiveLock(directory: string): Promise<boolean> {
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".lock")) continue
    if (await lockPathIsHeld(join(directory, file))) return true
  }
  return false
}

async function releaseOwnedLock(lock: OwnedFileLock): Promise<void> {
  if (!lock.released) {
    try {
      await flockPromise(lock.file.fd, "un")
    } finally {
      lock.released = true
      await lock.file.close()
    }
  }
  if (lock.removeOnRelease) await rm(lock.path, { force: true })
}

function flockPromise(
  fileDescriptor: number,
  operation: "ex" | "exnb" | "un",
): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fileDescriptor, operation, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function isLockConflict(error: unknown): boolean {
  return hasErrorCode(error, "EAGAIN") || hasErrorCode(error, "EWOULDBLOCK")
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: string }).code === code
  )
}
