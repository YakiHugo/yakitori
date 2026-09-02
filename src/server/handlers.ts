import { realpath, stat } from "node:fs/promises"
import type { AgentThread } from "../core/agent-thread.ts"
import type {
  RolloutItem,
  StoredRolloutItem,
  StoredThread,
  ThreadSummary,
} from "../core/rollout.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import type { ThreadStore } from "../core/thread-store.ts"
import {
  createEventEnvelope,
  EVENT_SCHEMA_VERSION,
  type EventMetadata,
  ForkReason,
  IdPrefix,
  type ImageAttachment,
  ImageAttachmentConflictError,
  InputRole,
  isIdWithPrefix,
  isJsonValue,
  isKernelEvent,
  isRequestId,
  isStorageKey,
  isYakitoriError,
  type ModelSelection,
  type RolloutAssets,
  type StoredEventEnvelope,
  type TextContent,
  type TokenUsage,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import { SessionExecutionPolicyDefaults } from "../runtime/limits.ts"
import { createCoalescingDeltaPublisher } from "../runtime/live-events.ts"
import type {
  RuntimePermissionReason,
  RuntimePermissionRequest,
} from "../runtime/permission-gate.ts"
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
  type ApiListSessionsResponse,
  type ApiReadSessionEventsResponse,
  type ApiReadSessionResponse,
  type ApiResolvePermissionResponse,
  type ApiSessionDetail,
  type ApiSessionSummary,
} from "./protocol.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"

export type SessionCreateDefaults = {
  readonly workingDirectory: string
  readonly mateId: string
  readonly mateRevisionId: string
}

export type ThreadServerHandlerOptions = {
  readonly manager: ThreadManager
  readonly discardThread?: (threadId: string) => Promise<void>
  readonly store: ThreadStore
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
  readonly rolloutAssets?: RolloutAssets
  readonly reportOperationalFailure?: OperationalFailureReporter
}

