import { realpath, stat } from "node:fs/promises"
import type { AgentThread } from "../core/agent-thread.ts"
import { assetSourceKey, isAssetSource } from "../core/asset-types.ts"
import { isGoalStatus, type ThreadGoal } from "../core/goal.ts"
import type {
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadSummary,
} from "../core/rollout.ts"
import { sessionCacheExpiry } from "../core/session-cache-expiry.ts"
import type { TurnInput, TurnInputSubmission } from "../core/session-io.ts"
import {
  parseSidebarChange,
  type SessionSidebar,
} from "../core/session-sidebar.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import { PersistContext, type ThreadStore } from "../core/thread-store.ts"
import {
  inputContentAttachments,
  inputContentFromModelMessage,
  inputContentText,
  isInputContent,
  replaceInputAttachments,
} from "../core/user-input.ts"
import {
  AttachmentConflictError,
  createEventEnvelope,
  createRequestId,
  EVENT_SCHEMA_VERSION,
  type EventMetadata,
  ForkReason,
  IdPrefix,
  type InputContent,
  InputRole,
  isIdWithPrefix,
  isJsonValue,
  isKernelEvent,
  isRequestId,
  isYakitoriError,
  type ModelSelection,
  type RolloutAssets,
  type StoredEventEnvelope,
  type TokenUsage,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import { fingerprintInputAdmission } from "../kernel/operation.ts"
import type { AppSessionEventEnvelope } from "../protocol/events.ts"
import type { AgentSummary } from "../runtime/agent-control.ts"
import type { GoalRuntime, SetGoalInput } from "../runtime/goal-runtime.ts"
import { createCoalescingDeltaPublisher } from "../runtime/live-events.ts"
import type {
  RuntimePermissionReason,
  RuntimePermissionRequest,
} from "../runtime/permission-gate.ts"
import type { SkillMetadata } from "../runtime/skills.ts"
import { GoalToolError } from "../runtime/tools/goal.ts"
import {
  InputQueue,
  InputQueueFullError,
  type QueuedInput,
} from "./input-queue.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"
import type {
  ApiClearGoalResponse,
  ApiReadGoalResponse,
  ApiSetGoalResponse,
} from "./protocol.ts"
import {
  type ApiAdmitInputResponse,
  type ApiCancelInputResponse,
  type ApiCancelTurnResponse,
  type ApiCompactSessionResponse,
  type ApiCreateSessionResponse,
  type ApiDeleteSessionResponse,
  ApiErrorCode,
  type ApiForkSessionResponse,
  type ApiHandlerResult,
  type ApiListAgentsResponse,
  type ApiListSessionsResponse,
  type ApiListSkillsResponse,
  type ApiReadSessionEventsResponse,
  type ApiReadSessionResponse,
  type ApiReadUsageResponse,
  type ApiResolvePermissionResponse,
  type ApiSearchSessionOccurrencesResponse,
  type ApiSearchSessionsResponse,
  type ApiSessionDetail,
  type ApiSessionSummary,
  type ApiSteerInputResponse,
} from "./protocol.ts"
import {
  MAX_QUEUED_INPUT_TEXT_CHARS,
  QueuedInputTooLargeError,
  QueuedItemService,
  QueuedSessionArchivedError,
} from "./queued-item-service.ts"
import type { SessionCompletedNotification } from "./rpc/methods.ts"
import type { SessionTitleGenerator } from "./session-title.ts"
import type { ProjectStore } from "./sqlite-project-store.ts"
import { readWorkspaceGitInfo } from "./workspace.ts"

// Input payload allocation boundary for local RPC commands, independent of
// model context capacity. Retains the existing 256 KiB admission bound.
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024
// Every Unicode scalar occupies at most four UTF-8 bytes. This allocation
// boundary lets the Codex queue character limit be the effective text limit.
const MAX_QUEUED_INPUT_TEXT_BYTES = MAX_QUEUED_INPUT_TEXT_CHARS * 4

export type SessionCreateDefaults = {
  readonly workingDirectory: string
  readonly mateId: string
  readonly mateRevisionId: string
}

export type ThreadServerHandlerOptions = {
  readonly goals?: GoalRuntime
  readonly manager: ThreadManager
  readonly discardThread?: (threadId: string) => Promise<void>
  readonly store: ThreadStore
  readonly listAgents?: (
    stored: StoredThread,
  ) => Promise<readonly AgentSummary[]>
  readonly eventHub?: {
    publishDurable(events: readonly StoredEventEnvelope[]): void
    publishTransient(
      event: import("../runtime/live-events.ts").LiveSessionEvent,
    ): void
  }
  readonly sessionDefaults?: SessionCreateDefaults
  readonly resolvePermission?: (input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
    readonly behavior: "allow" | "deny"
    readonly reason?: RuntimePermissionReason
  }) => boolean
  readonly listPendingPermissions?: (
    sessionId: string,
  ) => readonly RuntimePermissionRequest[]
  readonly maxInputBytes?: number
  readonly availableProviders?: readonly string[]
  // Fire-and-forget first-input title naming; absent in tests/embedders
  // without a model directory.
  readonly sessionTitle?: SessionTitleGenerator
  readonly rolloutAssets?: RolloutAssets
  readonly releaseDraftRolloutAssets?: (rolloutIds: readonly string[]) => void
  // Lists the skills the runtime would discover for a session's working
  // directory. Absent in tests and embedders without skill discovery.
  readonly listSessionSkills?: (input: {
    readonly sessionId: string
    readonly workingDirectory: string
    readonly projectId?: string
  }) => Promise<readonly SkillMetadata[]>
  // Enables projectId on session create/list and orphan suppression on reads.
  readonly projectStore?: ProjectStore
  readonly inputQueue?: InputQueue
  readonly inputQueueDatabasePath?: string
  readonly notifyQueueChanged?: (sessionId: string) => void
  readonly reportOperationalFailure?: OperationalFailureReporter
  readonly onRootTurnCompleted?: (event: SessionCompletedNotification) => void
}

