import {
  INTERNAL_ERROR,
  type JsonRpcErrorObject,
  type RequestId,
} from "./messages.ts"

// Marker carried in the rejection data when a turn transition aborts a pending
// server→client request; handlers distinguish it from a user denial and return
// silently. Matches Codex's turnTransition reason.
export const TURN_TRANSITION_PENDING_REQUEST_REASON = "turnTransition"

export type PendingServerRequest = Readonly<{
  id: RequestId
  method: string
  params?: unknown
}>

export type RegisteredServerRequest = Readonly<{
  id: RequestId
  response: Promise<unknown>
  drop(): void
}>

// Rejection produced when the transport send failed after register(); the
// awaiting side must not hang on a request the client never saw.
export class ServerRequestNotDeliveredError extends Error {
  constructor(method: string) {
    super(`server request "${method}" was not delivered to a client`)
    this.name = "ServerRequestNotDeliveredError"
  }
}

// Rejection produced when the client answered with an error or the server
// cancelled the request.
export class ServerRequestRejectedError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: JsonRpcErrorObject) {
    super(error.message)
    this.name = "ServerRequestRejectedError"
    this.code = error.code
    if ("data" in error) this.data = error.data
  }
}

export function isTurnTransitionRejection(error: unknown): boolean {
  if (!(error instanceof ServerRequestRejectedError)) return false
  const data = error.data
  if (typeof data !== "object" || data === null || !("reason" in data)) {
    return false
  }
  return data.reason === TURN_TRANSITION_PENDING_REQUEST_REASON
}

type PendingEntry = {
  sessionId: string
  method: string
  params?: unknown
  resolve(value: unknown): void
  reject(reason: unknown): void
}

// Process-wide registry of server→client requests awaiting a client answer,
// mirroring Codex's OutgoingMessageSender pending map: ids are process-global,
// so a response is accepted from whichever connection it arrives on.
export class PendingServerRequests {
  private nextId = 0
  private readonly pending = new Map<RequestId, PendingEntry>()

  register(request: {
    sessionId: string
    method: string
    params?: unknown
  }): RegisteredServerRequest {
    const id = this.nextId++
    let resolvePromise: ((value: unknown) => void) | undefined
    let rejectPromise: ((reason: unknown) => void) | undefined
    const response = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    // A pending request can outlive every awaiting caller (e.g. a shutdown
    // cancellation); like Codex's dropped oneshot receiver that is not an
    // error, so such rejections must not surface as unhandled.
    response.catch(() => {})
    const entry: PendingEntry = {
      sessionId: request.sessionId,
      method: request.method,
      resolve: (value) => resolvePromise?.(value),
      reject: (reason) => rejectPromise?.(reason),
      ...(request.params === undefined ? {} : { params: request.params }),
    }
    this.pending.set(id, entry)
    return {
      id,
      response,
      drop: () => {
        if (this.pending.delete(id)) {
          entry.reject(new ServerRequestNotDeliveredError(request.method))
        }
      },
    }
  }

  resolve(id: RequestId, result: unknown): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.resolve(result)
    return true
  }

  reject(id: RequestId, error: JsonRpcErrorObject): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.reject(new ServerRequestRejectedError(error))
    return true
  }

  // Unanswered requests of one session, for replay to a reconnected
  // connection. Ids increase monotonically, so map order is id order.
  pendingForSession(sessionId: string): ReadonlyArray<PendingServerRequest> {
    return [...this.pending.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([id, entry]) => ({
        id,
        method: entry.method,
        ...(entry.params === undefined ? {} : { params: entry.params }),
      }))
  }

  cancelForSession(sessionId: string, message: string): void {
    this.rejectMatching((entry) => entry.sessionId === sessionId, {
      code: INTERNAL_ERROR,
      message,
    })
  }

  cancelAll(message: string): void {
    this.rejectMatching(() => true, { code: INTERNAL_ERROR, message })
  }

  abortForTurnTransition(sessionId: string): void {
    this.rejectMatching((entry) => entry.sessionId === sessionId, {
      code: INTERNAL_ERROR,
      message: "client request resolved because the turn state was changed",
      data: { reason: TURN_TRANSITION_PENDING_REQUEST_REASON },
    })
  }

  private rejectMatching(
    matches: (entry: PendingEntry) => boolean,
    error: JsonRpcErrorObject,
  ): void {
    const entries = [...this.pending.entries()].filter(([, entry]) =>
      matches(entry),
    )
    for (const [id, entry] of entries) {
      this.pending.delete(id)
      entry.reject(new ServerRequestRejectedError(error))
    }
  }
}
