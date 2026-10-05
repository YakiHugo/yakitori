import type { AgentThread } from "../core/agent-thread.ts"
import { SessionStatus, type TurnInputSubmission } from "../core/session-io.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import type { InputQueue, QueuedInput } from "./input-queue.ts"
import {
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"

export const MAX_QUEUED_INPUT_TEXT_CHARS = 1 << 20

export class QueuedInputTooLargeError extends Error {
  constructor() {
    super(
      `Queued input text must not exceed ${MAX_QUEUED_INPUT_TEXT_CHARS} characters.`,
    )
  }
}

// The editable next-Turn queue follows the thread lifecycle. RPC handlers
// validate requests and attachments; this service owns queue state and dispatch.
export class QueuedItemService {
  readonly #queue: InputQueue
  readonly #manager: ThreadManager
  readonly #notifyChanged: ((sessionId: string) => void) | undefined
  readonly #onStarting: ((item: QueuedInput) => void) | undefined
  readonly #onNotStarted: ((item: QueuedInput) => void) | undefined
  readonly #reporter: OperationalFailureReporter
  readonly #tails = new Map<string, Promise<void>>()
  readonly #subscriptions = new Map<AgentThread, () => void>()
  readonly #externalChangesTimer: ReturnType<typeof setInterval> | undefined
  #externalVersion: number | undefined
  #lastRevision = 0
  #closing = false

  constructor(input: {
    queue: InputQueue
    manager: ThreadManager
    notifyChanged?: (sessionId: string) => void
    onStarting?: (item: QueuedInput) => void
    onNotStarted?: (item: QueuedInput) => void
    reporter: OperationalFailureReporter
  }) {
    this.#queue = input.queue
    this.#manager = input.manager
    this.#notifyChanged = input.notifyChanged
    this.#onStarting = input.onStarting
    this.#onNotStarted = input.onNotStarted
    this.#reporter = input.reporter
    if (input.queue.sharedAcrossConnections) {
      this.#externalChangesTimer = setInterval(() => {
        try {
          this.pollExternalChanges()
        } catch (error) {
          reportOperationalFailure(this.#reporter, {
            component: "input-queue",
            operation: "watch-external",
            cause: error,
          })
        }
      }, 10_000)
      this.#externalChangesTimer.unref()
    }
  }

  pollExternalChanges(): void {
    if (this.#closing) return
    const version = this.#queue.changeVersion()
    if (version === this.#externalVersion) return
    const loaded = [...this.#subscriptions.keys()]
      .filter((thread) => thread.status !== SessionStatus.Shutdown)
      .map((thread) => thread.id)
    const changes = this.#queue.changesSince(this.#lastRevision, loaded)
    this.#externalVersion = version
    for (const change of changes) {
      this.#lastRevision = change.revision
      this.changed(change.sessionId)
      this.wake(change.sessionId)
    }
  }

  install(thread: AgentThread): void {
    if (this.#subscriptions.has(thread)) return
    const unsubscribe = thread.subscribeStatus((status, idleCause) => {
      if (status === SessionStatus.Idle && idleCause !== "interrupted")
        this.wake(thread)
    })
    this.#subscriptions.set(thread, unsubscribe)
    void thread.termination.then(
      () => {
        unsubscribe()
        this.#subscriptions.delete(thread)
      },
      () => {
        unsubscribe()
        this.#subscriptions.delete(thread)
      },
    )
    if (
      thread.status === SessionStatus.Idle &&
      thread.agentStatus !== "interrupted"
    )
      this.wake(thread)
  }

  async withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tails.set(sessionId, tail)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId)
    }
  }

  changed(sessionId: string): void {
    this.#notifyChanged?.(sessionId)
  }

  list(sessionId: string): readonly QueuedInput[] {
    return this.#queue.list(sessionId)
  }

  get(sessionId: string, inputId: string): QueuedInput | undefined {
    return this.#queue.get(sessionId, inputId)
  }

  getByRequest(sessionId: string, requestId: string): QueuedInput | undefined {
    return this.#queue.getByRequest(sessionId, requestId)
  }

  enqueue(sessionId: string, input: QueuedInput["input"]): QueuedInput {
    validateQueuedText(input)
    const item = this.#queue.enqueue(sessionId, input)
    this.changed(sessionId)
    return item
  }

  update(
    sessionId: string,
    inputId: string,
    input: QueuedInput["input"],
  ): QueuedInput | undefined {
    validateQueuedText(input)
    const existing = this.#queue.get(sessionId, inputId)
    if (existing === undefined) return undefined
    const item = this.#queue.update(sessionId, inputId, {
      ...input,
      submissionId: existing.input.submissionId,
    })
    if (item !== undefined) this.changed(sessionId)
    return item
  }

  delete(sessionId: string, inputId: string): boolean {
    const deleted = this.#queue.delete(sessionId, inputId)
    if (deleted) this.changed(sessionId)
    return deleted
  }

  deleteSession(sessionId: string): void {
    this.#queue.deleteSession(sessionId)
    this.changed(sessionId)
  }

  reorder(
    sessionId: string,
    inputIds: readonly string[],
  ): readonly QueuedInput[] {
    this.#queue.reorder(sessionId, inputIds)
    this.changed(sessionId)
    return this.list(sessionId)
  }

  async start(
    thread: AgentThread,
    item: QueuedInput,
  ): Promise<TurnInputSubmission> {
    this.#onStarting?.(item)
    let submission: TurnInputSubmission
    try {
      submission = await thread.startIfIdle(item.input)
    } catch (error) {
      this.#onNotStarted?.(item)
      throw error
    }
    if (submission.type !== "started") this.#onNotStarted?.(item)
    // Replay means this request was already accepted before queue cleanup.
    if (submission.type === "started" || submission.type === "replayed") {
      this.delete(thread.id, item.id)
    }
    return submission
  }

  wake(target: AgentThread | string): void {
    if (this.#closing) return
    const sessionId = typeof target === "string" ? target : target.id
    void this.withLock(sessionId, async () => {
      const item = this.list(sessionId)[0]
      if (item === undefined) return
      const thread =
        typeof target === "string" ? this.#manager.getThread(sessionId) : target
      if (
        thread === undefined ||
        thread.status !== SessionStatus.Idle ||
        thread.agentStatus === "interrupted"
      )
        return
      await this.start(thread, item)
    }).catch((error: unknown) => {
      reportOperationalFailure(this.#reporter, {
        component: "input-queue",
        operation: "dispatch",
        cause: error,
        sessionId,
      })
    })
  }

  async close(): Promise<void> {
    this.#closing = true
    if (this.#externalChangesTimer !== undefined)
      clearInterval(this.#externalChangesTimer)
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe()
    this.#subscriptions.clear()
    await Promise.allSettled([...this.#tails.values()])
  }
}

function validateQueuedText(input: QueuedInput["input"]): void {
  let chars = 0
  for (const part of input.content.parts) {
    if (part.type !== "text") continue
    for (const _character of part.text) {
      if (++chars > MAX_QUEUED_INPUT_TEXT_CHARS)
        throw new QueuedInputTooLargeError()
    }
  }
}
