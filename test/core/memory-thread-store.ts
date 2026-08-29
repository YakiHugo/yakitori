import type {
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadSummary,
} from "../../src/core/rollout.ts"
import type {
  CreateForkInput,
  CreateThreadMetadata,
  PersistContext,
  PreparedFork,
  PrepareForkInput,
  ThreadStore,
  ThreadStoreListInput,
} from "../../src/core/thread-store.ts"

type Writer = {
  readonly pending: RolloutItem[]
  readonly rolloutId: string
  tail: Promise<void>
  nextSeq: number
}

export class MemoryThreadStore implements ThreadStore {
  readonly #threads = new Map<string, StoredThread>()
  readonly #writers = new Map<string, Writer>()
  readonly #forks = new Map<
    string,
    {
      readonly sourceThreadId: string
      readonly prefix: readonly StoredRolloutItem[]
    }
  >()
  failNextAppend = false
  failNextFlush = false
  failNextShutdown = false
  failNextCreateFork = false
  flushBarrier: Promise<void> | undefined
  flushStarted: (() => void) | undefined
  resumeBarrier: Promise<void> | undefined
  prepareForkStarted: (() => void) | undefined
  createForkBarrier: Promise<void> | undefined

  async createThread(metadata: CreateThreadMetadata): Promise<StoredThread> {
    if (this.#threads.has(metadata.id))
      throw new Error("Thread already exists.")
    const storedMetadata = {
      ...structuredClone(metadata),
      rolloutId: metadata.id,
    }
    const thread: StoredThread = {
      metadata: storedMetadata,
      rollout: [
        record(metadata.id, metadata.id, 0, {
          type: "session_meta",
          metadata: storedMetadata,
        }),
      ],
    }
    this.#threads.set(metadata.id, thread)
    this.#writers.set(metadata.id, {
      pending: [],
      rolloutId: metadata.id,
      tail: Promise.resolve(),
      nextSeq: 1,
    })
    return structuredClone(thread)
  }

  async resumeThread(threadId: string): Promise<StoredThread | undefined> {
    await this.resumeBarrier
    const thread = this.#threads.get(threadId)
    if (thread === undefined) return undefined
    const last = thread.rollout.at(-1)
    this.#writers.set(threadId, {
      pending: [],
      rolloutId: thread.metadata.rolloutId ?? threadId,
      tail: Promise.resolve(),
      nextSeq: last === undefined ? 1 : last.seq + 1,
    })
    return structuredClone(thread)
  }

  appendItems(
    threadId: string,
    items: readonly RolloutItem[],
  ): Promise<number> {
    const writer = this.#requireWriter(threadId)
    const pending = structuredClone([...items])
    return this.#enqueue(writer, async () => {
      writer.pending.push(...pending)
      await this.#drain(threadId, writer, "append")
      return writer.nextSeq
    })
  }

  persistThread(threadId: string, _context: PersistContext): Promise<void> {
    const writer = this.#requireWriter(threadId)
    return this.#enqueue(writer, () => this.#drain(threadId, writer, "flush"))
  }

  flushThread(threadId: string): Promise<void> {
    const writer = this.#requireWriter(threadId)
    return this.#enqueue(writer, () => this.#drain(threadId, writer, "flush"))
  }

  async shutdownThread(threadId: string): Promise<void> {
    const writer = this.#requireWriter(threadId)
    await this.#enqueue(writer, () => this.#drain(threadId, writer, "shutdown"))
    this.#writers.delete(threadId)
  }

  async discardThread(threadId: string): Promise<void> {
    this.#writers.delete(threadId)
  }

  async prepareFork(input: PrepareForkInput): Promise<PreparedFork> {
    this.prepareForkStarted?.()
    const source = this.#requireThread(input.sourceThreadId)
    const boundary = forkBoundaryIndex(source, input)
    if (boundary === -1) throw new Error("Fork boundary was not found.")
    const reservationId = `fork_${globalThis.crypto.randomUUID()}`
    const prefix = structuredClone(source.rollout.slice(1, boundary))
    const last = prefix.at(-1)
    this.#forks.set(reservationId, {
      sourceThreadId: input.sourceThreadId,
      prefix,
    })
    return {
      reservationId,
      sourceThreadId: input.sourceThreadId,
      ...(last === undefined
        ? {}
        : {
            historyPosition: {
              rolloutId: last.rolloutId,
              endSeqExclusive: last.seq + 1,
              endByteOffset: last.seq + 1,
            },
          }),
      modelContext: modelContextAt(prefix),
    }
  }

  async createFork(input: CreateForkInput) {
    await this.createForkBarrier
    if (this.failNextCreateFork) {
      this.failNextCreateFork = false
      throw new Error("create fork failed")
    }
    const reservation = this.#forks.get(input.prepared.reservationId)
    if (reservation === undefined)
      throw new Error("Fork reservation was not found.")
    const inherited = structuredClone(reservation.prefix)
    const target = structuredClone(input.target)
    if ("rolloutId" in target || "historyBase" in target) {
      throw new Error(
        "Fork targets cannot provide physical rollout or inherited history.",
      )
    }
    const metadata = {
      ...target,
      rolloutId: input.target.id,
      ...(input.prepared.historyPosition === undefined
        ? {}
        : { historyBase: input.prepared.historyPosition }),
    }
    const thread: StoredThread = {
      metadata,
      rollout: [
        record(input.target.id, input.target.id, 0, {
          type: "session_meta",
          metadata,
        }),
        ...inherited,
      ],
    }
    this.#threads.set(input.target.id, thread)
    this.#writers.set(input.target.id, {
      pending: [],
      rolloutId: input.target.id,
      tail: Promise.resolve(),
      nextSeq: input.prepared.historyPosition?.endSeqExclusive ?? 1,
    })
    this.#forks.delete(input.prepared.reservationId)
    return {
      thread: structuredClone(thread),
      ...(input.prepared.historyPosition === undefined
        ? {}
        : {
            historyEndSeqExclusive:
              input.prepared.historyPosition.endSeqExclusive,
          }),
    }
  }

  async releasePreparedFork(prepared: PreparedFork): Promise<void> {
    const reservation = this.#forks.get(prepared.reservationId)
    if (reservation?.sourceThreadId === prepared.sourceThreadId) {
      this.#forks.delete(prepared.reservationId)
    }
  }

  async readThread(threadId: string): Promise<StoredThread | undefined> {
    const thread = this.#threads.get(threadId)
    return thread === undefined ? undefined : structuredClone(thread)
  }

  async listThreadIds(): Promise<readonly string[]> {
    return [...this.#threads.keys()].sort()
  }

  async listThreads(input: ThreadStoreListInput = {}) {
    const limit = input.limit ?? 50
    const threads: ThreadSummary[] = [...this.#threads.values()]
      .filter(
        (thread) =>
          input.workingDirectory === undefined ||
          thread.metadata.workingDirectory === input.workingDirectory,
      )
      .map((thread) => ({
        ...thread.metadata,
        seq: thread.rollout.length,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const start =
      input.cursor === undefined
        ? 0
        : threads.findIndex((thread) => thread.id === input.cursor) + 1
    const page = threads.slice(start, start + limit)
    const last = page.at(-1)
    return {
      threads: structuredClone(page),
      ...(last !== undefined && start + limit < threads.length
        ? { nextCursor: last.id }
        : {}),
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    if (
      [...this.#forks.values()].some(
        (reservation) => reservation.sourceThreadId === threadId,
      )
    ) {
      throw new Error("Thread has an active fork reservation.")
    }
    this.#writers.delete(threadId)
    this.#threads.delete(threadId)
  }

  #enqueue<T>(writer: Writer, operation: () => Promise<T>): Promise<T> {
    const result = writer.tail.then(operation)
    writer.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #drain(
    threadId: string,
    writer: Writer,
    operation: "append" | "flush" | "shutdown",
  ): Promise<void> {
    if (operation === "flush") {
      this.flushStarted?.()
      await this.flushBarrier
    }
    if (operation === "append" && this.failNextAppend) {
      this.failNextAppend = false
      throw new Error("append failed")
    }
    if (operation === "flush" && this.failNextFlush) {
      this.failNextFlush = false
      throw new Error("flush failed")
    }
    if (operation === "shutdown" && this.failNextShutdown) {
      this.failNextShutdown = false
      throw new Error("shutdown failed")
    }
    if (writer.pending.length === 0) return
    const thread = this.#requireThread(threadId)
    const pending = writer.pending.splice(0)
    const rollout = [...thread.rollout]
    for (const item of pending) {
      rollout.push(record(threadId, writer.rolloutId, writer.nextSeq, item))
      writer.nextSeq += 1
    }
    this.#threads.set(threadId, {
      metadata: {
        ...thread.metadata,
        updatedAt: new Date().toISOString(),
      },
      rollout,
    })
  }

  #requireWriter(threadId: string): Writer {
    const writer = this.#writers.get(threadId)
    if (writer === undefined) throw new Error("Thread writer is not live.")
    return writer
  }

  #requireThread(threadId: string): StoredThread {
    const thread = this.#threads.get(threadId)
    if (thread === undefined) throw new Error("Thread was not found.")
    return thread
  }
}

