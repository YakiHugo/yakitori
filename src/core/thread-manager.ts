import type { EventMetadata } from "../kernel/events.ts"
import { createSessionId } from "../kernel/ids.ts"
import { LiveThread } from "./live-thread.ts"
import type { StoredThread } from "./rollout.ts"
import { Session, type TurnProcessor } from "./session.ts"
import type {
  CreateThreadMetadata,
  ThreadStore,
  ThreadStoreForkResult,
  ThreadStoreListInput,
} from "./thread-store.ts"

export type CreateThreadInput = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentThreadId?: string
  readonly metadata?: EventMetadata
}

export type ForkThreadInput = {
  readonly sourceThreadId: string
  readonly beforeTurnId: string
  readonly title?: string
  readonly metadata?: EventMetadata
  readonly forkedFromInputId?: string
  readonly forkReason?: import("../kernel/events.ts").ForkReason
}

export type ThreadManagerOptions = {
  readonly store: ThreadStore
  readonly createTurnProcessor: (threadId: string) => TurnProcessor
  readonly onPersistenceError?: (error: unknown, threadId: string) => void
}

export class ThreadManager {
  readonly #store: ThreadStore
  readonly #createTurnProcessor: (threadId: string) => TurnProcessor
  readonly #onPersistenceError?:
    | ((error: unknown, threadId: string) => void)
    | undefined
  readonly #threads = new Map<string, LiveThread>()
  readonly #loads = new Map<string, Promise<LiveThread | undefined>>()
  readonly #starting = new Set<Promise<unknown>>()
  readonly #discarding = new Set<string>()
  #closing = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: ThreadManagerOptions) {
    this.#store = options.store
    this.#createTurnProcessor = options.createTurnProcessor
    this.#onPersistenceError = options.onPersistenceError
  }

  getThread(threadId: string): LiveThread | undefined {
    const thread = this.#threads.get(threadId)
    return thread?.status === "shutdown" ? undefined : thread
  }

  createThread(input: CreateThreadInput = {}): Promise<LiveThread> {
    this.#requireOpen()
    return this.#trackStarting(async () => {
      const now = new Date().toISOString()
      const threadId = createSessionId()
      const metadata: CreateThreadMetadata = {
        id: threadId,
        conversationId: threadId,
        createdAt: now,
        updatedAt: now,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.workingDirectory === undefined
          ? {}
          : { workingDirectory: input.workingDirectory }),
        ...(input.mateId === undefined ? {} : { mateId: input.mateId }),
        ...(input.mateRevisionId === undefined
          ? {}
          : { mateRevisionId: input.mateRevisionId }),
        ...(input.parentThreadId === undefined
          ? {}
          : { parentThreadId: input.parentThreadId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      const stored = await this.#store.createThread(metadata)
      if (this.#closing) {
        await this.#store.deleteThread(threadId)
        throw new Error("ThreadManager shut down while creating a Thread.")
      }
      return this.#installStored(stored)
    })
  }

  resumeThread(threadId: string): Promise<LiveThread | undefined> {
    this.#requireOpen()
    if (this.#discarding.has(threadId)) {
      return Promise.reject(new Error(`Thread ${threadId} is being discarded.`))
    }
    const live = this.getThread(threadId)
    if (live !== undefined) return Promise.resolve(live)
    const loading = this.#loads.get(threadId)
    if (loading !== undefined) return loading
    const load = this.#trackStarting(async () => {
      const stored = await this.#store.resumeThread(threadId)
      if (stored === undefined) return undefined
      if (this.#closing || this.#discarding.has(threadId)) {
        await this.#store.discardThread(threadId)
        if (this.#closing) {
          throw new Error("ThreadManager shut down while resuming a Thread.")
        }
        throw new Error(`Thread ${threadId} was discarded while resuming.`)
      }
      return this.#installStored(stored)
    }).finally(() => {
      if (this.#loads.get(threadId) === load) this.#loads.delete(threadId)
    })
    this.#loads.set(threadId, load)
    return load
  }

  forkThread(input: ForkThreadInput): Promise<{
    readonly thread: LiveThread
    readonly result: ThreadStoreForkResult
  }> {
    this.#requireOpen()
    return this.#trackStarting(async () => {
      const source = await this.resumeThread(input.sourceThreadId)
      if (source === undefined) {
        throw new Error(`Thread ${input.sourceThreadId} was not found.`)
      }
      const sourceMetadata = source.snapshot().metadata
      const {
        rolloutId: _rolloutId,
        historyBase: _historyBase,
        ...forkableMetadata
      } = sourceMetadata
      const now = new Date().toISOString()
      const target: CreateThreadMetadata = {
        ...forkableMetadata,
        id: createSessionId(),
        createdAt: now,
        updatedAt: now,
        parentThreadId: source.id,
        forkedFromTurnId: input.beforeTurnId,
        ...(input.forkedFromInputId === undefined
          ? {}
          : { forkedFromInputId: input.forkedFromInputId }),
        ...(input.forkReason === undefined
          ? {}
          : { forkReason: input.forkReason }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      const result = await source.withForkBarrier(async () => {
        const prepared = await this.#store.prepareFork({
          sourceThreadId: source.id,
          boundary: { type: "before_turn", turnId: input.beforeTurnId },
        })
        try {
          return await this.#store.createFork({ prepared, target })
        } catch (error) {
          await this.#store.releasePreparedFork(prepared)
          throw error
        }
      })
      if (this.#closing) {
        await this.#store.deleteThread(target.id)
        throw new Error("ThreadManager shut down while forking a Thread.")
      }
      return { thread: this.#installStored(result.thread), result }
    })
  }

  listThreads(input?: ThreadStoreListInput) {
    return this.#store.listThreads(input)
  }

  async discardThread(threadId: string): Promise<void> {
    this.#discarding.add(threadId)
    try {
      await this.#loads.get(threadId)?.catch(() => undefined)
      const live = this.#threads.get(threadId)
      if (live !== undefined) await live.shutdownAndWait()
      this.#threads.delete(threadId)
      await this.#store.deleteThread(threadId)
    } finally {
      this.#discarding.delete(threadId)
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise
    this.#closing = true
    this.#shutdownPromise = this.#finishShutdown()
    return this.#shutdownPromise
  }

  async #finishShutdown(): Promise<void> {
    while (this.#starting.size > 0) {
      await Promise.allSettled([...this.#starting])
    }
    const threads = [...this.#threads.values()]
    await Promise.all(threads.map((thread) => thread.shutdownAndWait()))
    this.#threads.clear()
  }

  #installStored(stored: StoredThread): LiveThread {
    this.#requireOpen()
    const threadId = stored.metadata.id
    if (this.#discarding.has(threadId)) {
      throw new Error(`Thread ${threadId} is being discarded.`)
    }
    const existing = this.getThread(threadId)
    if (existing !== undefined) return existing
    let thread: LiveThread
    try {
      thread = new LiveThread(
        new Session({
          stored,
          store: this.#store,
          processor: this.#createTurnProcessor(threadId),
          ...(this.#onPersistenceError === undefined
            ? {}
            : {
                onPersistenceError: (error) =>
                  this.#onPersistenceError?.(error, threadId),
              }),
        }),
      )
    } catch (error) {
      void this.#store.discardThread(threadId)
      throw error
    }
    this.#threads.set(threadId, thread)
    void thread.termination.then(() => {
      if (this.#threads.get(threadId) === thread) this.#threads.delete(threadId)
    })
    return thread
  }

  #trackStarting<T>(operation: () => Promise<T>): Promise<T> {
    const result = operation()
    this.#starting.add(result)
    void result.then(
      () => this.#starting.delete(result),
      () => this.#starting.delete(result),
    )
    return result
  }

  #requireOpen(): void {
    if (this.#closing) throw new Error("ThreadManager is shut down.")
  }
}
