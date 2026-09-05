import { isKernelEvent } from "../../kernel/index.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { SessionDelivery, SessionEventHub } from "../event-hub.ts"
import type { ServerHandlers } from "../handlers.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "../operational-errors.ts"
import type {
  ApiHandlerResult,
  ApiPendingPermission,
  ApiReadSessionResponse,
} from "../protocol.ts"
import {
  sessionPermissionRequestMethod,
  type SessionPermissionRequestParams,
  type SessionPermissionRequestResult,
} from "./methods.ts"
import { INTERNAL_ERROR } from "./messages.ts"
import {
  isTurnTransitionRejection,
  type PendingServerRequest,
  type PendingServerRequests,
  TURN_TRANSITION_PENDING_REQUEST_REASON,
} from "./pending-requests.ts"

export type SessionSubscribeInput = Readonly<{
  connectionId: number
  sessionId: string
  after: number
}>

export type SessionSubscribeOutcome =
  | Readonly<{
      ok: true
      response: ApiReadSessionResponse
      // Runs after the subscribe response is sent: durable replay,
      // replayComplete, permission replay, then the reconciled live buffer.
      replay(): Promise<void>
    }>
  | Readonly<{ ok: false; result: ApiHandlerResult<never> }>

export type SessionSubscriptions = Readonly<{
  subscribe(input: SessionSubscribeInput): Promise<SessionSubscribeOutcome>
  unsubscribe(connectionId: number, sessionId: string): void
  removeConnection(connectionId: number): void
}>

export type SessionSubscriptionsOptions = Readonly<{
  handlers: ServerHandlers
  eventHub: SessionEventHub
  notify(connectionId: number, method: string, params: unknown): void
  // Sends a server→client request frame (id + method + params) to one
  // connection. The answer arrives as a response on any connection and
  // resolves the entry in pendingRequests.
  sendRequest(connectionId: number, request: PendingServerRequest): void
  pendingRequests: PendingServerRequests
  reportOperationalFailure?: OperationalFailureReporter
}>

const replayPageLimit = 500