export type ServerHandlers = {
  readGoal(input: unknown): Promise<ApiHandlerResult<ApiReadGoalResponse>>
  setGoal(input: unknown): Promise<ApiHandlerResult<ApiSetGoalResponse>>
  clearGoal(input: unknown): Promise<ApiHandlerResult<ApiClearGoalResponse>>
  listAgents(input: unknown): Promise<ApiHandlerResult<ApiListAgentsResponse>>
  readSidebar(): Promise<ApiHandlerResult<SessionSidebar>>
  updateSidebar(input: unknown): Promise<ApiHandlerResult<SessionSidebar>>
  readUsage(): Promise<ApiHandlerResult<ApiReadUsageResponse>>
  createSession(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiCreateSessionResponse>>
  listSessions(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiListSessionsResponse>>
  searchSessions(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiSearchSessionsResponse>>
  searchSessionOccurrences(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiSearchSessionOccurrencesResponse>>
  readSession(input: unknown): Promise<ApiHandlerResult<ApiReadSessionResponse>>
  listSkills(input: unknown): Promise<ApiHandlerResult<ApiListSkillsResponse>>
  deleteSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiDeleteSessionResponse>>
  closeSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiDeleteSessionResponse>>
  forkSession(input: unknown): Promise<ApiHandlerResult<ApiForkSessionResponse>>
  admitInput(input: unknown): Promise<ApiHandlerResult<ApiAdmitInputResponse>>
  queueInput(input: unknown): Promise<ApiHandlerResult<ApiAdmitInputResponse>>
  listQueuedInputs(
    input: unknown,
  ): Promise<ApiHandlerResult<{ items: readonly QueuedInput[] }>>
  updateQueuedInput(
    input: unknown,
  ): Promise<ApiHandlerResult<{ item: QueuedInput }>>
  reorderQueuedInputs(
    input: unknown,
  ): Promise<ApiHandlerResult<{ items: readonly QueuedInput[] }>>
  startQueuedInput(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiAdmitInputResponse>>
  steerInput(input: unknown): Promise<ApiHandlerResult<ApiSteerInputResponse>>
  compactSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiCompactSessionResponse>>
  cancelInput(input: unknown): Promise<ApiHandlerResult<ApiCancelInputResponse>>
  cancelTurn(input: unknown): Promise<ApiHandlerResult<ApiCancelTurnResponse>>
  resolvePermission(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiResolvePermissionResponse>>
  readSessionEvents(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiReadSessionEventsResponse>>
}

export type ThreadServerHandlers = ServerHandlers & {
  close(): Promise<void>
}

const sessionListOrder = "updated_at_desc"
const maxCancelReasonLength = 512

type RolloutPublication = {
  rolloutId: string
  firstUserInputId: string | undefined
  processedThrough: number
  turns: Map<string, { inputItemId: string; accepted: boolean }>
}

// App-server projection over the live Session actor and canonical rollout.
// It translates host DTOs only; execution never reads this projection.
export function createThreadServerHandlers(
  options: ThreadServerHandlerOptions,
): ThreadServerHandlers {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const pumps = new Map<AgentThread, Promise<void>>()
  const pumpReady = new Map<AgentThread, Promise<void>>()
  const publishedThrough = new Map<string, number>()
  const admissionTails = new Map<string, Promise<void>>()
  const pendingInitialDrafts = new Map<string, readonly InputContent[]>()
  const pendingSteerDrafts = new Map<string, readonly InputContent[]>()
  const startingQueuedInputs = new Map<string, InputContent>()
  const inputQueue =
    options.inputQueue ?? new InputQueue(options.inputQueueDatabasePath)
  const queueOptions = { ...options, inputQueue }
  const queuedItems = new QueuedItemService({
    queue: inputQueue,
    isArchived: async (sessionId) =>
      (await options.store.sessionPresentation(sessionId)).archived === true,
    manager: options.manager,
    ...(options.notifyQueueChanged === undefined
      ? {}
      : { notifyChanged: options.notifyQueueChanged }),
    onStarting: (item) =>
      startingQueuedInputs.set(
        `${item.sessionId}\0${item.input.submissionId}`,
        item.input.content,
      ),
    onNotStarted: (item) =>
      startingQueuedInputs.delete(
        `${item.sessionId}\0${item.input.submissionId}`,
      ),
    reporter,
  })
  let closing = false
  let stopPumps: (() => void) | undefined
  const pumpsStopped = new Promise<void>((resolve) => {
    stopPumps = resolve
  })

  async function publishNewRollout(
    threadId: string,
    append: import("../core/thread-store.ts").RolloutAppend,
    publication: RolloutPublication,
  ): Promise<void> {
    // A fork response can publish a replay before this pump consumes its
    // queued receipts. Side effects must still process each receipt once.
    const after = publication.processedThrough
    let records = append.records.filter((record) => {
      const seq = hostSeq(record)
      return seq > after && seq <= append.throughSeq
    })
    // Auxiliary writers or a failed delivery can leave a gap. Replay only
    // then; ordinary Session appends already carry their persisted records.
    const first = records[0]
    if (
      append.throughSeq > after &&
      (first === undefined || hostSeq(first) !== after + 1)
    ) {
      const stored = await options.store.readThread(threadId)
      if (stored === undefined) return
      const replayed = stored.rollout.filter(
        (record) =>
          hostSeq(record) > after && hostSeq(record) <= append.throughSeq,
      )
      // A staged rollout read omits pending Turn records. The append receipt
      // still owns their assigned identities, so retain it when filling gaps.
      records = [
        ...new Map(
          [...replayed, ...records].map((record) => [record.seq, record]),
        ).values(),
      ].sort((left, right) => left.seq - right.seq)
    }
    if (records.length === 0) return
    if (records.some((record, index) => hostSeq(record) !== after + index + 1))
      throw new Error("Rollout publication contains a sequence gap.")
    options.eventHub?.publishDurable(
      records
        .filter(
          (record) => hostSeq(record) > (publishedThrough.get(threadId) ?? 0),
        )
        .map((record) => mapRolloutEvent(record, threadId)),
    )
    const last = records.at(-1)
    if (last !== undefined) {
      publication.processedThrough = hostSeq(last)
      publishedThrough.set(
        threadId,
        Math.max(publishedThrough.get(threadId) ?? 0, hostSeq(last)),
      )
    }
    for (const record of records) {
      recordTurnInput(publication, record.item)
      if (isInitialUserInput(record)) {
        publication.firstUserInputId ??= record.item.item.id
        if (publication.firstUserInputId === record.item.item.id)
          maybeGenerateSessionTitle(threadId, record)
      }
      if (record.item.type === "turn_completed") {
        const requestId = record.item.turnId
        const key = `${threadId}\0${requestId}`
        const draft = pendingInitialDrafts.get(key)
        pendingInitialDrafts.delete(key)
        const queuedContent = startingQueuedInputs.get(key)
        startingQueuedInputs.delete(key)
        const started = publication.turns.get(requestId)
        publication.turns.delete(requestId)
        if (started !== undefined) {
          const accepted = started.accepted
          if (accepted && draft !== undefined)
            for (const content of draft)
              void discardAdmittedDraftAttachments(threadId, requestId, content)
          if (!accepted)
            void discardUnacceptedRequestAttachments(
              threadId,
              publication.rolloutId,
              requestId,
            )
          if (!accepted && queuedContent !== undefined) {
            for (const ownerId of requestAttachmentOwners(queuedContent))
              if (ownerId !== requestId)
                void discardUnacceptedRequestAttachments(
                  threadId,
                  publication.rolloutId,
                  ownerId,
                )
          }
        }
      }
      if (
        record.item.type === "response_item" &&
        record.item.item.id.startsWith("input_") &&
        record.item.item.item.role === "user"
      ) {
        const requestId = record.item.item.turnId
        const key = `${threadId}\0${requestId}`
        const draft = pendingInitialDrafts.get(key)
        if (draft !== undefined) {
          pendingInitialDrafts.delete(key)
          for (const content of draft)
            void discardAdmittedDraftAttachments(threadId, requestId, content)
        }
      }
      if (
        record.item.type !== "response_item" ||
        !record.item.item.id.startsWith("message_") ||
        record.item.item.item.role !== "user"
      )
        continue
      const requestId = record.item.item.turnId
      const key = `${threadId}\0${requestId}`
      const draft = pendingSteerDrafts.get(key)
      if (draft === undefined) continue
      pendingSteerDrafts.delete(key)
      for (const content of draft)
        void discardAdmittedDraftAttachments(threadId, requestId, content)
    }
  }

  // Name an untitled conversation once, from its first user input, when the
  // durable event publishes. The generator re-checks title ownership and
  // never blocks the pump.
  function maybeGenerateSessionTitle(
    threadId: string,
    admitted: StoredRolloutItem & {
      item: Extract<RolloutItem, { type: "response_item" }>
    },
  ) {
    if (options.sessionTitle === undefined) return
    const message = admitted.item.item.item
    if (message.role !== "user") return
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    if (text.trim() === "") return
    const modelSelection = admitted.item.item.submissionMetadata?.modelSelection
    void options.sessionTitle.generate({
      sessionId: threadId,
      text,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    })
  }

  async function ensureEventPump(thread: AgentThread): Promise<void> {
    if (closing) throw new Error("Server handlers are shutting down.")
    const existing = pumpReady.get(thread)
    if (existing !== undefined) {
      await existing
      return
    }
    const ready = (async () => {
      // An evicted actor can still be draining its final events when its
      // replacement is installed. Preserve delivery order across generations.
      for (const [previous, pump] of pumps) {
        if (previous.id === thread.id) await pump
      }
      const stored = await options.store.readThread(thread.id)
      if (!publishedThrough.has(thread.id)) {
        publishedThrough.set(
          thread.id,
          stored === undefined ? 0 : threadSeq(stored),
        )
      }
      const publication = {
        rolloutId: thread.snapshot().metadata.rolloutId,
        firstUserInputId:
          stored?.rollout.find(isInitialUserInput)?.item.item.id,
        processedThrough: publishedThrough.get(thread.id) ?? 0,
        turns: new Map<string, { inputItemId: string; accepted: boolean }>(),
      }
      for (const record of stored?.rollout ?? []) {
        if (hostSeq(record) > (publishedThrough.get(thread.id) ?? 0)) break
        recordTurnInput(publication, record.item)
        if (record.item.type === "turn_completed")
          publication.turns.delete(record.item.turnId)
      }
      const pump = (async () => {
        const streams = new Map<
          string,
          ReturnType<typeof createCoalescingDeltaPublisher>
        >()
        for (;;) {
          const event = await Promise.race([
            thread.nextEvent(),
            pumpsStopped.then(() => undefined),
          ])
          if (event === undefined) break
          if (event.type === "rollout.appended") {
            for (const publisher of streams.values()) publisher.flush()
            try {
              await publishNewRollout(thread.id, event, publication)
            } catch (error) {
              reportOperationalFailure(reporter, {
                component: "thread-event-pump",
                operation: "replay-rollout",
                cause: error,
                sessionId: thread.id,
              })
              // A failed history read must not block runtime terminal events.
              // A later append can catch up from the unchanged durable cursor.
              options.eventHub?.publishTransient({
                type: "session.error",
                sessionId: thread.id,
                operation: "persistence",
                message: `Session history could not be read: ${
                  error instanceof Error
                    ? error.message
                    : "unknown storage error"
                }`,
                createdAt: new Date().toISOString(),
              })
            }
            continue
          }
          if (event.type === "model.stream") {
            const reasoning = event.kind === "reasoning"
            const displayItemId = reasoning
              ? `${event.itemId}_reasoning`
              : event.itemId
            const key = `${event.itemId}:${event.kind}`
            let publisher = streams.get(key)
            if (publisher === undefined) {
              options.eventHub?.publishTransient({
                type: "item.started",
                sessionId: event.threadId,
                turnId: event.turnId,
                item: {
                  type: reasoning ? "reasoning" : "agent_message",
                  itemId: displayItemId,
                },
                createdAt: new Date().toISOString(),
              })
              if (options.eventHub === undefined) continue
              publisher = createCoalescingDeltaPublisher(
                options.eventHub,
                30,
                reasoning ? "reasoning.delta" : "assistant.delta",
              )
              streams.set(key, publisher)
            }
            publisher.publish({
              sessionId: event.threadId,
              turnId: event.turnId,
              itemId: displayItemId,
              delta: event.delta,
            })
            continue
          }
          if (event.type === "item.started") {
            options.eventHub?.publishTransient({
              type: "item.started",
              sessionId: event.threadId,
              turnId: event.turnId,
              item: event.item,
              createdAt: new Date().toISOString(),
            })
            continue
          }
          if (event.type === "permission") {
            options.eventHub?.publishTransient(event.event)
            continue
          }
          if (
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.interrupted"
          ) {
            for (const publisher of streams.values()) publisher.flush()
            streams.clear()
            // Runtime completion remains deliverable when its rollout append
            // or flush failed. Only persisted records advance durable history.
            options.eventHub?.publishTransient({
              type: "turn.finished",
              sessionId: event.threadId,
              turnId: event.input.submissionId,
              outcome:
                event.type === "turn.failed"
                  ? { status: "failed", error: event.error }
                  : event.type === "turn.interrupted"
                    ? {
                        status: "interrupted",
                        ...(event.reason === undefined
                          ? {}
                          : { reason: event.reason }),
                      }
                    : { status: "completed", ...event.completion },
              createdAt: new Date().toISOString(),
            })
            if (event.type === "turn.completed") {
              const snapshot = thread.snapshot()
              const agent = snapshot.metadata.metadata?.agent
              const subagent =
                typeof agent === "object" &&
                agent !== null &&
                !Array.isArray(agent) &&
                "kind" in agent &&
                agent.kind === "subagent"
              if (
                !subagent &&
                options.goals?.read(event.threadId)?.status !== "active" &&
                (snapshot.activeTurnId === undefined ||
                  snapshot.activeTurnId === event.input.submissionId)
              ) {
                options.onRootTurnCompleted?.({
                  sessionId: event.threadId,
                  turnId: event.input.submissionId,
                  ...(snapshot.metadata.title === undefined
                    ? {}
                    : { title: snapshot.metadata.title }),
                })
              }
            }
            continue
          }
          if (event.type === "session.error") {
            options.eventHub?.publishTransient({
              type: "session.error",
              sessionId: event.threadId,
              operation: event.operation,
              message: event.message,
              createdAt: new Date().toISOString(),
            })
            continue
          }
          if (event.type === "runtime.warning") {
            if (event.code === "model.retry") {
              // Flush before discard so a coalesced delta cannot revive output
              // from the failed attempt after the retry starts.
              for (const publisher of streams.values()) publisher.flush()
              const itemIds = event.details?.discardedResponseItemIds
              const discarded = Array.isArray(itemIds)
                ? itemIds.filter((id): id is string => typeof id === "string")
                : []
              for (const itemId of discarded) {
                for (const kind of ["assistant", "reasoning"] as const) {
                  streams.delete(`${itemId}:${kind}`)
                  options.eventHub?.publishTransient({
                    type: "item.discarded",
                    sessionId: event.threadId,
                    turnId: event.turnId,
                    itemId:
                      kind === "reasoning" ? `${itemId}_reasoning` : itemId,
                    createdAt: new Date().toISOString(),
                  })
                }
              }
            }
            options.eventHub?.publishTransient({
              type: "runtime.warning",
              sessionId: event.threadId,
              turnId: event.turnId,
              message: event.message,
              ...(event.code === undefined ? {} : { code: event.code }),
              ...(event.details === undefined
                ? {}
                : { details: event.details }),
              createdAt: new Date().toISOString(),
            })
          }
        }
        for (const publisher of streams.values()) publisher.flush()
      })()
      pump
        .catch((error) => {
          reportOperationalFailure(reporter, {
            component: "thread-event-pump",
            operation: "deliver",
            cause: error,
            sessionId: thread.id,
          })
        })
        .finally(() => {
          pumps.delete(thread)
          pumpReady.delete(thread)
        })
      pumps.set(thread, pump)
      queuedItems.install(thread)
      options.goals?.install(thread, async () => {
        if (closing || inputQueue.list(thread.id).length > 0) return false
        const presentation = await options.store.sessionPresentation(thread.id)
        if (presentation.archived) return false
        const agent = thread.snapshot().metadata.metadata?.agent
        const subagent =
          typeof agent === "object" &&
          agent !== null &&
          "kind" in agent &&
          agent.kind === "subagent"
        // Historical edit heads have no navigation entry. They must not keep
        // pursuing an inherited goal after the visible conversation moves on.
        return (
          (subagent || presentation.navigationId !== undefined) &&
          inputQueue.list(thread.id).length === 0 &&
          ![...admissionTails.keys()].some((key) =>
            key.startsWith(`${thread.id}\0`),
          )
        )
      })
    })()
    pumpReady.set(thread, ready)
    try {
      await ready
    } catch (error) {
      pumpReady.delete(thread)
      throw error
    }
  }

  async function resumeRequired(threadId: string): Promise<AgentThread> {
    const thread = await options.manager.resumeThread(threadId)
    if (thread === undefined) {
      throw notFound(`Session ${threadId} was not found.`, {
        sessionId: threadId,
      })
    }
    await ensureEventPump(thread)
    return thread
  }

  async function withAdmissionLock<T>(
    sessionId: string,
    requestId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = `${sessionId}\0${requestId}`
    const previous = admissionTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    admissionTails.set(key, tail)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (admissionTails.get(key) === tail) admissionTails.delete(key)
      options.goals?.wake(sessionId)
    }
  }

  type PromotedContent = {
    readonly content: InputContent
    readonly rollback: (() => Promise<void>) | undefined
  }

  const promoteRequestAttachments = async (
    rolloutId: string,
    requestId: string,
    content: InputContent,
  ): Promise<PromotedContent> => {
    const attachments = inputContentAttachments(content)
    if (
      attachments.length === 0 ||
      attachments.every((attachment) => "url" in attachment.file)
    ) {
      return { content, rollback: undefined }
    }
    if (options.rolloutAssets === undefined) {
      throw invalidInput("Attachments require rollout asset storage.")
    }
    try {
      const allStagedInSession = attachments.every(
        (attachment) =>
          "url" in attachment.file ||
          (attachment.file.rolloutId === rolloutId &&
            attachment.file.path.startsWith("attachments/staging/")),
      )
      const promotion = allStagedInSession
        ? await options.rolloutAssets.promoteAttachments(
            rolloutId,
            requestId,
            attachments,
          )
        : await options.rolloutAssets.copyAttachments(
            rolloutId,
            requestId,
            attachments,
          )
      return {
        content: replaceInputAttachments(content, promotion.attachments),
        rollback: promotion.rollback,
      }
    } catch (error) {
      if (error instanceof AttachmentConflictError) {
        throw conflict("Input was not submitted: request_conflict.", {
          reason: "request_conflict",
        })
      }
      throw error
    }
  }

  const discardAdmittedDraftAttachments = async (
    sessionId: string,
    requestId: string,
    content: InputContent,
  ) => {
    const drafts = inputContentAttachments(content).filter(
      (attachment) =>
        !("url" in attachment.file) &&
        ("url" in attachment.file ||
          attachment.file.path.startsWith("attachments/staging/")),
    )
    if (drafts.length === 0) return
    try {
      await options.rolloutAssets?.discardDraftAttachments(drafts)
      options.releaseDraftRolloutAssets?.(
        drafts.flatMap((attachment) =>
          "url" in attachment.file ? [] : [attachment.file.rolloutId],
        ),
      )
    } catch (error) {
      reportOperationalFailure(reporter, {
        component: "thread-handlers",
        operation: "discard-admitted-draft-attachments",
        cause: error,
        sessionId,
        turnId: requestId,
      })
    }
  }

  const discardUnacceptedRequestAttachments = async (
    sessionId: string,
    rolloutId: string,
    requestId: string,
  ) => {
    try {
      await options.rolloutAssets?.discardRequestAttachments(
        rolloutId,
        requestId,
      )
    } catch (error) {
      reportOperationalFailure(reporter, {
        component: "thread-handlers",
        operation: "discard-unaccepted-request-attachments",
        cause: error,
        sessionId,
        turnId: requestId,
      })
    }
  }

  // Direct input enters the rollout only when the Turn accepts it.
  const admitTurnInput = async (
    request: ReturnType<typeof requireAdmitInputRequest>,
    submit: (
      thread: AgentThread,
      content: InputContent,
    ) => Promise<TurnInputSubmission>,
  ) => {
    if ((await options.store.sessionPresentation(request.sessionId)).archived)
      throw conflict("Restore this conversation before sending a message.")
    requireAvailableProvider(
      request.modelSelection?.provider,
      options.availableProviders,
    )
    return await withAdmissionLock(
      request.sessionId,
      request.requestId,
      async () => {
        const thread = await resumeRequired(request.sessionId)
        const rolloutId = thread.snapshot().metadata.rolloutId
        const promoted = await promoteRequestAttachments(
          rolloutId,
          request.requestId,
          request.content,
        )
        const content = promoted.content
        let rollbackPromotion = promoted.rollback
        // Session may have appended an admission even when its durability
        // fence failed. Keep promoted files for a retry with the same request
        // ID; deleting them would leave a durable queued attachment dangling.
        const draftKey = `${request.sessionId}\0${request.requestId}`
        const submitted = await submit(thread, content)
        if (submitted.type === "not_submitted") {
          await rollbackPromotion?.()
          throw conflict(`Input was not submitted: ${submitted.reason}.`, {
            reason: submitted.reason,
          })
        }
        if (submitted.type === "steered") {
          throw internalError("Admission unexpectedly returned steering.")
        }
        const hasAttachments =
          inputContentAttachments(request.content).length !== 0
        if (hasAttachments)
          pendingInitialDrafts.set(draftKey, [
            ...(pendingInitialDrafts.get(draftKey) ?? []),
            request.content,
          ])
        // A fast Turn can publish before draft tracking is installed. Reading
        // after acceptance also covers retries after the original cleanup event.
        if (submitted.type === "replayed" || hasAttachments) {
          const stored = await options.store.readThread(request.sessionId)
          const accepted = stored?.rollout.some(
            ({ item }) =>
              item.type === "response_item" &&
              item.item.id === submitted.inputItemId,
          )
          const completed = stored?.rollout.some(
            ({ item }) =>
              item.type === "turn_completed" &&
              item.turnId === submitted.turnId,
          )
          const drafts = pendingInitialDrafts.get(draftKey) ?? []
          if (accepted || completed) pendingInitialDrafts.delete(draftKey)
          if (accepted)
            for (const draft of drafts)
              await discardAdmittedDraftAttachments(
                request.sessionId,
                request.requestId,
                draft,
              )
          if (completed && !accepted) {
            await rollbackPromotion?.()
            await discardUnacceptedRequestAttachments(
              request.sessionId,
              rolloutId,
              request.requestId,
            )
          }
        }
        rollbackPromotion = undefined
        return ok(submitted.type === "replayed" ? 200 : 201, {
          requestId: request.requestId,
          turnId: submitted.turnId,
          inputId: submitted.inputItemId,
          content,
        })
      },
    )
  }

  const unsubscribeThreadInstalled =
    options.manager.subscribeThreadInstalled(ensureEventPump)

  return {
    async close() {
      closing = true
      unsubscribeThreadInstalled()
      await queuedItems.close()
      stopPumps?.()
      await Promise.allSettled([...admissionTails.values()])
      await Promise.allSettled([...pumpReady.values()])
      await Promise.allSettled([...pumps.values()])
      if (options.inputQueue === undefined) inputQueue.close()
    },
    async createSession(input = {}) {
      try {
        const request = await applySessionCreateDefaults(
          requireCreateSessionRequest(input),
          options.sessionDefaults,
        )
        if (request.projectId !== undefined) {
          const project = await options.projectStore?.readProject(
            request.projectId,
          )
          if (project === undefined) {
            throw invalidInput("projectId must name an existing project.", {
              field: "projectId",
            })
          }
        }
        const gitInfo =
          request.workingDirectory === undefined
            ? undefined
            : await readWorkspaceGitInfo({
                cwd: request.workingDirectory,
              }).catch(() => undefined)
        const thread = await options.manager.createThread({
          ...request,
          ...(gitInfo === undefined ? {} : { gitInfo }),
          ...(request.parentSessionId === undefined
            ? {}
            : { parentThreadId: request.parentSessionId }),
        })
        await ensureEventPump(thread)
        const stored = await requireStoredThread(options.store, thread.id)
        const metadataRecord = stored.rollout[0]
        if (metadataRecord === undefined) {
          throw internalError("Created Thread contained an empty rollout.")
        }
        const event = mapRolloutEvent(metadataRecord, thread.id)
        if (!isKernelEvent(event)) {
          throw internalError(
            "Created Thread did not contain Session metadata.",
          )
        }
        publishedThrough.set(thread.id, event.seq)
        options.eventHub?.publishDurable([event])
        return ok(201, {
          session: await mapStoredThread(stored, thread, queueOptions),
          event,
        })
      } catch (error) {
        return fail(error, reporter, "create-session")
      }
    },

    async readSidebar() {
      try {
        return ok(200, await options.store.readSessionSidebar())
      } catch (error) {
        return fail(error, reporter, "read-sidebar")
      }
    },
    async updateSidebar(input) {
      try {
        const change = parseSidebarChange(input)
        if (change.type === "session" && change.archived !== undefined) {
          // Queue dispatch and archive transitions share admission ownership.
          // Otherwise a queued start could race the idle check and run hidden.
          return await queuedItems.withLock(change.sessionId, async () => {
            if (
              change.archived === true &&
              options.manager.getThread(change.sessionId)?.snapshot()
                .activeTurnId !== undefined
            )
              throw conflict(
                "Wait for the active turn to finish before archiving.",
              )
            return ok(200, await options.store.updateSessionSidebar(change))
          })
        }
        return ok(200, await options.store.updateSessionSidebar(change))
      } catch (error) {
        return fail(error, reporter, "update-sidebar")
      }
    },

    async readUsage() {
      try {
        return ok(200, { usage: await options.store.readUsageSummary() })
      } catch (error) {
        return fail(error, reporter, "read-usage")
      }
    },

    async listSessions(input = {}) {
      try {
        const request = requireListSessionsRequest(input)
        if (request.projectId !== undefined) {
          const project = await options.projectStore?.readProject(
            request.projectId,
          )
          if (project === undefined) {
            // Orphan-on-delete at the read path: a filter naming a deleted (or
            // never known) project matches nothing, since orphaned Sessions
            // read as having no project.
            return ok(200, { sessions: [] })
          }
        }
        const result = await options.manager.listThreads({
          view: "sessions",
          archived: request.archived,
          ...(request.sectionId === undefined
            ? {}
            : { sectionId: request.sectionId }),
          limit: request.limit,
          ...(request.workingDirectory === undefined
            ? {}
            : { workingDirectory: request.workingDirectory }),
          ...(request.projectId === undefined
            ? {}
            : { projectId: request.projectId }),
          ...(request.cursor === undefined
            ? {}
            : {
                cursor: decodeSessionListCursor(
                  request.cursor,
                  request.limit,
                  request.workingDirectory,
                  request.projectId,
                  request.archived,
                  request.sectionId,
                ),
              }),
        })
        const liveProjects = await liveProjectIds(options, result.threads)
        return ok(200, {
          sessions: result.threads.map((thread) => {
            const summary = mapThreadSummary(
              thread,
              liveProjects,
              options.goals?.read(thread.id),
            )
            return options.manager.getThread(thread.id)?.snapshot()
              .activeTurnId === undefined
              ? summary
              : { ...summary, active: true }
          }),
          ...(result.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeSessionListCursor(
                  result.nextCursor,
                  request.limit,
                  request.workingDirectory,
                  request.projectId,
                  request.archived,
                  request.sectionId,
                ),
              }),
        })
      } catch (error) {
        return fail(error, reporter, "list-sessions")
      }
    },

    async searchSessions(input = {}) {
      try {
        const request = requireSearchSessionsRequest(input)
        const storeCursor =
          request.cursor === undefined
            ? undefined
            : decodeSearchCursor(
                request.cursor,
                request.archived ? "archived-sessions" : "sessions",
                request.searchTerm,
                request.limit,
              )
        const result = await options.store.searchThreads({
          view: "sessions",
          archived: request.archived,
          searchTerm: request.searchTerm,
          limit: request.limit,
          ...(storeCursor === undefined ? {} : { cursor: storeCursor }),
        })
        const liveProjects = await liveProjectIds(
          options,
          result.matches.map(({ summary }) => summary),
        )
        return ok(200, {
          data: result.matches.map(({ summary, snippet }) => ({
            session: mapThreadSummary(
              summary,
              liveProjects,
              options.goals?.read(summary.id),
            ),
            snippet,
          })),
          ...(result.unavailableThreadCount === undefined
            ? {}
            : { unavailableSessionCount: result.unavailableThreadCount }),
          ...(result.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeSearchCursor(
                  request.archived ? "archived-sessions" : "sessions",
                  request.searchTerm,
                  request.limit,
                  result.nextCursor,
                ),
              }),
        })
      } catch (error) {
        return fail(error, reporter, "search-sessions")
      }
    },

    async searchSessionOccurrences(input) {
      try {
        const request = requireSearchSessionOccurrencesRequest(input)
        const storeCursor =
          request.cursor === undefined
            ? undefined
            : decodeSearchCursor(
                request.cursor,
                `session-occurrences:${request.sessionId}`,
                request.searchTerm,
                request.limit,
              )
        const result = await options.store.searchThreadOccurrences({
          threadId: request.sessionId,
          searchTerm: request.searchTerm,
          limit: request.limit,
          ...(storeCursor === undefined ? {} : { cursor: storeCursor }),
        })
        if (result === undefined) {
          throw notFound(`Session ${request.sessionId} was not found.`, {
            sessionId: request.sessionId,
          })
        }
        return ok(200, {
          data: result.occurrences,
          ...(result.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeSearchCursor(
                  `session-occurrences:${request.sessionId}`,
                  request.searchTerm,
                  request.limit,
                  result.nextCursor,
                ),
              }),
        })
      } catch (error) {
        return fail(error, reporter, "search-session-occurrences")
      }
    },

    async readGoal(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        await requireStoredThread(options.store, sessionId)
        return ok(200, { goal: options.goals?.read(sessionId) ?? null })
      } catch (error) {
        return fail(error, reporter, "read-goal")
      }
    },

    async setGoal(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        const stored = await requireStoredThread(options.store, sessionId)
        if (options.goals === undefined)
          throw conflict("Goals are unavailable.")
        const value = input as Record<string, unknown>
        if (
          Object.keys(value).some(
            (key) =>
              ![
                "sessionId",
                "objective",
                "status",
                "tokenBudget",
                "inputId",
              ].includes(key),
          )
        )
          throw invalidInput("Unexpected goal field.")
        if (
          value.objective !== undefined &&
          (typeof value.objective !== "string" || !value.objective.trim())
        )
          throw invalidInput("objective must be nonempty text.")
        if (value.status !== undefined && !isGoalStatus(value.status))
          throw invalidInput("Invalid goal status.")
        if (
          value.tokenBudget !== undefined &&
          value.tokenBudget !== null &&
          (typeof value.tokenBudget !== "number" ||
            !Number.isSafeInteger(value.tokenBudget) ||
            value.tokenBudget <= 0)
        )
          throw invalidInput(
            "tokenBudget must be a positive safe integer or null.",
          )
        if (
          value.inputId !== undefined &&
          value.inputId !== null &&
          (typeof value.inputId !== "string" || !value.inputId)
        )
          throw invalidInput("inputId must be a nonempty string or null.")
        const change: SetGoalInput = {
          ...(typeof value.objective === "string"
            ? { objective: value.objective.trim() }
            : {}),
          ...(isGoalStatus(value.status) ? { status: value.status } : {}),
          ...(value.tokenBudget === null ||
          typeof value.tokenBudget === "number"
            ? { tokenBudget: value.tokenBudget }
            : {}),
          ...(value.inputId === null || typeof value.inputId === "string"
            ? { inputId: value.inputId }
            : {}),
        }
        const desiredStatus =
          change.status ?? options.goals.read(sessionId)?.status ?? "active"
        if (
          desiredStatus === "active" &&
          (await options.store.sessionPresentation(sessionId)).archived
        )
          throw conflict("Restore this conversation before starting a goal.")
        const lastContext = stored.rollout
          .filter(({ item }) => item.type === "turn_context")
          .at(-1)?.item
        const configuration =
          options.manager.getThread(sessionId)?.snapshot().configuration ??
          (lastContext?.type === "turn_context"
            ? lastContext.context.configuration
            : undefined)
        const enabledTools = configuration?.enabledTools
        if (
          desiredStatus === "active" &&
          enabledTools !== undefined &&
          !enabledTools.includes("update_goal")
        )
          throw conflict(
            "Goal tools are unavailable in this session's tool configuration. Start a new session to pursue a goal.",
          )
        // A goal can be meaningful before the first user Turn. Persist its
        // owning thread before writing the independent goal database.
        await options.store.persistThread(sessionId, PersistContext.GoalSet)
        const goal = options.goals.set(sessionId, change)
        if (goal.status === "active") {
          await resumeRequired(sessionId)
          options.goals.wake(sessionId)
        }
        return ok(200, { goal })
      } catch (error) {
        return fail(error, reporter, "set-goal")
      }
    },

    async clearGoal(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        await requireStoredThread(options.store, sessionId)
        options.goals?.clear(sessionId)
        return ok(200, { goal: null })
      } catch (error) {
        return fail(error, reporter, "clear-goal")
      }
    },

    async readSession(input) {
      try {
        const { sessionId } = requireReadSessionRequest(input)
        const live = options.manager.getThread(sessionId)
        // Spawned children bypass handler admission. Attach their one event
        // consumer before the subscription snapshot establishes its watermark.
        if (live !== undefined) await ensureEventPump(live)
        const stored = await options.store.readThread(sessionId)
        if (stored === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        return ok(200, {
          session: await mapStoredThread(stored, live, queueOptions),
        })
      } catch (error) {
        return fail(error, reporter, "read-session")
      }
    },

    async listAgents(input) {
      try {
        const { sessionId } = requireReadSessionRequest(input)
        const stored = await options.store.readThread(sessionId)
        if (stored === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        return ok(200, {
          agents: (await options.listAgents?.(stored)) ?? [],
        })
      } catch (error) {
        return fail(error, reporter, "list-agents")
      }
    },

    async listSkills(input) {
      try {
        const { sessionId } = requireReadSessionRequest(input)
        const stored = await options.store.readThread(sessionId)
        if (stored === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        if (options.listSessionSkills === undefined) {
          return ok(200, { skills: [] })
        }
        const workingDirectory =
          stored.metadata.workingDirectory ??
          options.sessionDefaults?.workingDirectory
        if (workingDirectory === undefined) return ok(200, { skills: [] })
        const discovered = await options.listSessionSkills({
          sessionId,
          workingDirectory,
          ...(stored.metadata.projectId === undefined
            ? {}
            : { projectId: stored.metadata.projectId }),
        })
        return ok(200, {
          skills: discovered
            .filter((skill) => skill.enabled !== false)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              path: skill.path,
              scope: skill.scope,
            })),
        })
      } catch (error) {
        return fail(error, reporter, "list-skills")
      }
    },

    async deleteSession(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        if ((await options.store.readThread(sessionId)) === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        if (
          (await options.store.sessionPresentation(sessionId)).navigationId !==
            undefined &&
          (await options.store.listThreadIds()).includes(sessionId)
        ) {
          // Keep an explicit head while deleting, so retained edit history can
          // never reappear as an unrelated conversation after the head is gone.
          await options.store.setSessionHead(sessionId, sessionId)
        }
        await queuedItems.withLock(sessionId, async () => {
          await (options.discardThread?.(sessionId) ??
            options.manager.discardThread(sessionId))
          queuedItems.deleteSession(sessionId)
        })
        options.goals?.clear(sessionId)
        publishedThrough.delete(sessionId)
        return ok(200, { sessionId })
      } catch (error) {
        return fail(error, reporter, "delete-session")
      }
    },

    async closeSession(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        if (!(await options.manager.closeThread(sessionId))) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        return ok(200, { sessionId })
      } catch (error) {
        return fail(error, reporter, "close-session")
      }
    },

    async forkSession(input) {
      try {
        const request = requireForkSessionRequest(
          input,
          options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        )
        if (
          (await options.store.sessionPresentation(request.sessionId)).archived
        )
          throw conflict("Restore this conversation before sending a message.")
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const source = await requireStoredThread(
          options.store,
          request.sessionId,
        )
        const beforeTurnId = turnIdForInput(source, request.atInputId)
        const sourceInput = source.rollout.find(
          ({ item }) =>
            item.type === "response_item" && item.item.id === request.atInputId,
        )?.item
        let forkContent: InputContent | undefined
        if (request.content !== undefined) {
          if (
            sourceInput?.type !== "response_item" ||
            sourceInput.item.item.role !== "user"
          )
            throw invalidInput("Fork input must be a user message.")
          const sourceContent = modelUserInputContent(sourceInput.item.item)
          const sourceAttachments = inputContentAttachments(sourceContent)
          forkContent = {
            ...request.content,
            ...(request.content.references === undefined &&
            sourceContent.references !== undefined
              ? { references: sourceContent.references }
              : {}),
          }
          for (const attachment of inputContentAttachments(forkContent)) {
            if (
              !sourceAttachments.some(
                (original) =>
                  assetSourceKey(original.file) ===
                    assetSourceKey(attachment.file) &&
                  original.name === attachment.name &&
                  original.mediaType === attachment.mediaType &&
                  original.sizeBytes === attachment.sizeBytes,
              )
            )
              throw invalidInput(
                "Fork attachments must reference attachments from the edited source input.",
              )
          }
        }
        await options.store.setSessionHead(request.sessionId, request.sessionId)
        const previouslyDeferred =
          options.goals?.deferContinuation(request.sessionId, true) ?? false
        let forked: Awaited<ReturnType<ThreadManager["forkThread"]>>
        try {
          forked = await options.manager.forkThread({
            sourceThreadId: request.sessionId,
            beforeTurnId,
            forkedFromInputId: request.atInputId,
            forkReason: request.reason,
          })
        } catch (error) {
          options.goals?.deferContinuation(
            request.sessionId,
            previouslyDeferred,
          )
          throw error
        }
        const forkRolloutId = forked.thread.snapshot().metadata.rolloutId
        let submissionId: string | undefined
        try {
          options.goals?.fork(request.sessionId, forked.thread.id)
          await ensureEventPump(forked.thread)
          if (forkContent !== undefined) {
            submissionId = createRequestId()
            const attachments = inputContentAttachments(forkContent)
            const copied =
              attachments.length === 0
                ? undefined
                : await requireRolloutAssets(options).copyAttachments(
                    forkRolloutId,
                    submissionId,
                    attachments,
                  )
            const submitted = await forked.thread.startIfIdle({
              submissionId,
              content:
                copied === undefined
                  ? forkContent
                  : replaceInputAttachments(forkContent, copied.attachments),
              ...(request.modelSelection === undefined
                ? {}
                : { modelSelection: request.modelSelection }),
            })
            if (submitted.type !== "started") {
              await options.rolloutAssets?.discardRequestAttachments(
                forkRolloutId,
                submissionId,
              )
              throw conflict(`Fork input was not started: ${submitted.type}.`)
            }
          }
          await options.store.flushThread(forked.thread.id)
          await options.store.setSessionHead(
            request.sessionId,
            forked.thread.id,
          )
        } catch (error) {
          try {
            await options.manager.discardThread(forked.thread.id)
            options.goals?.clear(forked.thread.id)
          } catch (cleanupError) {
            reportOperationalFailure(reporter, {
              component: "thread-handlers",
              operation: "rollback-fork",
              cause: cleanupError,
              sessionId: forked.thread.id,
            })
          }
          options.goals?.deferContinuation(
            request.sessionId,
            previouslyDeferred,
          )
          throw error
        }
        const stored = await requireStoredThread(
          options.store,
          forked.thread.id,
        )
        const events = stored.rollout.map((record) =>
          mapRolloutEvent(record, forked.thread.id),
        )
        publishedThrough.set(forked.thread.id, threadSeq(stored))
        options.eventHub?.publishDurable(events)
        return ok(201, {
          session: await mapStoredThread(stored, forked.thread, queueOptions),
          historyEndSeqExclusive:
            (forked.result.historyEndSeqExclusive ?? 1) + 1,
          events,
        })
      } catch (error) {
        return fail(error, reporter, "fork-session")
      }
    },

    async admitInput(input) {
      try {
        const request = requireAdmitInputRequest(
          input,
          options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        )
        if (request.role !== undefined && request.role !== InputRole.User) {
          throw invalidInput(
            "Only user input can be submitted to a live Session.",
            {
              field: "role",
            },
          )
        }
        return await admitTurnInput(request, (thread, content) =>
          thread.startIfIdle({
            submissionId: request.requestId,
            content,
            ...(request.modelSelection === undefined
              ? {}
              : { modelSelection: request.modelSelection }),
            ...(request.metadata === undefined
              ? {}
              : { metadata: request.metadata }),
            ...(request.parentInputId === undefined
              ? {}
              : { parentInputId: request.parentInputId }),
          }),
        )
      } catch (error) {
        return fail(error, reporter, "admit-input")
      }
    },

    // Queue storage owns the input until the core accepts a Turn start. It is
    // editable while waiting and independent of replay.
    async queueInput(input) {
      try {
        const request = requireAdmitInputRequest(
          input,
          options.maxInputBytes ?? MAX_QUEUED_INPUT_TEXT_BYTES,
          options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        )
        if (request.role !== undefined && request.role !== InputRole.User)
          throw invalidInput("Only user input can be queued.")
        if (
          (await options.store.sessionPresentation(request.sessionId)).archived
        )
          throw conflict("Restore this conversation before sending a message.")
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const item = await queuedItems.withLock(request.sessionId, async () => {
          const stored = await requireStoredThread(
            options.store,
            request.sessionId,
          )
          const existing = queuedItems.getByRequest(
            request.sessionId,
            request.requestId,
          )
          if (existing !== undefined) {
            const retry = await promoteRequestAttachments(
              stored.metadata.rolloutId,
              request.requestId,
              request.content,
            )
            try {
              if (
                fingerprintInputAdmission({
                  role: InputRole.User,
                  content: existing.input.content,
                  modelSelection: existing.input.modelSelection,
                  metadata: existing.input.metadata,
                  parentInputId: existing.input.parentInputId,
                }) !==
                fingerprintInputAdmission({
                  role: InputRole.User,
                  content: retry.content,
                  modelSelection: request.modelSelection,
                  metadata: request.metadata,
                  parentInputId: request.parentInputId,
                })
              )
                throw conflict("Input was not queued: request_conflict.")
            } catch (error) {
              await retry.rollback?.()
              throw error
            }
            await discardAdmittedDraftAttachments(
              request.sessionId,
              request.requestId,
              request.content,
            )
            return existing
          }
          const rolloutId = stored.metadata.rolloutId
          const promoted = await promoteRequestAttachments(
            rolloutId,
            request.requestId,
            request.content,
          )
          const turnInput: TurnInput = {
            submissionId: request.requestId,
            content: promoted.content,
            ...(request.modelSelection === undefined
              ? {}
              : { modelSelection: request.modelSelection }),
            ...(request.metadata === undefined
              ? {}
              : { metadata: request.metadata }),
            ...(request.parentInputId === undefined
              ? {}
              : { parentInputId: request.parentInputId }),
          }
          try {
            const queued = queuedItems.enqueue(request.sessionId, turnInput)
            await discardAdmittedDraftAttachments(
              request.sessionId,
              request.requestId,
              request.content,
            )
            return queued
          } catch (error) {
            await promoted.rollback?.()
            throw error
          }
        })
        queuedItems.wake(request.sessionId)
        return ok(201, {
          requestId: request.requestId,
          turnId: request.requestId,
          inputId: item.id,
          content: item.input.content,
        })
      } catch (error) {
        return fail(
          error instanceof InputQueueFullError ||
            error instanceof QueuedInputTooLargeError
            ? invalidInput(error.message)
            : error,
          reporter,
          "queue-input",
        )
      }
    },

    async listQueuedInputs(input) {
      try {
        const { sessionId } = requireReadSessionRequest(input)
        await requireStoredThread(options.store, sessionId)
        return ok(200, { items: queuedItems.list(sessionId) })
      } catch (error) {
        return fail(error, reporter, "list-queued-inputs")
      }
    },

    async updateQueuedInput(input) {
      try {
        const record = requireRecord(input, "Queue update must be an object.")
        const inputId = requireInputId(record.inputId, "inputId")
        const request = requireAdmitInputRequest(
          input,
          options.maxInputBytes ?? MAX_QUEUED_INPUT_TEXT_BYTES,
          options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        )
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const item = await queuedItems.withLock(request.sessionId, async () => {
          const existing = queuedItems.get(request.sessionId, inputId)
          if (existing === undefined)
            throw notFound("Queued input was not found.")
          const stored = await requireStoredThread(
            options.store,
            request.sessionId,
          )
          const rolloutId = stored.metadata.rolloutId
          const sameAttachments =
            JSON.stringify(inputContentAttachments(request.content)) ===
            JSON.stringify(inputContentAttachments(existing.input.content))
          if (
            !sameAttachments &&
            request.requestId === existing.input.submissionId
          )
            throw invalidInput("Attachment edits require a new requestId.")
          if (
            !sameAttachments &&
            queuedItems.getByRequest(request.sessionId, request.requestId) !==
              undefined
          )
            throw conflict("Attachment owner is already used by queued input.")
          const promoted = sameAttachments
            ? { content: request.content, rollback: undefined }
            : await promoteRequestAttachments(
                rolloutId,
                request.requestId,
                request.content,
              )
          const updatedInput: TurnInput = {
            ...existing.input,
            content: promoted.content,
            ...(request.modelSelection === undefined
              ? {}
              : { modelSelection: request.modelSelection }),
          }
          try {
            const updated = queuedItems.update(
              request.sessionId,
              inputId,
              updatedInput,
            )
            if (updated === undefined)
              throw notFound("Queued input was not found.")
            await discardAdmittedDraftAttachments(
              request.sessionId,
              request.requestId,
              request.content,
            )
            if (!sameAttachments) {
              for (const ownerId of requestAttachmentOwners(
                existing.input.content,
              ))
                await discardUnacceptedRequestAttachments(
                  request.sessionId,
                  rolloutId,
                  ownerId,
                )
            }
            return updated
          } catch (error) {
            await promoted.rollback?.()
            throw error
          }
        })
        return ok(200, { item })
      } catch (error) {
        return fail(
          error instanceof QueuedInputTooLargeError
            ? invalidInput(error.message)
            : error,
          reporter,
          "update-queued-input",
        )
      }
    },

    async reorderQueuedInputs(input) {
      try {
        const record = requireRecord(input, "Queue reorder must be an object.")
        const sessionId = requireSessionId(record.sessionId, "sessionId")
        if (
          !Array.isArray(record.inputIds) ||
          !record.inputIds.every((id) => typeof id === "string")
        )
          throw invalidInput("inputIds must be an array of input IDs.")
        const inputIds = record.inputIds as string[]
        const items = await queuedItems.withLock(sessionId, async () => {
          const currentIds = queuedItems.list(sessionId).map((item) => item.id)
          if (
            currentIds.length !== inputIds.length ||
            new Set(inputIds).size !== currentIds.length ||
            inputIds.some((id) => !currentIds.includes(id))
          )
            throw invalidInput(
              "Reorder must include every queued input exactly once.",
            )
          return queuedItems.reorder(sessionId, inputIds)
        })
        return ok(200, { items })
      } catch (error) {
        return fail(error, reporter, "reorder-queued-inputs")
      }
    },

    async startQueuedInput(input) {
      try {
        const record = requireRecord(input, "Queue start must be an object.")
        const sessionId = requireSessionId(record.sessionId, "sessionId")
        const inputId =
          record.inputId === undefined
            ? undefined
            : requireInputId(record.inputId, "inputId")
        const result = await queuedItems.withLock(sessionId, async () => {
          const item =
            inputId === undefined
              ? queuedItems.list(sessionId)[0]
              : queuedItems.get(sessionId, inputId)
          if (item === undefined) throw notFound("Queued input was not found.")
          const thread = options.manager.getThread(sessionId)
          if (thread === undefined)
            throw conflict(
              "Resume this conversation before starting queued input.",
            )
          const submission = await queuedItems.start(thread, item)
          if (submission.type === "not_submitted")
            throw conflict(
              `Queued input was not started: ${submission.reason}.`,
            )
          if (submission.type !== "started" && submission.type !== "replayed")
            throw internalError("Queue start returned an unexpected result.")
          return { item, submission }
        })
        return ok(200, {
          requestId: result.item.input.submissionId,
          turnId: result.submission.turnId,
          inputId: result.submission.inputItemId,
          content: result.item.input.content,
        })
      } catch (error) {
        return fail(
          error instanceof QueuedSessionArchivedError
            ? conflict(error.message)
            : error,
          reporter,
          "start-queued-input",
        )
      }
    },

    // Steering injects input into an already-running Turn (Codex turn/steer).
    // Unlike session/input, acceptance is ephemeral: the input becomes durable
    // when the Turn records it at its next sampling point, so the response
    // carries the steered Turn id rather than a durable input event.
    async steerInput(input) {
      try {
        const request = requireSteerInputRequest(
          input,
          options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        )
        if (
          (await options.store.sessionPresentation(request.sessionId)).archived
        )
          throw conflict("Restore this conversation before sending a message.")
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const thread = await resumeRequired(request.sessionId)
        const rolloutId = thread.snapshot().metadata.rolloutId
        const promoted = await promoteRequestAttachments(
          rolloutId,
          request.requestId,
          request.content,
        )
        const steerKey = `${request.sessionId}\0${request.requestId}`
        const submitted = await thread
          .steer(
            {
              submissionId: request.requestId,
              content: promoted.content,
              ...(request.modelSelection === undefined
                ? {}
                : { modelSelection: request.modelSelection }),
              ...(request.metadata === undefined
                ? {}
                : { metadata: request.metadata }),
            },
            request.expectedTurnId,
          )
          .catch(async (error: unknown) => {
            await promoted.rollback?.()
            throw error
          })
        if (submitted.type === "not_submitted") {
          await promoted.rollback?.()
          throw conflict(`Input was not submitted: ${submitted.reason}.`, {
            reason: submitted.reason,
          })
        }
        if (inputContentAttachments(request.content).length !== 0) {
          pendingSteerDrafts.set(steerKey, [
            ...(pendingSteerDrafts.get(steerKey) ?? []),
            request.content,
          ])
          const stored = await options.store.readThread(request.sessionId)
          const recorded = stored?.rollout.some(
            ({ item }) =>
              item.type === "response_item" &&
              item.item.turnId === request.requestId &&
              item.item.item.role === "user" &&
              item.item.item.context === undefined,
          )
          if (recorded) {
            const drafts = pendingSteerDrafts.get(steerKey) ?? []
            pendingSteerDrafts.delete(steerKey)
            for (const draft of drafts)
              await discardAdmittedDraftAttachments(
                request.sessionId,
                request.requestId,
                draft,
              )
          }
        }
        // Steering acceptance is ephemeral. Preserve draft assets until the
        // model records this input, so a lost response or an interrupted Turn
        // leaves the client's draft retryable.
        return ok(200, {
          requestId: request.requestId,
          turnId: submitted.turnId,
          content: promoted.content,
        })
      } catch (error) {
        return fail(error, reporter, "steer-input")
      }
    },

    async compactSession(input) {
      try {
        const request = requireCompactSessionRequest(input)
        if (
          (await options.store.sessionPresentation(request.sessionId)).archived
        ) {
          throw conflict("Restore this conversation before compacting.")
        }
        const requestId = request.requestId ?? createRequestId()
        const submitted = await withAdmissionLock(
          request.sessionId,
          requestId,
          async () => {
            const thread = await resumeRequired(request.sessionId)
            return thread.compact(requestId)
          },
        )
        if (submitted.type === "not_submitted")
          throw conflict(`Compaction was not submitted: ${submitted.reason}.`, {
            reason: submitted.reason,
          })
        if (submitted.type !== "started" && submitted.type !== "replayed")
          throw internalError("Compaction unexpectedly queued or steered.")
        return ok(submitted.type === "replayed" ? 200 : 201, {
          requestId,
          turnId: submitted.turnId,
        })
      } catch (error) {
        return fail(error, reporter, "compact-session")
      }
    },

    async cancelInput(input) {
      try {
        const request = requireCancelInputRequest(input)
        const item = await queuedItems.withLock(request.sessionId, async () => {
          const queued = queuedItems.get(request.sessionId, request.inputId)
          if (queued === undefined)
            throw conflict(
              `Input ${request.inputId} is already started or unknown.`,
            )
          if (!queuedItems.delete(request.sessionId, request.inputId))
            throw conflict(
              `Input ${request.inputId} is already started or unknown.`,
            )
          return queued
        })
        const stored = await requireStoredThread(
          options.store,
          request.sessionId,
        )
        for (const ownerId of requestAttachmentOwners(item.input.content))
          await discardUnacceptedRequestAttachments(
            request.sessionId,
            stored.metadata.rolloutId,
            ownerId,
          )
        return ok(200, {
          sessionId: request.sessionId,
          inputId: request.inputId,
        })
      } catch (error) {
        return fail(error, reporter, "cancel-input")
      }
    },

    async cancelTurn(input) {
      try {
        const request = requireCancelTurnRequest(input)
        const thread = await resumeRequired(request.sessionId)
        options.goals?.pauseForInterrupt(request.sessionId, request.turnId)
        const interrupted = await thread.interruptTurn(
          request.turnId,
          "reason" in request && typeof request.reason === "string"
            ? request.reason
            : undefined,
        )
        if (!interrupted) {
          throw notFound(`Active Turn ${request.turnId} was not found.`, {
            sessionId: request.sessionId,
            turnId: request.turnId,
          })
        }
        return ok(200, {
          sessionId: request.sessionId,
          turnId: request.turnId,
        })
      } catch (error) {
        return fail(error, reporter, "cancel-turn")
      }
    },

    async resolvePermission(input) {
      try {
        const request = requireResolvePermissionRequest(input)
        if (!options.resolvePermission?.(request)) {
          throw notFound(
            `Active permission ${request.permissionRequestId} was not found.`,
            { permissionRequestId: request.permissionRequestId },
          )
        }
        return ok(200, request)
      } catch (error) {
        return fail(error, reporter, "resolve-permission")
      }
    },

    async readSessionEvents(input) {
      try {
        const request = requireReadSessionEventsRequest(input)
        const stored = await options.store.readThread(request.sessionId)
        if (stored === undefined) {
          throw notFound(`Session ${request.sessionId} was not found.`, {
            sessionId: request.sessionId,
          })
        }
        const after = request.after ?? 0
        const through = request.through ?? Number.MAX_SAFE_INTEGER
        const limit = request.limit ?? 500
        const matching = stored.rollout.filter((record) => {
          const seq = hostSeq(record)
          return seq > after && seq <= through
        })
        const page = matching.slice(0, limit)
        const last = page.at(-1)
        return ok(200, {
          events: page.map((record) =>
            mapRolloutEvent(record, request.sessionId),
          ),
          ...(matching.length > page.length && last !== undefined
            ? { nextAfter: hostSeq(last) }
            : {}),
        })
      } catch (error) {
        return fail(error, reporter, "read-session-events")
      }
    },
  }
}

