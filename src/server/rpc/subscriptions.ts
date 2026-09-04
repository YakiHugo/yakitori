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
        // buffered live during replay win over the older snapshot read.
        for (const permission of unbufferedPendingPermissions(
          snapshot.body.session.pendingPermissions,
          buffered,
        )) {
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