// Per-Session subscription sets keyed by connection id, mirroring Codex:
// subscriptions hang off the Session, not the connection, so a second client
// attaches to live state. The flow reproduces the SSE contract: subscribe
// live first (buffering), read the snapshot, replay durable events
// after..snapshot.seq, mark the watermark, replay still-pending permissions,
// then reconcile buffered live deliveries against the snapshot.
export function createSessionSubscriptions(
  options: SessionSubscriptionsOptions,
): SessionSubscriptions {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const bySession = new Map<string, Map<number, { close(): void }>>()
  // One pending answer channel per permission request, shared by every
  // subscribed connection: the permission.requested publication fans out per
  // connection, so registration dedupes on sessionId:permissionRequestId.
  const pendingPermissionRequests = new Map<string, PendingServerRequest>()

  function ensurePermissionRequest(
    sessionId: string,
    permission: ApiPendingPermission,
  ): PendingServerRequest {
    const key = `${sessionId}:${permission.permissionRequestId}`
    const existing = pendingPermissionRequests.get(key)
    if (existing !== undefined) return existing
    const params: SessionPermissionRequestParams = { sessionId, ...permission }
    const registered = options.pendingRequests.register({
      sessionId,
      method: sessionPermissionRequestMethod,
      params,
    })
    const request: PendingServerRequest = {
      id: registered.id,
      method: sessionPermissionRequestMethod,
      params,
    }
    pendingPermissionRequests.set(key, request)
    const settle = (answer: SessionPermissionRequestResult): void => {
      void settlePermissionRequest(key, params, answer).then(undefined, onSettleFailure)
    }
    void registered.response.then(
      (result) => settle(parseAnswer(result)),
      (error: unknown) => {
        // A turn-transition abort means the Turn ended while nobody could
        // answer; the runtime already disposed of the wait, so stay silent.
        if (isTurnTransitionRejection(error)) {
          pendingPermissionRequests.delete(key)
          return
        }
        // Errored or undelivered answers fail closed (Codex's
        // ReviewDecision::denied("approval request failed")).
        settle(failedAnswer("The permission answer was not delivered."))
      },
    )
    return request
  }

  async function settlePermissionRequest(
    key: string,
    params: SessionPermissionRequestParams,
    answer: SessionPermissionRequestResult,
  ): Promise<void> {
    pendingPermissionRequests.delete(key)
    const result = await options.handlers.resolvePermission({
      sessionId: params.sessionId,
      turnId: params.turnId,
      permissionRequestId: params.permissionRequestId,
      behavior: answer.behavior,
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    })
    if (result.ok) return
    reportOperationalFailure(reporter, {
      component: "session-subscriptions",
      operation: "resolve-permission",
      cause: new Error(result.body.error.message),
      sessionId: params.sessionId,
      turnId: params.turnId,
    })
  }

  function onSettleFailure(error: unknown): void {
    reportOperationalFailure(reporter, {
      component: "session-subscriptions",
      operation: "resolve-permission",
      cause: error,
    })
  }

  function parseAnswer(result: unknown): SessionPermissionRequestResult {
    // Malformed answers fail closed, same as an errored response.
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return failedAnswer("The permission answer was malformed.")
    }
    const behavior = (result as Record<string, unknown>).behavior
    const decision =
      behavior === "allow" || behavior === "deny" ? behavior : undefined
    if (decision === undefined) {
      return failedAnswer("The permission answer was malformed.")
    }
    const reason = (result as Record<string, unknown>).reason
    if (typeof reason !== "object" || reason === null || Array.isArray(reason)) {
      return { behavior: decision }
    }
    const kind = (reason as Record<string, unknown>).kind
    if (typeof kind !== "string" || kind.trim() === "") {
      return { behavior: decision }
    }
    const message = (reason as Record<string, unknown>).message
    return {
      behavior: decision,
      reason: {
        kind,
        ...(typeof message === "string" ? { message } : {}),
      },
    }
  }

  function failedAnswer(message: string): SessionPermissionRequestResult {
    return {
      behavior: "deny",
      reason: { kind: "approval_request_failed", message },
    }
  }

  function remove(connectionId: number, sessionId: string): void {
    const set = bySession.get(sessionId)
    const entry = set?.get(connectionId)
    if (set === undefined || entry === undefined) return
    entry.close()
    set.delete(connectionId)
    if (set.size === 0) bySession.delete(sessionId)
  }

  async function subscribe(
    input: SessionSubscribeInput,
  ): Promise<SessionSubscribeOutcome> {
    // A repeat subscribe replaces the previous subscription with a fresh
    // replay, matching an SSE reconnect.
    remove(input.connectionId, input.sessionId)

    let live = false
    let closed = false
    let lastSeq = input.after
    const buffered: SessionDelivery[] = []

    const deliver = (delivery: SessionDelivery): void => {
      if (closed) return
      if (delivery.kind === "durable") {
        for (const event of delivery.events) {
          // Events published between the snapshot read and the replay can
          // arrive through the buffer as well; the cursor dedupes them.
          if (event.seq <= lastSeq) continue
          lastSeq = event.seq
          options.notify(input.connectionId, "session/event", {
            sessionId: input.sessionId,
            seq: event.seq,
            event,
          })
        }
        return
      }
      // Transient events never carry a durable cursor.
      if (delivery.event.type === "permission.requested") {
        // The same publication fans out to every subscribed connection; the
        // dedupe inside ensurePermissionRequest keeps one answer channel per
        // permission request, and whichever client answers first wins.
        const { type: _, sessionId: __, ...permission } = delivery.event
        const request = ensurePermissionRequest(input.sessionId, permission)
        options.sendRequest(input.connectionId, request)
      }
      options.notify(input.connectionId, "session/transient", delivery.event)
    }

    const hub = options.eventHub.subscribe(input.sessionId, (delivery) => {
      if (live) {
        deliver(delivery)
        return
      }
      buffered.push(delivery)
    })
    const entry = {
      close(): void {
        closed = true
        hub.close()
      },
    }
    const set = bySession.get(input.sessionId) ?? new Map()
    set.set(input.connectionId, entry)
    bySession.set(input.sessionId, set)

    const snapshot = await options.handlers.readSession({
      sessionId: input.sessionId,
    })
    if (!snapshot.ok) {
      remove(input.connectionId, input.sessionId)
      return { ok: false, result: snapshot }
    }
    const watermark = snapshot.body.session.seq
    // Entries the snapshot no longer lists belong to Turns that ended while
    // nobody was subscribed; rejecting them with the turn-transition marker
    // keeps the pending map bounded and their continuations silent.
    const snapshotPendingIds = new Set(
      snapshot.body.session.pendingPermissions.map(
        (permission) => permission.permissionRequestId,
      ),
    )
    for (const pending of options.pendingRequests.pendingForSession(
      input.sessionId,
    )) {
      const permissionRequestId =
        typeof pending.params === "object" &&
        pending.params !== null &&
        "permissionRequestId" in pending.params &&
        typeof pending.params.permissionRequestId === "string"
          ? pending.params.permissionRequestId
          : undefined
      if (
        permissionRequestId !== undefined &&
        snapshotPendingIds.has(permissionRequestId)
      ) {
        continue
      }
      pendingPermissionRequests.delete(
        `${input.sessionId}:${permissionRequestId}`,
      )
      options.pendingRequests.reject(pending.id, {
        code: INTERNAL_ERROR,
        message: "client request resolved because the turn state was changed",
        data: { reason: TURN_TRANSITION_PENDING_REQUEST_REASON },
      })
    }

    const replay = async (): Promise<void> => {
      try {
        let cursor = input.after
        for (;;) {
          if (closed) return
          const page = await options.handlers.readSessionEvents({
            sessionId: input.sessionId,
            after: cursor,
            through: watermark,
            limit: replayPageLimit,
          })
          if (!page.ok) throw new Error(page.body.error.message)
          for (const event of page.body.events) {
            deliver({ kind: "durable", events: [event] })
          }
          if (page.body.nextAfter === undefined) break
          cursor = page.body.nextAfter
        }
        if (closed) return
        options.notify(input.connectionId, "session/replayComplete", {
          sessionId: input.sessionId,
          seq: watermark,
        })
        // Still-pending permissions replay on every (re)subscribe so the
        // client can resolve them without a separate fetch; requests already
        // buffered live during replay win over the older snapshot read. Each
        // replayed permission also re-sends its answer channel as a
        // session/permission/request (register-or-reuse dedupe) so a
        // reconnected client can answer.
        for (const permission of unbufferedPendingPermissions(
          snapshot.body.session.pendingPermissions,
          buffered,
        )) {
          options.sendRequest(
            input.connectionId,
            ensurePermissionRequest(input.sessionId, permission),
          )
          options.notify(input.connectionId, "session/permissionRequested", {
            sessionId: input.sessionId,
            ...permission,
          })
        }
        reconcileBufferedSessionDeliveries(
          buffered,
          snapshot.body.session.activeTurnId,
          deliver,
        )
        buffered.length = 0
        live = true
      } catch (error) {
        // The subscribe response is already sent, so a replay failure cannot
        // become an error response; mirror the SSE stream teardown with a
        // session error and drop the subscription.
        remove(input.connectionId, input.sessionId)
        const failure: LiveSessionEvent = {
          type: "session.error",
          sessionId: input.sessionId,
          operation: "persistence",
          message: "Session event replay failed.",
          createdAt: new Date().toISOString(),
        }
        options.notify(input.connectionId, "session/transient", failure)
        reportOperationalFailure(reporter, {
          component: "session-subscriptions",
          operation: "replay",
          cause: error,
          sessionId: input.sessionId,
        })
      }
    }
    return { ok: true, response: snapshot.body, replay }
  }

  return {
    subscribe,
    unsubscribe: remove,
    removeConnection(connectionId) {
      for (const [sessionId, set] of bySession) {
        const entry = set.get(connectionId)
        if (entry === undefined) continue
        entry.close()
        set.delete(connectionId)
        if (set.size === 0) bySession.delete(sessionId)
      }
    },
  }
}

