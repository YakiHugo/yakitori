import type {
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadSummary,
} from "../../src/core/rollout.ts"
import type {
  CreateForkInput,
  PersistContext,
  PreparedFork,
  PrepareForkInput,
  ThreadStore,
  ThreadStoreListInput,
} from "../../src/core/thread-store.ts"

type Writer = {
  readonly pending: RolloutItem[]
  tail: Promise<void>
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
  resumeBarrier: Promise<void> | undefined
  prepareForkStarted: (() => void) | undefined
  createForkBarrier: Promise<void> | undefined

  async createThread(metadata: ThreadMetadata): Promise<StoredThread> {
    if (this.#threads.has(metadata.id))
      throw new Error("Thread already exists.")
    const thread: StoredThread = {
      metadata: structuredClone(metadata),
      rollout: [record(metadata.id, 1, { type: "session_meta", metadata })],
    }
    this.#threads.set(metadata.id, thread)
    this.#writers.set(metadata.id, { pending: [], tail: Promise.resolve() })
    return structuredClone(thread)
  }

  async resumeThread(threadId: string): Promise<StoredThread | undefined> {
    await this.resumeBarrier
    const thread = this.#threads.get(threadId)
    if (thread === undefined) return undefined
    this.#writers.set(threadId, { pending: [], tail: Promise.resolve() })
    return structuredClone(thread)
  }

  appendItems(threadId: string, items: readonly RolloutItem[]): Promise<void> {
    const writer = this.#requireWriter(threadId)
    writer.pending.push(...structuredClone([...items]))
    return this.#enqueue(writer, () => this.#drain(threadId, writer, "append"))
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
    try {
      await this.#enqueue(writer, () =>
        this.#drain(threadId, writer, "shutdown"),
      )
    } finally {
      this.#writers.delete(threadId)
    }
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
    this.#forks.set(reservationId, {
      sourceThreadId: input.sourceThreadId,
      prefix,
    })
    return {
      reservationId,
      sourceThreadId: input.sourceThreadId,
      historyPosition: {
        threadId: input.sourceThreadId,
        endSeqExclusive:
          source.rollout[boundary]?.seq ?? source.rollout.length + 1,
      },
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
    const inherited = reservation.prefix.map((entry, index) => ({
      ...structuredClone(entry),
      threadId: input.target.id,
      seq: index + 2,
    }))
    const thread: StoredThread = {
      metadata: structuredClone(input.target),
      rollout: [
        record(input.target.id, 1, {
          type: "session_meta",
          metadata: input.target,
        }),
        ...inherited,
      ],
    }
    this.#threads.set(input.target.id, thread)
    this.#writers.set(input.target.id, { pending: [], tail: Promise.resolve() })
    this.#forks.delete(input.prepared.reservationId)
    return {
      thread: structuredClone(thread),
      historyEndSeqExclusive: input.prepared.historyPosition.endSeqExclusive,
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

  #enqueue(writer: Writer, operation: () => Promise<void>): Promise<void> {
    const result = writer.tail.then(operation)
    writer.tail = result.catch(() => undefined)
    return result
  }

  async #drain(
    threadId: string,
    writer: Writer,
    operation: "append" | "flush" | "shutdown",
  ): Promise<void> {
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
      rollout.push(record(threadId, rollout.length + 1, item))
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
  const terminal = source.rollout.findIndex(
    (entry) =>
      entry.item.type === "turn_completed" && entry.item.turnId === turnId,
  )
  return terminal === -1 ? -1 : terminal + 1
}

function record(
  threadId: string,
  seq: number,
  item: RolloutItem,
): StoredRolloutItem {
  return {
    threadId,
    seq,
    createdAt: new Date().toISOString(),
    item: structuredClone(item),
  }
}