function mapThreadSummary(
  thread: ThreadSummary,
  liveProjects: ReadonlySet<string> | undefined,
  goal?: ThreadGoal,
): ApiSessionSummary {
  return {
    ...(goal === undefined ? {} : { goal }),
    ...(thread.archived === undefined ? {} : { archived: thread.archived }),
    ...(thread.sectionPosition === undefined
      ? {}
      : { sectionPosition: thread.sectionPosition }),
    ...(thread.sectionId === undefined ? {} : { sectionId: thread.sectionId }),
    id: thread.id,
    conversationId: thread.conversationId,
    ...(thread.navigationId === undefined
      ? {}
      : { navigationId: thread.navigationId }),
    seq: thread.seq + 1,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.title === undefined ? {} : { title: thread.title }),
    ...(thread.workingDirectory === undefined
      ? {}
      : { workingDirectory: thread.workingDirectory }),
    ...(thread.gitInfo === undefined ? {} : { gitInfo: thread.gitInfo }),
    ...(thread.projectId === undefined ||
    (liveProjects !== undefined && !liveProjects.has(thread.projectId))
      ? {}
      : { projectId: thread.projectId }),
    ...(thread.mateId === undefined ? {} : { mateId: thread.mateId }),
    ...(thread.mateRevisionId === undefined
      ? {}
      : { mateRevisionId: thread.mateRevisionId }),
    ...(thread.parentThreadId === undefined
      ? {}
      : { parentSessionId: thread.parentThreadId }),
    ...(thread.forkedFromInputId === undefined
      ? {}
      : { forkedFromInputId: thread.forkedFromInputId }),
    ...(thread.forkReason === undefined
      ? {}
      : { forkReason: thread.forkReason }),
    ...(thread.metadata === undefined ? {} : { metadata: thread.metadata }),
  }
}