export type ServerHandlers = {
  createSession(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiCreateSessionResponse>>
  listSessions(
    input?: unknown,
  ): Promise<ApiHandlerResult<ApiListSessionsResponse>>
  readSession(input: unknown): Promise<ApiHandlerResult<ApiReadSessionResponse>>
  deleteSession(
    input: unknown,
  ): Promise<ApiHandlerResult<ApiDeleteSessionResponse>>
  forkSession(input: unknown): Promise<ApiHandlerResult<ApiForkSessionResponse>>
  admitInput(input: unknown): Promise<ApiHandlerResult<ApiAdmitInputResponse>>
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

type AdmissionTextContent = {
  readonly kind: "text"
  readonly text: string
  readonly attachments?: readonly ImageAttachment[]
}

// App-server projection over the live Session actor and canonical rollout.
// It translates host DTOs only; execution never reads this projection.
export function createThreadServerHandlers(
  options: ThreadServerHandlerOptions,
): ThreadServerHandlers {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const pumps = new Map<string, Promise<void>>()
  const pumpReady = new Map<string, Promise<void>>()
  const publishedThrough = new Map<string, number>()
  const admissionTails = new Map<string, Promise<void>>()
  let closing = false
  let stopPumps: (() => void) | undefined
  const pumpsStopped = new Promise<void>((resolve) => {
    stopPumps = resolve
  })

  async function publishNewRollout(
    threadId: string,
    throughSeq: number,
  ): Promise<void> {
    const stored = await options.store.readThread(threadId)
    if (stored === undefined) return
    const after = publishedThrough.get(threadId) ?? 0
    const records = stored.rollout.filter((record) => {
      const seq = hostSeq(record)
      return seq > after && seq <= throughSeq
    })
    if (records.length === 0) return
    options.eventHub?.publishDurable(
      records.map((record) => mapRolloutEvent(record, threadId)),
    )
    const last = records.at(-1)
    if (last !== undefined) publishedThrough.set(threadId, hostSeq(last))
  }

  async function ensureEventPump(thread: AgentThread): Promise<void> {
    if (closing) throw new Error("Server handlers are shutting down.")
    const existing = pumpReady.get(thread.id)
    if (existing !== undefined) {
      await existing
      return
    }
    const ready = (async () => {
      const stored = await options.store.readThread(thread.id)
      if (!publishedThrough.has(thread.id)) {
        publishedThrough.set(
          thread.id,
          stored === undefined ? 0 : threadSeq(stored),
        )
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
            streams.clear()
            for (;;) {
              try {
                await publishNewRollout(thread.id, event.throughSeq)
                break
              } catch (error) {
                if (thread.status === "shutdown" || closing) throw error
                reportOperationalFailure(reporter, {
                  component: "thread-event-pump",
                  operation: "replay-rollout",
                  cause: error,
                  sessionId: thread.id,
                })
                await new Promise((resolve) => setTimeout(resolve, 100))
              }
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
              text: event.text,
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
          if (event.type === "session.error") {
            options.eventHub?.publishTransient({
              type: "session.error",
              sessionId: event.threadId,
              operation: event.operation,
              message: event.message,
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
          pumps.delete(thread.id)
          pumpReady.delete(thread.id)
        })
      pumps.set(thread.id, pump)
    })()
    pumpReady.set(thread.id, ready)
    try {
      await ready
    } catch (error) {
      pumpReady.delete(thread.id)
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
    }
  }

  return {
    async close() {
      closing = true
      stopPumps?.()
      await Promise.allSettled([...admissionTails.values()])
      await Promise.allSettled([...pumpReady.values()])
      await Promise.allSettled([...pumps.values()])
    },
    async createSession(input = {}) {
      try {
        const request = await applySessionCreateDefaults(
          requireCreateSessionRequest(input),
          options.sessionDefaults,
        )
        const thread = await options.manager.createThread({
          ...request,
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
          session: mapStoredThread(stored, thread, options),
          event,
        })
      } catch (error) {
        return fail(error, reporter, "create-session")
      }
    },

    async listSessions(input = {}) {
      try {
        const request = requireListSessionsRequest(input)
        const result = await options.manager.listThreads({
          limit: request.limit,
          ...(request.workingDirectory === undefined
            ? {}
            : { workingDirectory: request.workingDirectory }),
          ...(request.cursor === undefined
            ? {}
            : {
                cursor: decodeSessionListCursor(
                  request.cursor,
                  request.limit,
                  request.workingDirectory,
                ),
              }),
        })
        return ok(200, {
          sessions: result.threads.map(mapThreadSummary),
          ...(result.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeSessionListCursor(
                  result.nextCursor,
                  request.limit,
                  request.workingDirectory,
                ),
              }),
        })
      } catch (error) {
        return fail(error, reporter, "list-sessions")
      }
    },

    async readSession(input) {
      try {
        const { sessionId } = requireReadSessionRequest(input)
        const stored = await options.store.readThread(sessionId)
        if (stored === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        return ok(200, {
          session: mapStoredThread(
            stored,
            options.manager.getThread(sessionId),
            options,
          ),
        })
      } catch (error) {
        return fail(error, reporter, "read-session")
      }
    },

    async deleteSession(input) {
      try {
        const { sessionId } = requireDeleteSessionRequest(input)
        if ((await options.store.readThread(sessionId)) === undefined) {
          throw notFound(`Session ${sessionId} was not found.`, { sessionId })
        }
        await (options.discardThread?.(sessionId) ??
          options.manager.discardThread(sessionId))
        publishedThrough.delete(sessionId)
        return ok(200, { sessionId })
      } catch (error) {
        return fail(error, reporter, "delete-session")
      }
    },

    async forkSession(input) {
      try {
        const request = requireForkSessionRequest(
          input,
          options.maxInputBytes ??
            SessionExecutionPolicyDefaults.modelVisibleContextBytes,
        )
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        const source = await requireStoredThread(
          options.store,
          request.sessionId,
        )
        const beforeTurnId = turnIdForInput(source, request.atInputId)
        const sourceAttachments = inputAttachments(source, request.atInputId)
        const forked = await options.manager.forkThread({
          sourceThreadId: request.sessionId,
          beforeTurnId,
          forkedFromInputId: request.atInputId,
          forkReason: request.reason,
        })
        const forkRolloutId = forked.thread.snapshot().metadata.rolloutId
        let submissionId: string | undefined
        try {
          await ensureEventPump(forked.thread)
          if (request.content !== undefined) {
            submissionId = `request_${globalThis.crypto.randomUUID()}`
            const attachments =
              sourceAttachments.length === 0
                ? undefined
                : await requireRolloutAssets(options).copyImageAttachments(
                    forkRolloutId,
                    submissionId,
                    sourceAttachments,
                  )
            const submitted = await forked.thread.startIfIdle({
              submissionId,
              content: {
                ...request.content,
                ...(attachments === undefined ? {} : { attachments }),
              },
              ...(request.modelSelection === undefined
                ? {}
                : { modelSelection: request.modelSelection }),
            })
            if (submitted.type !== "started") {
              await options.rolloutAssets?.discardRequestImageAttachments(
                forkRolloutId,
                submissionId,
              )
              throw conflict(`Fork input was not started: ${submitted.type}.`)
            }
          }
        } catch (error) {
          try {
            await options.manager.discardThread(forked.thread.id)
          } catch (cleanupError) {
            reportOperationalFailure(reporter, {
              component: "thread-handlers",
              operation: "rollback-fork",
              cause: cleanupError,
              sessionId: forked.thread.id,
            })
          }
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
          session: mapStoredThread(stored, forked.thread, options),
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
          options.maxInputBytes ??
            SessionExecutionPolicyDefaults.modelVisibleContextBytes,
        )
        requireAvailableProvider(
          request.modelSelection?.provider,
          options.availableProviders,
        )
        if (request.role !== undefined && request.role !== InputRole.User) {
          throw invalidInput(
            "Only user input can be submitted to a live Session.",
            {
              field: "role",
            },
          )
        }
        return await withAdmissionLock(
          request.sessionId,
          request.requestId,
          async () => {
            const thread = await resumeRequired(request.sessionId)
            const rolloutId = thread.snapshot().metadata.rolloutId
            let content: TextContent = request.content
            let rollbackPromotion: (() => Promise<void>) | undefined
            if (request.content.attachments !== undefined) {
              if (options.rolloutAssets === undefined) {
                throw invalidInput(
                  "Image attachments require rollout asset storage.",
                )
              }
              try {
                const promotion =
                  await options.rolloutAssets.promoteImageAttachments(
                    rolloutId,
                    request.requestId,
                    request.content.attachments,
                  )
                rollbackPromotion = promotion.rollback
                content = {
                  ...request.content,
                  attachments: promotion.attachments,
                }
              } catch (error) {
                if (error instanceof ImageAttachmentConflictError) {
                  throw conflict("Input was not submitted: request_conflict.", {
                    reason: "request_conflict",
                  })
                }
                throw error
              }
            }
            // The existing /inputs route has a durable input-event response
            // shape, so it maps to Codex's start-if-idle operation. Steering
            // remains a distinct live Session command and needs its own host
            // protocol.
            const submitted = await thread
              .startIfIdle({
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
              })
              .catch(async (error: unknown) => {
                await rollbackPromotion?.()
                throw error
              })
            if (submitted.type === "not_submitted") {
              await rollbackPromotion?.()
              throw conflict(`Input was not submitted: ${submitted.reason}.`, {
                reason: submitted.reason,
              })
            }
            rollbackPromotion = undefined
            if (request.content.attachments !== undefined) {
              await options.rolloutAssets
                ?.discardDraftImageAttachments(request.content.attachments)
                .catch((error: unknown) => {
                  reportOperationalFailure(reporter, {
                    component: "thread-handlers",
                    operation: "discard-admitted-draft-attachments",
                    cause: error,
                    sessionId: request.sessionId,
                    turnId: request.requestId,
                  })
                })
            }
            const stored = await requireStoredThread(
              options.store,
              request.sessionId,
            )
            const record = [...stored.rollout]
              .reverse()
              .find(
                (entry) =>
                  entry.item.type === "response_item" &&
                  entry.item.item.turnId === request.requestId &&
                  entry.item.item.id.startsWith("input_"),
              )
            if (record === undefined) {
              throw internalError(
                "Submitted input was not present in the rollout.",
              )
            }
            const event = mapRolloutEvent(record, request.sessionId)
            if (!isKernelEvent(event)) {
              throw internalError(
                "Submitted input did not map to a host event.",
              )
            }
            return ok(submitted.type === "replayed" ? 200 : 201, {
              requestId: request.requestId,
              inputId:
                record.item.type === "response_item"
                  ? record.item.item.id
                  : request.requestId,
              event,
            })
          },
        )
      } catch (error) {
        return fail(error, reporter, "admit-input")
      }
    },

    async compactSession(input) {
      try {
        const request = requireCompactSessionRequest(input)
        await resumeRequired(request.sessionId)
        throw conflict(
          "Manual compaction is not exposed by the live Session boundary.",
          { sessionId: request.sessionId },
        )
      } catch (error) {
        return fail(error, reporter, "compact-session")
      }
    },

    async cancelInput(input) {
      try {
        const request = requireCancelInputRequest(input)
        await resumeRequired(request.sessionId)
        throw conflict(
          "Live Sessions do not keep a durable pending-input queue.",
          {
            sessionId: request.sessionId,
            inputId: request.inputId,
          },
        )
      } catch (error) {
        return fail(error, reporter, "cancel-input")
      }
    },

    async cancelTurn(input) {
      try {
        const request = requireCancelTurnRequest(input)
        const thread = await resumeRequired(request.sessionId)
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

function mapThreadSummary(thread: ThreadSummary): ApiSessionSummary {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    seq: thread.seq + 1,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.title === undefined ? {} : { title: thread.title }),
    ...(thread.workingDirectory === undefined
      ? {}
      : { workingDirectory: thread.workingDirectory }),
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

function mapStoredThread(
  stored: StoredThread,
  live: AgentThread | undefined,
  options: ThreadServerHandlerOptions,
): ApiSessionDetail {
  const rollout = stored.rollout.map((record) => record.item)
  const contexts = rollout.filter(
    (item): item is Extract<RolloutItem, { readonly type: "turn_context" }> =>
      item.type === "turn_context",
  )
  const inputs = rollout.filter(
    (item) =>
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
  const pendingPermissions =
    options.listPendingPermissions?.(stored.metadata.id) ?? []
  const currentContext = contexts.at(-1)
  const summary: ThreadSummary = {
    ...stored.metadata,
    seq: Math.max(0, threadSeq(stored) - 1),
  }
  return {
    ...mapThreadSummary(summary),
    ...(live?.snapshot().activeTurnId === undefined
      ? {}
      : { activeTurnId: live.snapshot().activeTurnId }),
    ...(currentContext === undefined
      ? {}
      : { currentModel: currentContext.context.selection }),
    ...(usage === undefined ? {} : { usage }),
    pendingInputs: [],
    pendingPermissions: pendingPermissions.map(
      ({ sessionId: _, ...entry }) => entry,
    ),
    counts: {
      inputs,
      pendingInputs: 0,
      turns,
      items,
      permissions: pendingPermissions.length,
      tools,
    },
  }
}

function mapRolloutEvent(
  record: StoredRolloutItem,
  threadId: string,
): StoredEventEnvelope {
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
    item.item.id.startsWith("input_") &&
    item.item.item.context === undefined
  ) {
    const text = item.item.item.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    return createEventEnvelope({
      ...base,
      event: {
        type: "input.admitted",
        data: {
          requestId: item.item.turnId,
          inputId: item.item.id,
          role: InputRole.User,
          content: {
            kind: "text",
            text,
            ...(item.item.item.images === undefined
              ? {}
              : {
                  attachments: item.item.item.images.flatMap((image) =>
                    "file" in image && typeof image.sizeBytes === "number"
                      ? [
                          {
                            name: image.file.path.split("/").at(-1) ?? "image",
                            mediaType: image.mediaType,
                            sizeBytes: image.sizeBytes,
                            detail: image.detail ?? "high",
                            file: image.file,
                          },
                        ]
                      : [],
                  ),
                }),
          },
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
        ? ({ status: "completed" } as const)
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
    type: "rollout.item",
    data: { item: item as unknown as import("../kernel/events.ts").JsonValue },
  }
}

function threadSeq(stored: StoredThread): number {
  const last = stored.rollout.at(-1)
  return last === undefined ? 0 : hostSeq(last)
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

function inputAttachments(
  stored: StoredThread,
  inputId: string,
): readonly ImageAttachment[] {
  const input = stored.rollout.find(
    (record) =>
      record.item.type === "response_item" && record.item.item.id === inputId,
  )
  if (input?.item.type !== "response_item") return []
  const message = input.item.item.item
  if (message.role !== "user" || message.images === undefined) return []
  return message.images.flatMap((image) =>
    "file" in image && typeof image.sizeBytes === "number"
      ? [
          {
            name: image.file.path.split("/").at(-1) ?? "image",
            mediaType: image.mediaType,
            sizeBytes: image.sizeBytes,
            detail: image.detail ?? "high",
            file: image.file,
          },
        ]
      : [],
  )
}

function requireRolloutAssets(
  options: ThreadServerHandlerOptions,
): RolloutAssets {
  if (options.rolloutAssets !== undefined) return options.rolloutAssets
  throw invalidInput("Forked image input requires rollout asset storage.")
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

function requireListSessionsRequest(input: unknown) {
  const record = requireRecord(input, "Session list request must be an object.")
  const limit = requireOptionalLimit(record.limit)
  const cursor = requireOptionalString(record.cursor, "cursor")
  const workingDirectory = requireOptionalString(
    record.workingDirectory,
    "workingDirectory",
  )

  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  }
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
      : requireForkTextContent(record.content, maxInputBytes)
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

function requireAdmitInputRequest(input: unknown, maxInputBytes: number) {
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
    content: requireAdmissionTextContent(record.content, maxInputBytes),
    ...optionalModelSelectionField(record, "modelSelection"),
    ...optionalInputRoleField(record, "role"),
    ...(parentInputId === undefined ? {} : { parentInputId }),
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

function requireForkTextContent(
  value: unknown,
  maxInputBytes: number,
): TextContent {
  if (isRecord(value) && value.attachments !== undefined) {
    throw invalidInput(
      "Fork content attachments are inherited and must not be provided.",
      { field: "content.attachments" },
    )
  }
  const content = requireAdmissionTextContent(value, maxInputBytes)
  return { kind: "text", text: content.text }
}

function requireAdmissionTextContent(
  value: unknown,
  maxInputBytes: number,
): AdmissionTextContent {
  if (!isRecord(value)) {
    throw invalidInput("content must be a text content object.")
  }
  if (value.kind === "text" && typeof value.text === "string") {
    if (Buffer.byteLength(value.text, "utf8") > maxInputBytes) {
      throw invalidInput(
        `content.text must not exceed ${maxInputBytes} bytes.`,
        {
          field: "content.text",
          maxBytes: maxInputBytes,
        },
      )
    }
    const attachments = requireImageAttachments(value.attachments)
    return {
      kind: "text",
      text: value.text,
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }
  throw invalidInput("content must include kind text and a string text value.")
}

function requireImageAttachments(value: unknown): readonly ImageAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw invalidInput("content.attachments must be an array.", {
      field: "content.attachments",
    })
  }
  return value.map((item, index) => requireImageAttachment(item, index))
}

function requireImageAttachment(
  value: unknown,
  index: number,
): ImageAttachment {
  if (!isRecord(value)) {
    throw invalidInput(`content.attachments[${index}] must be an image object.`)
  }
  const name = requireString(value.name, `content.attachments[${index}].name`)
  if (Buffer.byteLength(name, "utf8") > 255) {
    throw invalidInput(`content.attachments[${index}].name is too long.`)
  }
  const mediaType = value.mediaType
  if (
    mediaType !== "image/gif" &&
    mediaType !== "image/jpeg" &&
    mediaType !== "image/png" &&
    mediaType !== "image/webp"
  ) {
    throw invalidInput(
      `content.attachments[${index}].mediaType is not a supported image type.`,
    )
  }
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0
  ) {
    throw invalidInput(
      `content.attachments[${index}].sizeBytes must be positive.`,
    )
  }
  const detail = value.detail ?? "high"
  if (detail !== "high" && detail !== "original") {
    throw invalidInput(
      `content.attachments[${index}].detail must be high or original.`,
    )
  }
  return {
    name,
    mediaType,
    detail,
    sizeBytes: value.sizeBytes as number,
    file: requireRolloutAssetReference(value.file, index),
  }
}

function requireRolloutAssetReference(
  value: unknown,
  index: number,
): ImageAttachment["file"] {
  if (
    !isRecord(value) ||
    !isStorageKey(value.rolloutId) ||
    typeof value.path !== "string"
  ) {
    throw invalidInput(
      `content.attachments[${index}].file must be a rollout asset reference.`,
    )
  }
  return { rolloutId: value.rolloutId, path: value.path }
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
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      resource: "sessions",
      order: sessionListOrder,
      limit,
      anchor,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    }),
    "utf8",
  ).toString("base64url")
}

function decodeSessionListCursor(
  cursor: string,
  limit: number,
  workingDirectory: string | undefined,
): string {
  const payload = parseCursorPayload(cursor)
  if (
    payload.version === 1 &&
    payload.resource === "sessions" &&
    payload.order === sessionListOrder &&
    payload.limit === limit &&
    payload.workingDirectory === workingDirectory &&
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
