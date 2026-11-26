import { isKernelEvent } from "../../kernel/index.ts"
import type {
  LiveSessionSnapshot,
  OpenSessionSnapshot,
} from "../../protocol/rpc-methods.ts"
import {
  sessionEventMethod,
  sessionPermissionRequestedMethod,
  sessionPermissionRequestMethod,
  sessionLiveReadyMethod,
  sessionSubscriptionErrorMethod,
  sessionTransientMethod,
} from "../../protocol/rpc-wire.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { ApplicationResult } from "../application-result.ts"
import type {
  SessionDelivery,
  SessionEventHub,
  SessionEventSubscription,
} from "../event-hub.ts"
import type { ServerHandlers } from "../handlers.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "../operational-errors.ts"
import type { ApiPendingPermission } from "../protocol.ts"
import { INTERNAL_ERROR } from "./messages.ts"
import type {
  SessionPermissionRequestParams,
  SessionPermissionRequestResult,
  SessionSubscriptionErrorNotification,
} from "./methods.ts"
import {
  isTurnTransitionRejection,
  type PendingServerRequest,
  type PendingServerRequests,
  TURN_TRANSITION_PENDING_REQUEST_REASON,
} from "./pending-requests.ts"

// A busy session may replace its rollout more than once during a snapshot read.
const maxOpenSnapshotAttempts = 3

type SubscriptionEntry = { close(): void; keepOnReset(): boolean }

export type SessionSubscribeInput = Readonly<{
  connectionId: number
  sessionId: string
}>

export type SessionSubscribeOutcome<T = LiveSessionSnapshot> =
  | Readonly<{
      ok: true
      response: T
      // Called after the transport writes the response to this connection.
      startLiveDelivery(): Promise<void>
    }>
  | Readonly<{ ok: false; result: ApplicationResult<never> }>

