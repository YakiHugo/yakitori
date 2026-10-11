import type { StoredThread } from "../core/rollout.ts"
import type { ThreadManager } from "../core/thread-manager.ts"
import type { ThreadStore } from "../core/thread-store.ts"
import { createUserInput } from "../core/user-input.ts"
import {
  createThreadReader,
  ThreadCollaborationError,
} from "./thread-collaboration-read.ts"

export { ThreadCollaborationError } from "./thread-collaboration-read.ts"
export type {
  ListThreadsInput,
  ReadThreadInput,
} from "./thread-collaboration-read.ts"
export type ThreadRequest = Readonly<{
  threadId: string
  turnId: string
  requestId: string
}>
export type ThreadRequestResult = ThreadRequest &
  Readonly<{
    status:
      | "running"
      | "completed"
      | "failed"
      | "interrupted"
      | "delivery_incomplete"
      | "not_found"
    consumed: boolean
    answerItemIds?: readonly string[]
    error?: string
  }>
export type ThreadCollaboration = ReturnType<typeof createThreadCollaboration>
export type BoundThreadCollaboration = ReturnType<ThreadCollaboration["bind"]>

// Same-service collaboration is separate from subagent ownership. Durable
// admission and consumption live in the recipient rollout, so callers can
// resume tracking a returned request without an in-memory task registry.
export function createThreadCollaboration(input: {
  store: ThreadStore
  getThreadManager: () => ThreadManager
}) {
  const reader = createThreadReader(input)
  return {
    bind(sourceThreadId: string) {
      return {
        list: reader.list,
        read: reader.read,
        async send(request: {
          threadId: string
          requestId: string
          message: string
        }) {
          if (
            !request.requestId ||
            request.requestId.length > 512 ||
            !request.message.trim() ||
            request.message.length > 65_536
          )
            throw new ThreadCollaborationError(
              "invalid_input",
              "A request_id of at most 512 characters and a non-empty message of at most 65536 characters are required.",
            )
          if (sourceThreadId === request.threadId)
            throw new ThreadCollaborationError(
              "self_target",
              "Send to another thread; use the current turn for your own work.",
            )
          const manager = input.getThreadManager()
          if ((await input.store.readThread(sourceThreadId)) === undefined)
            throw new ThreadCollaborationError(
              "source_not_found",
              "The source thread no longer exists.",
            )
          const storedTarget = await input.store.readThread(request.threadId)
          const targetAgent = storedTarget?.metadata.metadata?.agent
          if (
            typeof targetAgent === "object" &&
            targetAgent !== null &&
            !Array.isArray(targetAgent) &&
            targetAgent.kind === "subagent"
          )
            throw new ThreadCollaborationError(
              "target_is_subagent",
              "This target belongs to a subagent tree. Use its owning agent controller instead of independent-session messaging.",
            )
          const target = await manager.resumeThread(request.threadId)
          if (target === undefined)
            throw new ThreadCollaborationError(
              "thread_not_found",
              `Thread ${request.threadId} was not found in this service's store.`,
            )
          const admitted = await target.startOrSteer({
            submissionId: submissionId(sourceThreadId, request.requestId),
            content: createUserInput(request.message),
            provenance: { sourceThreadId, sourceRequestId: request.requestId },
          })
          if (admitted.type === "not_submitted")
            throw new ThreadCollaborationError(
              admitted.reason,
              admitted.reason === "request_conflict"
                ? "This request_id was already used with different content. Reuse IDs only for an identical retry."
                : "The recipient did not accept this message. Retry with the same request_id after its turn finishes.",
            )
          return {
            accepted: true as const,
            requestId: request.requestId,
            threadId: request.threadId,
            turnId: admitted.turnId,
            delivery: admitted.type,
          }
        },
        async wait(
          requests: readonly ThreadRequest[],
          timeoutMs = 30_000,
          signal?: AbortSignal,
        ) {
          if (
            !requests.length ||
            requests.length > 100 ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 0 ||
            timeoutMs > 300_000
          )
            throw new ThreadCollaborationError(
              "invalid_input",
              "Wait requires 1 to 100 requests and timeout_ms between 0 and 300000.",
            )
          const manager = input.getThreadManager()
          let generation = 0
          let notify = () => {}
          const subscriptions: Array<() => void> = []
          const subscribed = new Set<string>()
          const changed = () => {
            generation++
            notify()
          }
          const subscribe = (threadId: string) => {
            if (subscribed.has(threadId)) return
            const thread = manager.getThread(threadId)
            if (thread === undefined) return
            subscribed.add(threadId)
            subscriptions.push(thread.subscribeStatus(changed))
          }
          const deadline = Date.now() + timeoutMs
          try {
            for (const request of requests) subscribe(request.threadId)
            // A recipient can be resumed while the waiter is reading storage.
            subscriptions.push(
              manager.subscribeThreadInstalled(async (thread) => {
                if (
                  requests.some((request) => request.threadId === thread.id)
                ) {
                  subscribe(thread.id)
                  changed()
                }
              }),
            )
            for (;;) {
              const observed = generation
              const results = await Promise.all(
                requests.map(async (request) => {
                  // Observe liveness before the history read. A Turn can finish
                  // while storage is resolving; a stale read must stay running
                  // until the status notification forces a fresh terminal read.
                  const activeTurnId = manager
                    .getThread(request.threadId)
                    ?.snapshot().activeTurnId
                  const stored = await input.store.readThread(request.threadId)
                  return requestResult(
                    stored,
                    request,
                    sourceThreadId,
                    activeTurnId,
                  )
                }),
              )
              if (signal?.aborted)
                return { reason: "aborted" as const, results }
              if (results.some((result) => result.status !== "running"))
                return { reason: "completed" as const, results }
              const remaining = deadline - Date.now()
              if (remaining <= 0) return { reason: "timeout" as const, results }
              if (generation !== observed) continue
              await new Promise<void>((resolve) => {
                const done = () => {
                  clearTimeout(timer)
                  signal?.removeEventListener("abort", done)
                  notify = () => {}
                  resolve()
                }
                const timer = setTimeout(done, remaining)
                notify = done
                signal?.addEventListener("abort", done, { once: true })
                if (signal?.aborted || generation !== observed) done()
              })
            }
          } finally {
            for (const unsubscribe of subscriptions) unsubscribe()
          }
        },
      }
    },
  }
}
function submissionId(sourceThreadId: string, requestId: string) {
  return `thread-message:${JSON.stringify([sourceThreadId, requestId])}`
}
function requestResult(
  stored: StoredThread | undefined,
  request: ThreadRequest,
  sourceThreadId: string,
  activeTurnId: string | undefined,
): ThreadRequestResult {
  if (stored === undefined)
    return { ...request, status: "not_found", consumed: false }
  const id = submissionId(sourceThreadId, request.requestId)
  const admission = stored.rollout.find(
    ({ item }) =>
      item.type === "thread_message_admitted" &&
      item.submissionId === id &&
      item.sourceThreadId === sourceThreadId &&
      item.sourceRequestId === request.requestId &&
      item.targetTurnId === request.turnId,
  )
  if (admission === undefined)
    return { ...request, status: "not_found", consumed: false }
  const consumed = stored.rollout.some(
    ({ item }) =>
      item.type === "thread_message_consumed" &&
      item.submissionId === id &&
      item.targetTurnId === request.turnId,
  )
  const terminal = stored.rollout.find(
    ({ item }) =>
      item.type === "turn_completed" && item.turnId === request.turnId,
  )?.item
  if (terminal?.type === "turn_completed") {
    if (!consumed)
      return { ...request, status: "delivery_incomplete", consumed }
    return {
      ...request,
      status:
        terminal.outcome === "completed"
          ? "completed"
          : terminal.outcome === "failed"
            ? "failed"
            : "interrupted",
      consumed,
      answerItemIds:
        terminal.completion?.answerItemIds ??
        stored.rollout
          .flatMap(({ item }) =>
            item.type === "response_item" &&
            item.item.turnId === request.turnId &&
            item.item.item.role === "assistant"
              ? [item.item.id]
              : [],
          )
          .slice(-1),
      ...(terminal.error === undefined
        ? {}
        : { error: terminal.error.message }),
    }
  }
  return {
    ...request,
    status:
      activeTurnId === request.turnId
        ? "running"
        : consumed
          ? "interrupted"
          : "delivery_incomplete",
    consumed,
  }
}