// Snapshot pendingPermissions that did not already arrive as live
// permission.requested transients during the replay window.
export function unbufferedPendingPermissions(
  pendingPermissions: readonly ApiPendingPermission[],
  buffered: readonly SessionDelivery[],
): readonly ApiPendingPermission[] {
  const bufferedRequestIds = new Set(
    buffered.flatMap((delivery) => {
      const event = delivery.kind === "transient" ? delivery.event : undefined
      return event?.type === "permission.requested"
        ? [event.permissionRequestId]
        : []
    }),
  )
  return pendingPermissions.filter(
    (permission) => !bufferedRequestIds.has(permission.permissionRequestId),
  )
}

// Reconciles client-only display events buffered during replay against the
// snapshot and the durable lifecycle facts that arrived after it. This closes
// the commit→publish window where a terminal Turn is already in the snapshot
// but an older buffered delta reaches the connection afterward.
export function reconcileBufferedSessionDeliveries(
  buffered: readonly SessionDelivery[],
  activeTurnId: string | undefined,
  deliver: (delivery: SessionDelivery) => void,
): void {
  let liveTurnId = activeTurnId
  for (const delivery of buffered) {
    if (delivery.kind === "transient" && isLiveDisplayEvent(delivery.event)) {
      if (delivery.event.turnId !== liveTurnId) continue
    }
    deliver(delivery)
    if (delivery.kind === "durable") {
      for (const event of delivery.events) {
        if (!isKernelEvent(event)) continue
        if (event.type === "turn.started") liveTurnId = event.data.turnId
        if (
          event.type === "turn.completed" &&
          event.data.turnId === liveTurnId
        ) {
          liveTurnId = undefined
        }
      }
    }
  }
}

function isLiveDisplayEvent(
  event: LiveSessionEvent,
): event is Extract<
  LiveSessionEvent,
  { readonly type: "item.started" | "assistant.delta" | "reasoning.delta" }
> {
  return (
    event.type === "item.started" ||
    event.type === "assistant.delta" ||
    event.type === "reasoning.delta"
  )
}