async function mapStoredThread(
  stored: StoredThread,
  live: AgentThread | undefined,
  options: ThreadServerHandlerOptions,
): Promise<ApiSessionDetail> {
  const rollout = stored.rollout.map((record) => record.item)
  const contexts = rollout.filter(
    (item): item is Extract<RolloutItem, { readonly type: "turn_context" }> =>
      item.type === "turn_context",
  )
  const inputs = stored.rollout.filter(
    ({ item }) =>
      item.type === "response_item" &&
      item.item.item.role === "user" &&
      item.item.id.startsWith("input_") &&
      item.item.item.context === undefined,
  ).length
  const turns = rollout.filter((item) => item.type === "turn_started").length
  const completedItems = rollout.filter(
    (item): item is Extract<RolloutItem, { readonly type: "item_completed" }> =>
      item.type === "item_completed",
  )
  const items = completedItems.length
  const tools = completedItems.filter(
    ({ item }) =>
      item.type !== "agent_message" &&
      item.type !== "reasoning" &&
      item.type !== "context_compaction",
  ).length
  const usage = rollout.reduce<TokenUsage | undefined>((total, item) => {
    if (item.type !== "turn_completed" || item.usage === undefined) return total
    return addUsage(total, item.usage)
  }, undefined)
  const cacheExpiry = sessionCacheExpiry(stored.rollout)
  const pendingPermissions =
    options.listPendingPermissions?.(stored.metadata.id) ?? []
  const currentContext = contexts.at(-1)
  const summary: ThreadSummary = {
    ...stored.metadata,
    ...(await options.store.sessionPresentation(stored.metadata.id)),
    seq: Math.max(0, threadSeq(stored) - 1),
  }
  const liveProjects = await liveProjectIds(options, [stored.metadata])
  const pendingQueue = options.inputQueue?.list(stored.metadata.id) ?? []
  return {
    ...mapThreadSummary(summary, liveProjects, options.goals?.read(summary.id)),
    ...(live?.snapshot().activeTurnId === undefined
      ? {}
      : { active: true, activeTurnId: live.snapshot().activeTurnId }),
    ...(currentContext === undefined
      ? {}
      : { currentModel: currentContext.context.selection }),
    ...(usage === undefined ? {} : { usage }),
    ...(cacheExpiry === undefined ? {} : { cacheExpiry }),
    pendingInputs: pendingQueue.map((entry) => ({
      id: entry.id,
      text: inputContentText(entry.input.content),
      admittedAt: entry.createdAt,
    })),
    pendingPermissions: pendingPermissions.map(
      ({ sessionId: _, ...entry }) => entry,
    ),
    counts: {
      inputs,
      pendingInputs: pendingQueue.length,
      turns,
      items,
      permissions: pendingPermissions.length,
      tools,
    },
  }
}

