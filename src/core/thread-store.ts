import type {
  HistoryPosition,
  RolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadSummary,
} from "./rollout.ts"

export const PersistContext = {
  Standard: "standard",
  TurnStart: "turn_start",
} as const

export type PersistContext =
  (typeof PersistContext)[keyof typeof PersistContext]

export type ForkBoundary =
  | { readonly type: "latest" }
  | { readonly type: "before_turn"; readonly turnId: string }
  | { readonly type: "through_turn"; readonly turnId: string }

export type PrepareForkInput = {
  readonly sourceThreadId: string
  readonly boundary: ForkBoundary
}

export type PreparedFork = {
  readonly reservationId: string
  readonly sourceThreadId: string
  readonly historyPosition?: HistoryPosition
  readonly modelContext: readonly import("./rollout.ts").ResponseItemEnvelope[]
}

export type CreateThreadMetadata = Omit<
  ThreadMetadata,
  "rolloutId" | "historyBase"
>

export type CreateForkInput = {
  readonly prepared: PreparedFork
  readonly target: CreateThreadMetadata
}

export type ThreadStoreForkResult = {
  readonly thread: StoredThread
  readonly historyEndSeqExclusive?: number
}

export type ThreadStoreListInput = {
  readonly cursor?: string
  readonly limit?: number
  readonly workingDirectory?: string
}

export type ThreadStoreListResult = {
  readonly threads: readonly ThreadSummary[]
  readonly nextCursor?: string
}

// Storage-neutral rollout boundary. Implementations own their live single
// writer, retry buffer, reference-backed fork positions, and projections.
export type ThreadStore = {
  createThread(metadata: CreateThreadMetadata): Promise<StoredThread>
  resumeThread(threadId: string): Promise<StoredThread | undefined>
  appendItems(threadId: string, items: readonly RolloutItem[]): Promise<number>
  persistThread(threadId: string, context: PersistContext): Promise<void>
  flushThread(threadId: string): Promise<void>
  shutdownThread(threadId: string): Promise<void>
  discardThread(threadId: string): Promise<void>
  prepareFork(input: PrepareForkInput): Promise<PreparedFork>
  createFork(input: CreateForkInput): Promise<ThreadStoreForkResult>
  releasePreparedFork(prepared: PreparedFork): Promise<void>
  readThread(threadId: string): Promise<StoredThread | undefined>
  listThreads(input?: ThreadStoreListInput): Promise<ThreadStoreListResult>
  deleteThread(threadId: string): Promise<void>
}
