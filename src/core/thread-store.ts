import type { DisplayWindowRead } from "./display-window.ts"
import type {
  HistoryPosition,
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadMetadata,
  ThreadSummary,
} from "./rollout.ts"
import type { SessionSidebar, SidebarChange } from "./session-sidebar.ts"
import type { ThreadSearchOccurrence } from "./thread-search.ts"

export type { DisplayWindowRead } from "./display-window.ts"

export const PersistContext = {
  Standard: "standard",
  TurnStart: "turn_start",
  GoalSet: "goal_set",
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
  "rolloutId" | "historyBase" | "previousRolloutId"
>

export type CreateForkInput = {
  readonly prepared: PreparedFork
  readonly target: CreateThreadMetadata
}

export type ThreadStoreForkResult = {
  readonly thread: StoredThread
  readonly historyEndSeqExclusive?: number
}

export type RevertThreadInput = Readonly<{
  threadId: string
  beforeTurnId: string
  expectedRolloutId: string
}>

export type RevertThreadResult = Readonly<{
  thread: StoredThread
  historyEndSeqExclusive?: number
}>

export type ThreadStoreListInput = Readonly<{
  view?: "sessions"
  archived?: boolean
  sectionId?: string | null
  cursor?: string
  limit?: number
  workingDirectory?: string
  projectId?: string
}>

export type ThreadStoreListResult = {
  readonly threads: readonly ThreadSummary[]
  readonly nextCursor?: string
}

export type ThreadStoreSearchInput = Readonly<{
  view?: "sessions"
  archived?: boolean
  sectionId?: string | null
  searchTerm: string
  cursor?: string
  limit: number
}>

export type ThreadStoreSearchResult = Readonly<{
  matches: readonly Readonly<{ summary: ThreadSummary; snippet: string }>[]
  nextCursor?: string
  unavailableThreadCount?: number
}>

export type ThreadStoreOccurrenceSearchInput = Readonly<{
  threadId: string
  searchTerm: string
  cursor?: string
  limit: number
}>

export type ThreadStoreOccurrenceSearchResult = Readonly<{
  occurrences: readonly ThreadSearchOccurrence[]
  nextCursor?: string
}>

export type RolloutAppend = Readonly<{
  // Exclusive rollout sequence reached by this append, including staged items.
  throughSeq: number
  records: readonly StoredRolloutItem[]
}>

export type ThreadEventRead = Readonly<{
  metadata: ThreadMetadata
  records: readonly StoredRolloutItem[]
  // All cursors are canonical rollout sequences (public event seq is seq + 1).
  endSeq: number
  nextAfter: number
  hasMore: boolean
}>

export type ThreadInputAdmissionsRead = Readonly<{
  metadata: ThreadMetadata
  records: readonly StoredRolloutItem[]
  endSeq: number
}>

// Storage-neutral rollout boundary. Implementations own their live single
// writer, retry buffer, reference-backed fork positions, and projections.
export type ThreadStore = {
  retainEphemeralRolloutAssets?(rolloutId: string): () => void
  createThread(metadata: CreateThreadMetadata): Promise<StoredThread>
  resumeThread(threadId: string): Promise<StoredThread | undefined>
  appendItems(
    threadId: string,
    items: readonly RolloutItem[],
  ): Promise<RolloutAppend>
  persistThread(threadId: string, context: PersistContext): Promise<void>
  flushThread(threadId: string): Promise<void>
  shutdownThread(threadId: string): Promise<void>
  discardThread(threadId: string): Promise<void>
  prepareFork(input: PrepareForkInput): Promise<PreparedFork>
  createFork(input: CreateForkInput): Promise<ThreadStoreForkResult>
  // The previous writer must be shut down. Success owns a new live writer for
  // the same Thread, with only the history before the selected turn retained.
  revertThread(input: RevertThreadInput): Promise<RevertThreadResult>
  releasePreparedFork(prepared: PreparedFork): Promise<void>
  readThreadMetadata(threadId: string): Promise<ThreadMetadata | undefined>
  readThread(threadId: string): Promise<StoredThread | undefined>
  // Current history first, followed by retained versions of this same Thread.
  readThreadVersions(threadId: string): Promise<readonly StoredThread[]>
  readThreadSummary(threadId: string): Promise<ThreadSummary | undefined>
  // Bounded recent display records plus supplemental Turn/model/cache state.
  readDisplayWindow(
    threadId: string,
    beforeSeqExclusive?: number,
    transcript?: boolean,
  ): Promise<DisplayWindowRead | undefined>
  readDisplayActivity(
    threadId: string,
    rolloutId: string,
    turnId: string,
    before: number,
  ): Promise<
    | Readonly<{
        records: readonly StoredRolloutItem[]
        nextBefore?: number
      }>
    | undefined
  >
  // Ascending display-eligible records; after is exclusive, through inclusive.
  // nextAfter advances to through/endSeq across excluded metadata when exhausted.
  readThreadEvents(
    threadId: string,
    input: Readonly<{ after: number; through?: number; limit: number }>,
  ): Promise<ThreadEventRead | undefined>
  // Absence is established through endSeq after selected projection catchup.
  readInputAdmissions(
    threadId: string,
    requestIds: readonly string[],
  ): Promise<ThreadInputAdmissionsRead | undefined>
  listThreadIds(): Promise<readonly string[]>
  readSessionSidebar(): Promise<SessionSidebar>
  // Generated titles must test absence inside the same storage mutation lock
  // as a manual rename, matching Grok's generated_title_if_absent contract.
  updateSessionSidebar(
    change: SidebarChange,
    options?: { onlyIfUntitled?: boolean },
  ): Promise<SessionSidebar>
  sessionPresentation(
    threadId: string,
  ): Promise<import("./session-sidebar.ts").SessionPresentation>
  listThreads(input?: ThreadStoreListInput): Promise<ThreadStoreListResult>
  searchThreads(input: ThreadStoreSearchInput): Promise<ThreadStoreSearchResult>
  searchThreadOccurrences(
    input: ThreadStoreOccurrenceSearchInput,
  ): Promise<ThreadStoreOccurrenceSearchResult | undefined>
  readUsageSummary(): Promise<
    import("./sqlite-thread-usage-projection.ts").ThreadUsageSummary
  >
  deleteThread(threadId: string): Promise<void>
}

// Session execution needs only its rollout writer. Ephemeral sessions keep
// this writer in memory without exposing durable navigation or fork APIs.
export type SessionRolloutStore = Pick<
  ThreadStore,
  | "appendItems"
  | "persistThread"
  | "flushThread"
  | "readThread"
  | "shutdownThread"
>