// Resolves which of the referenced projectIds still exist. Returns undefined
// when no project store is configured (projectIds then pass through); with a
// store, an id absent from the result reads as no project — the append-only
// orphan-on-delete contract, deliberately replacing Codex's `ON DELETE SET
// NULL` UPDATE, which a JSONL rollout cannot perform.
async function liveProjectIds(
  options: ThreadServerHandlerOptions,
  threads: readonly { readonly projectId?: string }[],
): Promise<Set<string> | undefined> {
  const store = options.projectStore
  if (store === undefined) return undefined
  const ids = [
    ...new Set(
      threads.flatMap((thread) =>
        thread.projectId === undefined ? [] : [thread.projectId],
      ),
    ),
  ]
  const live = new Set<string>()
  for (const id of ids) {
    if ((await store.readProject(id)) !== undefined) live.add(id)
  }
  return live
}

function mapRolloutEvent(
  record: StoredRolloutItem,
  threadId: string,
): AppSessionEventEnvelope {
  const item = record.item
  const base = {
    sessionId: threadId,
    seq: hostSeq(record),
    id: `event_${threadId}_${record.rolloutId}_${record.seq}`,
    createdAt: record.createdAt,
  }
  if (item.type === "session_meta") {
    const metadata = item.metadata
    return createEventEnvelope({
      ...base,
      event: {
        type: "session.created",
        data: {
          conversationId: metadata.conversationId,
          ...(metadata.title === undefined ? {} : { title: metadata.title }),
          ...(metadata.workingDirectory === undefined
            ? {}
            : { workingDirectory: metadata.workingDirectory }),
          ...(metadata.projectId === undefined
            ? {}
            : { projectId: metadata.projectId }),
          ...(metadata.mateId === undefined ? {} : { mateId: metadata.mateId }),
          ...(metadata.mateRevisionId === undefined
            ? {}
            : { mateRevisionId: metadata.mateRevisionId }),
          ...(metadata.parentThreadId === undefined
            ? {}
            : { parentSessionId: metadata.parentThreadId }),
          ...(metadata.forkedFromInputId === undefined
            ? {}
            : { forkedFromInputId: metadata.forkedFromInputId }),
          ...(metadata.forkReason === undefined
            ? {}
            : { forkReason: metadata.forkReason }),
          ...(metadata.metadata === undefined
            ? {}
            : { metadata: metadata.metadata }),
        },
      },
    })
  }
  if (
    item.type === "response_item" &&
    item.item.item.role === "user" &&
    (item.item.id.startsWith("input_") ||
      item.item.id.startsWith("message_")) &&
    item.item.item.context === undefined
  ) {
    // message_-prefixed user items are steered inputs, recorded when the
    // active Turn sampled them; input_-prefixed items start Turns.
    const steered = item.item.id.startsWith("message_")
    return createEventEnvelope({
      ...base,
      event: {
        type: "input.admitted",
        data: {
          requestId: item.item.turnId,
          inputId: item.item.id,
          role: InputRole.User,
          ...(steered ? { steered: true } : {}),
          content:
            item.item.submissionMetadata?.content ??
            modelUserInputContent(item.item.item),
          ...(item.item.submissionMetadata?.modelSelection === undefined
            ? {}
            : {
                modelSelection: item.item.submissionMetadata.modelSelection,
              }),
          ...(item.item.submissionMetadata?.parentInputId === undefined
            ? {}
            : { parentInputId: item.item.submissionMetadata.parentInputId }),
          ...(item.item.submissionMetadata?.metadata === undefined
            ? {}
            : { metadata: item.item.submissionMetadata.metadata }),
        },
      },
    })
  }
  if (item.type === "turn_started") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "turn.started",
        data: { turnId: item.turnId, inputId: item.inputItemId },
      },
    })
  }
  if (item.type === "turn_completed") {
    const outcome =
      item.outcome === "completed"
        ? ({ status: "completed", ...item.completion } as const)
        : item.outcome === "interrupted"
          ? ({ status: "interrupted" } as const)
          : ({
              status: "failed",
              error: item.error ?? { message: "Turn execution failed." },
            } as const)
    return createEventEnvelope({
      ...base,
      event: {
        type: "turn.completed",
        data: {
          turnId: item.turnId,
          outcome,
          ...(item.usage === undefined ? {} : { usage: item.usage }),
          ...(item.metrics === undefined ? {} : { metrics: item.metrics }),
        },
      },
    })
  }
  if (item.type === "item_started") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "item.started",
        data: { turnId: item.turnId, item: item.item },
      },
    })
  }
  if (item.type === "token_count") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "context.tokens",
        data: {
          turnId: item.turnId,
          activeContextTokens: item.activeContextTokens,
          ...(item.capacityTokens === undefined
            ? {}
            : { capacityTokens: item.capacityTokens }),
          ...(item.provider === undefined ? {} : { provider: item.provider }),
          ...(item.model === undefined ? {} : { model: item.model }),
        },
      },
    })
  }
  if (item.type === "item_completed") {
    return createEventEnvelope({
      ...base,
      event: {
        type: "item.completed",
        data: { turnId: item.turnId, item: item.item },
      },
    })
  }
  return {
    ...base,
    version: EVENT_SCHEMA_VERSION,
    type: "session.cursor",
    data: {},
  }
}