function modelContextAt(
  rollout: readonly StoredRolloutItem[],
): readonly import("../../src/core/rollout.ts").ResponseItemEnvelope[] {
  let context: readonly import("../../src/core/rollout.ts").ResponseItemEnvelope[] =
    []
  for (const entry of rollout) {
    if (entry.item.type === "response_item") {
      context = [...context, entry.item.item]
    } else if (entry.item.type === "compacted") {
      context = entry.item.replacement
    }
  }
  return structuredClone(context)
}

function forkBoundaryIndex(
  source: StoredThread,
  input: PrepareForkInput,
): number {
  if (input.boundary.type === "latest") return source.rollout.length
  const turnId = input.boundary.turnId
  if (input.boundary.type === "before_turn") {
    return source.rollout.findIndex(
      (entry) =>
        entry.item.type === "response_item" &&
        entry.item.item.turnId === turnId &&
        entry.item.item.item.role === "user",
    )
  }
  const terminal = findLastIndex(
    source.rollout,
    (entry) =>
      entry.item.type === "turn_completed" && entry.item.turnId === turnId,
  )
  return terminal === -1 ? -1 : terminal + 1
}

function record(
  threadId: string,
  rolloutId: string,
  seq: number,
  item: RolloutItem,
): StoredRolloutItem {
  return {
    threadId,
    rolloutId,
    seq,
    createdAt: new Date().toISOString(),
    item: structuredClone(item),
  }
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