export type SessionSubscriptions = Readonly<{
  subscribe(input: SessionSubscribeInput): Promise<SessionSubscribeOutcome>
  open(
    input: SessionSubscribeInput,
  ): Promise<SessionSubscribeOutcome<OpenSessionSnapshot>>
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

// Register the listener before capturing a watermark. Once the response is
// sent, release only buffered events that the snapshot does not already cover.
export function createSessionSubscriptions(
  options: SessionSubscriptionsOptions,
): SessionSubscriptions {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const bySession = new Map<string, Map<number, SubscriptionEntry>>()
  // One pending answer channel per permission request, shared by every
  // subscribed connection: the permission.requested publication fans out per
  // connection, so registration dedupes on sessionId:permissionRequestId.
  const pendingPermissionRequests = new Map<
    string,
    PendingServerRequest & { params: SessionPermissionRequestParams }
  >()
  // Permission channels can outlive the last client subscription. Keep their
  // reset observer until the final channel settles so an offline reset still
  // retires answers against the previous history.
  const permissionResetSubscriptions = new Map<
    string,
    SessionEventSubscription
  >()

  function releasePermissionResetSubscription(sessionId: string): void {
    for (const request of pendingPermissionRequests.values()) {
      if (request.params.sessionId === sessionId) return
    }
    permissionResetSubscriptions.get(sessionId)?.close()
    permissionResetSubscriptions.delete(sessionId)
  }

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
    const request = {
      id: registered.id,
      method: sessionPermissionRequestMethod,
      params,
    }
    pendingPermissionRequests.set(key, request)
    if (!permissionResetSubscriptions.has(sessionId)) {
      permissionResetSubscriptions.set(
        sessionId,
        options.eventHub.subscribe(sessionId, (delivery) => {
          if (delivery.kind === "reset") resetSession(sessionId)
        }),
      )
    }
    const settle = (answer: SessionPermissionRequestResult): void => {
      if (pendingPermissionRequests.get(key) !== request) return
      void settlePermissionRequest(key, params, answer).then(
        undefined,
        onSettleFailure,
      )
    }
    void registered.response.then(
      (result) => settle(parseAnswer(result)),
      (error: unknown) => {
        if (pendingPermissionRequests.get(key) !== request) return
        // A turn-transition abort means the Turn ended while nobody could
        // answer; the runtime already disposed of the wait, so stay silent.
        if (isTurnTransitionRejection(error)) {
          pendingPermissionRequests.delete(key)
          releasePermissionResetSubscription(sessionId)
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
    releasePermissionResetSubscription(params.sessionId)
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
      cause: new Error(result.error.message),
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
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      return failedAnswer("The permission answer was malformed.")
    }
    const behavior = (result as Record<string, unknown>).behavior
    const decision =
      behavior === "allow" || behavior === "deny" ? behavior : undefined
    if (decision === undefined) {
      return failedAnswer("The permission answer was malformed.")
    }
    const reason = (result as Record<string, unknown>).reason
    if (
      typeof reason !== "object" ||
      reason === null ||
      Array.isArray(reason)
    ) {
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

  function retirePermissionsForTurn(sessionId: string, turnId?: string): void {
    for (const [key, request] of pendingPermissionRequests) {
      if (
        request.params.sessionId !== sessionId ||
        (turnId !== undefined && request.params.turnId !== turnId)
      )
        continue
      pendingPermissionRequests.delete(key)
      options.pendingRequests.reject(request.id, {
        code: INTERNAL_ERROR,
        message: "client request resolved because the turn state was changed",
        data: { reason: TURN_TRANSITION_PENDING_REQUEST_REASON },
      })
    }
    releasePermissionResetSubscription(sessionId)
  }

  function remove(connectionId: number, sessionId: string): void {
    const set = bySession.get(sessionId)
    const entry = set?.get(connectionId)
    if (set === undefined || entry === undefined) return
    entry.close()
    set.delete(connectionId)
    if (set.size === 0) bySession.delete(sessionId)
  }

  function resetSession(sessionId: string): void {
    for (const [connectionId, entry] of bySession.get(sessionId) ?? []) {
      if (!entry.keepOnReset()) remove(connectionId, sessionId)
    }
    retirePermissionsForTurn(sessionId)
  }

  async function subscribe<T>(
    input: SessionSubscribeInput,
    readResponse: (
      snapshot: LiveSessionSnapshot,
    ) => Promise<ApplicationResult<T>>,
    maxAttempts = 1,
  ): Promise<SessionSubscribeOutcome<T>> {
    // A repeat subscribe replaces only this connection’s existing listener.
    remove(input.connectionId, input.sessionId)

    let live = false
    let closed = false
    let opening = maxAttempts > 1
    let invalidated = false
    let lastSeq = 0
    const buffered: SessionDelivery[] = []

    const deliver = (delivery: SessionDelivery): void => {
      if (closed) return
      if (delivery.kind === "reset") {
        resetSession(input.sessionId)
        return
      }
      if (delivery.kind === "durable") {
        for (const event of delivery.events) {
          if (isKernelEvent(event) && event.type === "turn.completed")
            retirePermissionsForTurn(input.sessionId, event.data.turnId)
          // Events published between the snapshot read and the replay can
          // arrive through the buffer as well; the cursor dedupes them.
          if (event.seq <= lastSeq) continue
          lastSeq = event.seq
          options.notify(input.connectionId, sessionEventMethod, {
            sessionId: input.sessionId,
            seq: event.seq,
            event: isKernelEvent(event)
              ? event
              : {
                  id: event.id,
                  sessionId: event.sessionId,
                  seq: event.seq,
                  version: event.version,
                  createdAt: event.createdAt,
                  type: "session.cursor",
                  data: {},
                },
          })
        }
        return
      }
      // Runtime termination also retires requests when persistence failed.
      if (delivery.event.type === "turn.finished")
        retirePermissionsForTurn(input.sessionId, delivery.event.turnId)
      // Transient events never carry a durable cursor.
      if (delivery.event.type === "permission.requested") {
        // The same publication fans out to every subscribed connection; the
        // dedupe inside ensurePermissionRequest keeps one answer channel per
        // permission request, and whichever client answers first wins.
        const { type: _, sessionId: __, ...permission } = delivery.event
        const request = ensurePermissionRequest(input.sessionId, permission)
        options.sendRequest(input.connectionId, request)
      }
      options.notify(input.connectionId, sessionTransientMethod, delivery.event)
    }

    const hub = options.eventHub.subscribe(input.sessionId, (delivery) => {
      if (closed) return
      if (delivery.kind === "reset") {
        resetSession(input.sessionId)
        return
      }
      if (live) {
        deliver(delivery)
        return
      }
      buffered.push(delivery)
    })
    const entry: SubscriptionEntry = {
      keepOnReset(): boolean {
        if (!opening) return false
        // Keep the same listener so a disconnect or replacement still owns
        // cancellation, and a new attempt can buffer the new rollout's tail.
        invalidated = true
        buffered.length = 0
        return true
      },
      close(): void {
        if (closed) return
        closed = true
        buffered.length = 0
        hub.close()
      },
    }
    const set = bySession.get(input.sessionId) ?? new Map()
    set.set(input.connectionId, entry)
    bySession.set(input.sessionId, set)

    const removeOwnedSubscription = (): void => {
      if (bySession.get(input.sessionId)?.get(input.connectionId) === entry)
        remove(input.connectionId, input.sessionId)
      else entry.close()
    }
    const invalidatedSnapshot: ApplicationResult<never> = {
      ok: false,
      error: {
        code: "conflict",
        message: "Session subscription changed while reading its snapshot.",
      },
    }

    const readAttempt = async (): Promise<
      ApplicationResult<{ snapshot: LiveSessionSnapshot; response: T }>
    > => {
      const snapshot = await options.handlers.readLiveSession({
        sessionId: input.sessionId,
      })
      if (closed || invalidated) return invalidatedSnapshot
      if (!snapshot.ok) return snapshot
      const response = await readResponse(snapshot.value)
      return response.ok
        ? {
            ok: true,
            value: { snapshot: snapshot.value, response: response.value },
          }
        : response
    }

    let captured: Awaited<ReturnType<typeof readAttempt>>
    let pendingBeforeSnapshot: readonly PendingServerRequest[]
    try {
      for (let attempt = 1; ; attempt++) {
        invalidated = false
        // Only reconcile answer channels that predate the successful read.
        pendingBeforeSnapshot = options.pendingRequests.pendingForSession(
          input.sessionId,
        )
        captured = await readAttempt()
        if (closed || invalidated) captured = invalidatedSnapshot
        if (
          captured.ok ||
          closed ||
          captured.error.code !== "conflict" ||
          attempt >= maxAttempts
        )
          break
      }
    } catch (error) {
      // No replay consumer is returned on a rejected read. Release only our
      // listener; a newer subscription for the same key can already exist.
      removeOwnedSubscription()
      throw error
    }
    opening = false
    if (!captured.ok) {
      removeOwnedSubscription()
      return { ok: false, result: captured }
    }
    const { snapshot, response } = captured.value
    const watermark = snapshot.watermarkSeq
    lastSeq = watermark
    // Entries the snapshot no longer lists belong to Turns that ended while
    // nobody was subscribed; rejecting them with the turn-transition marker
    // keeps the pending map bounded and their continuations silent.
    const snapshotPendingIds = new Set(
      snapshot.session.pendingPermissions.map(
        (permission) => permission.permissionRequestId,
      ),
    )
    for (const pending of pendingBeforeSnapshot) {
      // Permission snapshots can only retire permission requests. Other
      // interactions have their own owners and cancellation contracts.
      if (pending.method !== sessionPermissionRequestMethod) continue
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
    releasePermissionResetSubscription(input.sessionId)

    const startLiveDelivery = async (): Promise<void> => {
      try {
        if (closed) return
        options.notify(input.connectionId, sessionLiveReadyMethod, {
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
          snapshot.session.pendingPermissions,
          buffered,
        )) {
          options.sendRequest(
            input.connectionId,
            ensurePermissionRequest(input.sessionId, permission),
          )
          options.notify(input.connectionId, sessionPermissionRequestedMethod, {
            sessionId: input.sessionId,
            ...permission,
          })
        }
        reconcileBufferedSessionDeliveries(
          buffered,
          snapshot.session.activeTurnId,
          deliver,
        )
        buffered.length = 0
        live = true
      } catch (error) {
        // The subscribe response is already sent, so a replay failure cannot
        // become an error response. A replaced or closed subscription must
        // not terminate the current subscription for the same session.
        if (!closed) {
          removeOwnedSubscription()
          options.notify(input.connectionId, sessionSubscriptionErrorMethod, {
            sessionId: input.sessionId,
            message: "Session live delivery could not start.",
          } satisfies SessionSubscriptionErrorNotification)
        }
        reportOperationalFailure(reporter, {
          component: "session-subscriptions",
          operation: "start-live-delivery",
          cause: error,
          sessionId: input.sessionId,
        })
      }
    }
    return {
      ok: true,
      response,
      startLiveDelivery,
    }
  }

  return {
    subscribe: (input) =>
      subscribe(input, async (snapshot) => ({ ok: true, value: snapshot })),
    open: (input) =>
      subscribe(
        input,
        async (snapshot) => {
          const history = await options.handlers.listCompletedTurns({
            sessionId: input.sessionId,
            rolloutId: snapshot.session.rolloutId,
            view: "summary",
            through: snapshot.watermarkSeq,
            activeTurnId: snapshot.activeTurn?.turnId,
          })
          if (!history.ok) return history
          if (
            history.value.view !== "summary" ||
            history.value.seq !== snapshot.watermarkSeq ||
            history.value.rolloutId !== snapshot.session.rolloutId
          )
            return {
              ok: false,
              error: {
                code: "conflict",
                message: "Session history changed while opening.",
              },
            }
          return { ok: true, value: { ...snapshot, history: history.value } }
        },
        maxOpenSnapshotAttempts,
      ),
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
function unbufferedPendingPermissions(
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
// snapshot and lifecycle events that arrived after it. This closes
// the commit→publish window where a terminal Turn is already in the snapshot
// but an older buffered delta reaches the connection afterward.
export function reconcileBufferedSessionDeliveries(
  buffered: readonly SessionDelivery[],
  activeTurnId: string | undefined,
  deliver: (delivery: SessionDelivery) => void,
): void {
  // Progress can already have been replayed from the snapshot watermark, so
  // its buffered duplicate will be skipped by the durable cursor. Do not let
  // an older buffered retry revive an activity that this progress superseded.
  const supersededRetries = new Set<SessionDelivery>()
  const progressedTurns = new Set<string>()
  for (let index = buffered.length - 1; index >= 0; index -= 1) {
    const delivery = buffered[index]
    if (delivery?.kind === "durable") {
      for (const event of delivery.events) {
        if (
          isKernelEvent(event) &&
          (event.type === "turn.started" ||
            event.type === "turn.completed" ||
            event.type === "item.started" ||
            event.type === "item.completed")
        ) {
          progressedTurns.add(event.data.turnId)
        }
      }
    } else if (delivery?.kind === "transient") {
      const event = delivery.event
      if (event.type === "runtime.warning") {
        if (event.code !== "model.retry") continue
        if (progressedTurns.has(event.turnId)) supersededRetries.add(delivery)
        progressedTurns.add(event.turnId)
      } else if ("turnId" in event) {
        progressedTurns.add(event.turnId)
      }
    }
  }
  let liveTurnId = activeTurnId
  for (const delivery of buffered) {
    if (supersededRetries.has(delivery)) continue
    if (delivery.kind === "transient" && isLiveDisplayEvent(delivery.event)) {
      if (delivery.event.turnId !== liveTurnId) continue
    }
    deliver(delivery)
    if (
      delivery.kind === "transient" &&
      delivery.event.type === "turn.finished" &&
      delivery.event.turnId === liveTurnId
    ) {
      liveTurnId = undefined
    }
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

function isLiveDisplayEvent(event: LiveSessionEvent): event is Extract<
  LiveSessionEvent,
  Readonly<{
    type:
      | "item.started"
      | "item.discarded"
      | "assistant.delta"
      | "reasoning.delta"
      | "tool.output.delta"
  }>
> {
  return (
    event.type === "item.started" ||
    event.type === "item.discarded" ||
    event.type === "assistant.delta" ||
    event.type === "reasoning.delta" ||
    event.type === "tool.output.delta"
  )
}