function threadSeq(stored: StoredThread): number {
  const last = stored.rollout.at(-1)
  return last === undefined ? 0 : hostSeq(last)
}

function recordTurnInput(
  publication: RolloutPublication,
  item: RolloutItem,
): void {
  if (item.type === "turn_started") {
    publication.turns.set(item.turnId, {
      inputItemId: item.inputItemId,
      accepted: false,
    })
  } else if (item.type === "response_item" && item.item.item.role === "user") {
    const turn = publication.turns.get(item.item.turnId)
    if (turn?.inputItemId === item.item.id) turn.accepted = true
  }
}

function isInitialUserInput(
  record: StoredRolloutItem,
): record is StoredRolloutItem & {
  item: Extract<RolloutItem, { type: "response_item" }>
} {
  return (
    record.item.type === "response_item" &&
    record.item.item.id.startsWith("input_") &&
    record.item.item.item.role === "user" &&
    record.item.item.item.context === undefined
  )
}

function hostSeq(record: StoredRolloutItem): number {
  return record.seq + 1
}

async function requireStoredThread(
  store: ThreadStore,
  threadId: string,
): Promise<StoredThread> {
  const stored = await store.readThread(threadId)
  if (stored !== undefined) return stored
  throw notFound(`Session ${threadId} was not found.`, { sessionId: threadId })
}

function requestAttachmentOwners(content: InputContent): readonly string[] {
  return [
    ...new Set(
      inputContentAttachments(content).flatMap((attachment) => {
        if ("url" in attachment.file) return []
        const match = /^attachments\/requests\/([^/]+)\//.exec(
          attachment.file.path,
        )
        return match?.[1] === undefined ? [] : [match[1]]
      }),
    ),
  ]
}

function turnIdForInput(stored: StoredThread, inputId: string): string {
  const started = stored.rollout.find(
    (record) =>
      record.item.type === "turn_started" &&
      record.item.inputItemId === inputId,
  )
  if (started?.item.type === "turn_started") return started.item.turnId
  throw notFound(`Input ${inputId} was not found.`, {
    sessionId: stored.metadata.id,
    inputId,
  })
}

function modelUserInputContent(
  message: import("../kernel/events.ts").ModelUserMessage,
): InputContent {
  const content = inputContentFromModelMessage(message)
  if (content === undefined)
    throw invalidInput("Input attachments require portable asset sources.")
  return content
}

function requireRolloutAssets(
  options: ThreadServerHandlerOptions,
): RolloutAssets {
  if (options.rolloutAssets !== undefined) return options.rolloutAssets
  throw invalidInput("Forked input attachments require rollout asset storage.")
}

function addUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    ...((left?.cacheReadInputTokens ?? 0) +
      (right.cacheReadInputTokens ?? 0) ===
    0
      ? {}
      : {
          cacheReadInputTokens:
            (left?.cacheReadInputTokens ?? 0) +
            (right.cacheReadInputTokens ?? 0),
        }),
    ...((left?.cacheWriteInputTokens ?? 0) +
      (right.cacheWriteInputTokens ?? 0) ===
    0
      ? {}
      : {
          cacheWriteInputTokens:
            (left?.cacheWriteInputTokens ?? 0) +
            (right.cacheWriteInputTokens ?? 0),
        }),
    ...(right.activeContextTokens === undefined
      ? left?.activeContextTokens === undefined
        ? {}
        : { activeContextTokens: left.activeContextTokens }
      : { activeContextTokens: right.activeContextTokens }),
  }
}

function requireCreateSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session create request must be an object.",
  )
  return {
    ...optionalStringField(record, "title"),
    ...optionalStringField(record, "workingDirectory"),
    ...optionalStringField(record, "projectId"),
    ...optionalStringField(record, "mateId"),
    ...optionalStringField(record, "mateRevisionId"),
    ...optionalSessionIdField(record, "parentSessionId"),
    ...optionalMetadataField(record, "metadata"),
  }
}

async function applySessionCreateDefaults(
  request: {
    readonly title?: string
    readonly workingDirectory?: string
    readonly projectId?: string
    readonly mateId?: string
    readonly mateRevisionId?: string
    readonly parentSessionId?: string
    readonly metadata?: EventMetadata
  },
  defaults: SessionCreateDefaults | undefined,
) {
  if (defaults === undefined) return request

  const workingDirectory = await resolveSessionWorkspace(
    request.workingDirectory,
    defaults.workingDirectory,
  )

  if (request.mateId !== undefined && request.mateId !== defaults.mateId) {
    throw invalidInput(
      "mateId cannot override the configured active Mate in the current single-Mate stage.",
      { field: "mateId" },
    )
  }

  if (
    request.mateRevisionId !== undefined &&
    request.mateRevisionId !== defaults.mateRevisionId
  ) {
    throw invalidInput(
      "mateRevisionId cannot override the configured active Mate revision in the current single-Mate stage.",
      { field: "mateRevisionId" },
    )
  }

  return {
    ...request,
    workingDirectory,
    mateId: defaults.mateId,
    mateRevisionId: defaults.mateRevisionId,
  }
}

async function resolveSessionWorkspace(
  requested: string | undefined,
  fallback: string,
): Promise<string> {
  if (requested === undefined) return fallback
  const resolved = await resolveOptionalWorkspace(requested)
  if (resolved === undefined) {
    throw invalidInput("workingDirectory must be an existing directory.", {
      field: "workingDirectory",
      requested,
    })
  }
  return resolved
}

async function resolveOptionalWorkspace(
  workspace: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(workspace)
    return (await stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function requireArchivedFilter(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean")
    throw invalidInput("archived must be a boolean.")
  return value === true
}

function requireListSessionsRequest(input: unknown) {
  const record = requireRecord(input, "Session list request must be an object.")
  const limit = requireOptionalLimit(record.limit)
  const cursor = requireOptionalString(record.cursor, "cursor")
  const workingDirectory = requireOptionalString(
    record.workingDirectory,
    "workingDirectory",
  )
  const projectId = requireOptionalString(record.projectId, "projectId")
  const archived = requireArchivedFilter(record.archived)
  const sectionId =
    record.sectionId === null
      ? null
      : requireOptionalString(record.sectionId, "sectionId")

  return {
    archived,
    sectionId,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(projectId === undefined ? {} : { projectId }),
  }
}

function requireSearchSessionsRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session search request must be an object.",
  )
  const cursor = requireOptionalString(record.cursor, "cursor")
  return {
    archived: requireArchivedFilter(record.archived),
    searchTerm: requireSearchTerm(record.searchTerm),
    limit: requireSearchLimit(record.limit),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

function requireSearchSessionOccurrencesRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session occurrence search request must be an object.",
  )
  const cursor = requireOptionalString(record.cursor, "cursor")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    searchTerm: requireSearchTerm(record.searchTerm),
    limit: requireSearchLimit(record.limit),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

function requireSearchTerm(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  throw invalidInput("searchTerm must be a non-empty string.", {
    field: "searchTerm",
  })
}

function requireSearchLimit(value: unknown): number {
  if (value === undefined) return 50
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 100
  ) {
    return value
  }
  throw invalidInput("Search limit must be an integer from 1 to 100.", {
    limit: isJsonValue(value) ? value : null,
  })
}

function requireReadSessionRequest(input: unknown) {
  const record = requireRecord(input, "Session read request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
  }
}

function requireDeleteSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session delete request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
  }
}

function requireForkSessionRequest(input: unknown, maxInputBytes: number) {
  const record = requireRecord(input, "Session fork request must be an object.")
  const reason = record.reason
  if (reason !== ForkReason.Undo && reason !== ForkReason.Edit) {
    throw invalidInput('reason must be "undo" or "edit".', { field: "reason" })
  }
  const content =
    record.content === undefined
      ? undefined
      : requireAdmissionInputContent(record.content, maxInputBytes)
  const modelSelection = optionalModelSelectionField(record, "modelSelection")
  if (reason === ForkReason.Edit && content === undefined) {
    throw invalidInput("content is required when reason is edit.", {
      field: "content",
    })
  }
  if (reason === ForkReason.Undo && content !== undefined) {
    throw invalidInput("content is not allowed when reason is undo.", {
      field: "content",
    })
  }
  if (
    reason === ForkReason.Undo &&
    modelSelection.modelSelection !== undefined
  ) {
    throw invalidInput("modelSelection is not allowed when reason is undo.", {
      field: "modelSelection",
    })
  }
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    atInputId: requireInputId(record.atInputId, "atInputId"),
    reason,
    ...(content === undefined ? {} : { content }),
    ...modelSelection,
  }
}

function requireAdmitInputRequest(
  input: unknown,
  maxInputBytes: number,
  maxContextBytes = maxInputBytes,
) {
  const record = requireRecord(
    input,
    "Input admission request must be an object.",
  )
  const parentInputId = requireOptionalString(
    record.parentInputId,
    "parentInputId",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    requestId: requireRequestId(record.requestId),
    content: requireAdmissionInputContent(
      record.content,
      maxInputBytes,
      maxContextBytes,
    ),
    ...optionalModelSelectionField(record, "modelSelection"),
    ...optionalInputRoleField(record, "role"),
    ...(parentInputId === undefined ? {} : { parentInputId }),
    ...optionalMetadataField(record, "metadata"),
  }
}

function requireSteerInputRequest(input: unknown, maxInputBytes: number) {
  const record = requireRecord(input, "Steer request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    requestId: requireRequestId(record.requestId),
    expectedTurnId: requireString(record.expectedTurnId, "expectedTurnId"),
    content: requireAdmissionInputContent(record.content, maxInputBytes),
    ...optionalModelSelectionField(record, "modelSelection"),
    ...optionalMetadataField(record, "metadata"),
  }
}

function optionalModelSelectionField(
  record: Record<string, unknown>,
  field: string,
): { readonly modelSelection?: ModelSelection } {
  const value = record[field]
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw invalidInput(`${field} must be an object.`, { field })
  }
  return {
    modelSelection: {
      provider: requireString(value.provider, `${field}.provider`),
      model: requireString(value.model, `${field}.model`),
      ...(value.effort === undefined
        ? {}
        : { effort: requireString(value.effort, `${field}.effort`) }),
      ...(value.speed === undefined
        ? {}
        : { speed: requireString(value.speed, `${field}.speed`) }),
    },
  }
}

function requireAvailableProvider(
  provider: string | undefined,
  availableProviders: readonly string[] | undefined,
): void {
  if (
    provider === undefined ||
    availableProviders === undefined ||
    availableProviders.includes(provider)
  ) {
    return
  }
  throw invalidInput(`Provider ${provider} is not configured.`, {
    field: "modelSelection.provider",
    provider,
    availableProviders,
  })
}

function requireCompactSessionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session compact request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    // Optional so older clients keep working; when present it gives the
    // admission the same idempotent-replay guarantee as regular inputs.
    ...(record.requestId === undefined
      ? {}
      : { requestId: requireRequestId(record.requestId) }),
  }
}

function requireCancelInputRequest(input: unknown) {
  const record = requireRecord(input, "Input cancel request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    inputId: requireInputId(record.inputId, "inputId"),
    ...optionalReasonField(record, "reason"),
  }
}

function requireCancelTurnRequest(input: unknown) {
  const record = requireRecord(input, "Turn cancel request must be an object.")
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    turnId: requireString(record.turnId, "turnId"),
    ...optionalReasonField(record, "reason"),
  }
}

function requireResolvePermissionRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Permission resolve request must be an object.",
  )
  const behavior = record.behavior
  if (behavior !== "allow" && behavior !== "deny") {
    throw invalidInput('behavior must be "allow" or "deny".', {
      field: "behavior",
    })
  }
  const decision: "allow" | "deny" = behavior
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    turnId: requireString(record.turnId, "turnId"),
    permissionRequestId: requireString(
      record.permissionRequestId,
      "permissionRequestId",
    ),
    behavior: decision,
    ...(record.reason === undefined
      ? {}
      : { reason: requireDecisionReason(record.reason) }),
  }
}

function requireDecisionReason(value: unknown): RuntimePermissionReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput("reason must be an object.")
  }
  const record = value as Record<string, unknown>
  if (typeof record.kind !== "string" || record.kind.trim().length === 0) {
    throw invalidInput("reason.kind must be a non-empty string.")
  }
  return {
    kind: record.kind,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value
  throw invalidInput(`${field} must be a non-empty string.`, { field })
}

function requireRequestId(value: unknown): string {
  if (typeof value === "string" && isRequestId(value)) return value
  throw invalidInput(
    "requestId must be 1 to 128 letters, numbers, dots, underscores, colons, or hyphens.",
    { field: "requestId" },
  )
}

function requireReadSessionEventsRequest(input: unknown) {
  const record = requireRecord(
    input,
    "Session events request must be an object.",
  )
  return {
    sessionId: requireSessionId(record.sessionId, "sessionId"),
    after: requireOptionalSequence(record.after, "after"),
    through: requireOptionalSequence(record.through, "through"),
    limit: requireOptionalEventLimit(record.limit),
  }
}

function requireOptionalEventLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "string" ? Number(value) : value
  if (
    Number.isInteger(parsed) &&
    (parsed as number) > 0 &&
    (parsed as number) <= 1_000
  ) {
    return parsed as number
  }
  throw invalidInput("limit must be an integer from 1 to 1000.", {
    field: "limit",
  })
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (isRecord(value)) return value
  throw invalidInput(message)
}

function requireSessionId(value: unknown, field: string): string {
  if (
    typeof value === "string" &&
    isIdWithPrefix(value, IdPrefix.Session) &&
    isGeneratedSessionId(value)
  ) {
    return value
  }
  throw invalidInput(`${field} must be a session id.`, {
    field,
  })
}

function requireInputId(value: unknown, field: string): string {
  if (
    typeof value === "string" &&
    isIdWithPrefix(value, IdPrefix.Input) &&
    isGeneratedInputId(value)
  ) {
    return value
  }
  throw invalidInput(`${field} must be an input id.`, {
    field,
  })
}

function requireOptionalLimit(value: unknown): number {
  if (value === undefined) return 50
  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    if (value <= 100) return value
  }
  throw invalidInput("Session list limit must be an integer from 1 to 100.", {
    limit: isJsonValue(value) ? value : null,
  })
}

function requireOptionalSequence(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value)
  }
  throw invalidInput(`${field} must be a non-negative integer sequence.`, {
    [field]: isJsonValue(value) ? value : null,
  })
}

function requireAdmissionInputContent(
  value: unknown,
  maxInputBytes: number,
  maxContextBytes = maxInputBytes,
): InputContent {
  if (!isInputContent(value))
    throw invalidInput(
      "content must contain input text, elements, attachments and valid references.",
    )
  if (Buffer.byteLength(value.text, "utf8") > maxInputBytes)
    throw invalidInput(`content.text must not exceed ${maxInputBytes} bytes.`, {
      field: "content.text",
      maxBytes: maxInputBytes,
    })
  if (
    value.references !== undefined &&
    Buffer.byteLength(JSON.stringify(value.references), "utf8") >
      maxContextBytes
  )
    throw invalidInput(
      `content.references must not exceed ${maxContextBytes} bytes.`,
    )
  for (const attachment of value.attachments) {
    if (Buffer.byteLength(attachment.name, "utf8") > 255)
      throw invalidInput("Attachment name is too long.")
    if (!isAssetSource(attachment.file))
      throw invalidInput("Invalid attachment source.")
    if (!("url" in attachment.file) && attachment.sizeBytes <= 0)
      throw invalidInput("Stored attachment sizeBytes must be positive.")
  }
  return value
}

function optionalStringField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = requireOptionalString(record[field], field)
  if (value === undefined) return {}
  return { [field]: value }
}

function optionalReasonField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = requireOptionalString(record[field], field)
  if (value === undefined) return {}
  if (value.length > maxCancelReasonLength) {
    throw invalidInput(
      `${field} must not exceed ${maxCancelReasonLength} characters.`,
      { field },
    )
  }
  return { [field]: value }
}

function requireOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  throw invalidInput(`${field} must be a string.`, {
    field,
  })
}

function optionalSessionIdField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  if (record[field] === undefined) return {}
  return { [field]: requireSessionId(record[field], field) }
}

function optionalInputRoleField(
  record: Record<string, unknown>,
  field: string,
): { readonly role?: InputRole } {
  if (record[field] === undefined) return {}
  if (isInputRole(record[field])) return { role: record[field] }
  throw invalidInput(`${field} must be a valid input role.`, {
    field,
  })
}

function optionalMetadataField(
  record: Record<string, unknown>,
  field: string,
): { readonly metadata?: EventMetadata } {
  if (record[field] === undefined) return {}
  if (isJsonObject(record[field])) return { metadata: record[field] }
  throw invalidInput(`${field} must be a JSON object.`, {
    field,
  })
}

function encodeSessionListCursor(
  anchor: string,
  limit: number,
  workingDirectory: string | undefined,
  projectId: string | undefined,
  archived: boolean,
  sectionId: string | null | undefined,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      resource: "sessions",
      archived,
      sectionId,
      order:
        typeof sectionId === "string"
          ? "section_position_asc"
          : sessionListOrder,
      limit,
      anchor,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(projectId === undefined ? {} : { projectId }),
    }),
    "utf8",
  ).toString("base64url")
}

function encodeSearchCursor(
  resource: string,
  searchTerm: string,
  limit: number,
  anchor: string,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, resource, searchTerm, limit, anchor }),
    "utf8",
  ).toString("base64url")
}

function decodeSearchCursor(
  cursor: string,
  resource: string,
  searchTerm: string,
  limit: number,
): string {
  const payload = parseCursorPayload(cursor)
  if (
    payload.version === 1 &&
    payload.resource === resource &&
    payload.searchTerm === searchTerm &&
    payload.limit === limit &&
    typeof payload.anchor === "string"
  ) {
    return payload.anchor
  }
  throw invalidCursor("Search cursor does not match this request.", { cursor })
}

function decodeSessionListCursor(
  cursor: string,
  limit: number,
  workingDirectory: string | undefined,
  projectId: string | undefined,
  archived: boolean,
  sectionId: string | null | undefined,
): string {
  const payload = parseCursorPayload(cursor)
  if (
    payload.version === 1 &&
    payload.resource === "sessions" &&
    payload.order ===
      (typeof sectionId === "string"
        ? "section_position_asc"
        : sessionListOrder) &&
    payload.limit === limit &&
    payload.workingDirectory === workingDirectory &&
    payload.projectId === projectId &&
    payload.archived === archived &&
    payload.sectionId === sectionId &&
    typeof payload.anchor === "string"
  ) {
    return payload.anchor
  }

  throw invalidCursor("Session list cursor does not match this request.", {
    cursor,
  })
}

function parseCursorPayload(cursor: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (isRecord(parsed)) return parsed
  } catch {
    throw invalidCursor("Session list cursor is invalid.", {
      cursor,
    })
  }

  throw invalidCursor("Session list cursor is invalid.", {
    cursor,
  })
}

function ok<T>(status: number, body: T): ApiHandlerResult<T> {
  return {
    ok: true,
    status,
    body,
  }
}

function fail(
  error: unknown,
  reporter?: OperationalFailureReporter,
  operation?: string,
): ApiHandlerResult<never> {
  const mapped = mapError(error)
  if (mapped.status >= 500 && reporter !== undefined) {
    const sessionId =
      mapped.details !== undefined &&
      typeof mapped.details.sessionId === "string"
        ? mapped.details.sessionId
        : undefined
    const turnId =
      mapped.details !== undefined && typeof mapped.details.turnId === "string"
        ? mapped.details.turnId
        : undefined
    reportOperationalFailure(reporter, {
      component: "thread-handlers",
      operation: operation ?? "request",
      cause: error,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(turnId === undefined ? {} : { turnId }),
    })
  }
  return {
    ok: false,
    status: mapped.status,
    body: {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      },
    },
  }
}

function mapError(error: unknown): ApiBoundaryError {
  if (error instanceof ApiBoundaryError) return error
  if (error instanceof GoalToolError) return conflict(error.message)
  if (!isYakitoriError(error)) {
    return internalError("Unexpected server error.")
  }

  if (error.code === YakitoriErrorCode.InvalidArgument) {
    return invalidInput(error.message, error.details)
  }
  if (error.code === YakitoriErrorCode.NotFound) {
    return notFound(error.message, error.details)
  }
  if (error.code === YakitoriErrorCode.InvalidState) {
    return conflict(error.message, error.details)
  }

  return internalError(error.message, error.details)
}

function invalidInput(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InvalidInput, 400, message, details)
}

function invalidCursor(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InvalidCursor, 400, message, details)
}

function notFound(message: string, details?: EventMetadata): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.NotFound, 404, message, details)
}

function conflict(message: string, details?: EventMetadata): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.Conflict, 409, message, details)
}

function internalError(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InternalError, 500, message, details)
}

class ApiBoundaryError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details?: EventMetadata

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: EventMetadata,
  ) {
    super(message)
    this.name = "ApiBoundaryError"
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isGeneratedSessionId(value: string): boolean {
  return /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

function isGeneratedInputId(value: string): boolean {
  return /^input_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
}

function isInputRole(value: unknown): value is InputRole {
  return (
    value === InputRole.Runtime ||
    value === InputRole.System ||
    value === InputRole.User
  )
}

function isJsonObject(value: unknown): value is EventMetadata {
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}
