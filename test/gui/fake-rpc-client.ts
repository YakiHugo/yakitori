import type { SessionSidebar } from "../../src/core/session-sidebar.ts"
import type {
  SessionStream,
  SessionStreamHandlers,
} from "../../src/gui/lib/rpc-client.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import type { StoredEventEnvelope } from "../../src/kernel/index.ts"
import type { LiveSessionEvent } from "../../src/runtime/live-events.ts"
import type { ApiReadSessionResponse } from "../../src/server/protocol.ts"
import type {
  ProjectChangedNotification,
  SessionCompletedNotification,
  SessionPermissionRequestResult,
  SidebarChangedNotification,
} from "../../src/server/rpc/methods.ts"

// Test double for the GUI's RPC channel: subscriptions are driven explicitly
// (emit* mirrors the server's notifications), requests route through a
// per-test responder, and permission answers are recorded.

export class FakeSessionStream implements SessionStream {
  closed = false

  constructor(
    readonly sessionId: string,
    readonly after: number,
    private readonly handlers: SessionStreamHandlers,
  ) {}

  close(): void {
    this.closed = true
  }

  emitSnapshot(response: ApiReadSessionResponse): void {
    this.handlers.onSnapshot(response)
  }

  emitEvent(event: StoredEventEnvelope): void {
    this.handlers.onEvent(event)
  }

  emitTransient(event: LiveSessionEvent): void {
    this.handlers.onTransient(event)
  }

  emitReplayComplete(): void {
    this.handlers.onReplayComplete()
  }

  failSubscription(error: unknown): void {
    this.handlers.onError?.(error)
  }
}

export type FakeRequest = {
  readonly method: string
  readonly params: unknown
}

export class FakeRpcClient {
  readonly completionListeners = new Set<
    (notification: SessionCompletedNotification) => void
  >()
  subscribeToCompletions(
    listener: (notification: SessionCompletedNotification) => void,
  ): () => void {
    this.completionListeners.add(listener)
    return () => {
      this.completionListeners.delete(listener)
    }
  }
  emitCompletion(notification: SessionCompletedNotification): void {
    for (const listener of this.completionListeners) listener(notification)
  }
  sidebarResponse: SessionSidebar = { sections: [], entries: {} }
  readonly sidebarChangeListeners = new Set<
    (notification: SidebarChangedNotification) => void
  >()
  subscribeToSidebarChanges(
    listener: (notification: SidebarChangedNotification) => void,
  ) {
    this.sidebarChangeListeners.add(listener)
    return () => {
      this.sidebarChangeListeners.delete(listener)
    }
  }
  emitSidebarChanged(notification: SidebarChangedNotification): void {
    for (const listener of this.sidebarChangeListeners) listener(notification)
  }
  readonly streams: FakeSessionStream[] = []
  readonly requests: FakeRequest[] = []
  readonly answeredPermissions: {
    readonly permissionRequestId: string
    readonly result: SessionPermissionRequestResult
  }[] = []
  readonly projectChangeListeners: ((
    notification: ProjectChangedNotification,
  ) => void)[] = []

  // Per-test responder; the default mirrors a route that does not exist.
  respond: (method: string, params: unknown) => unknown = () => {
    throw new ApiRequestError("not found", "not_found" as never)
  }
  answerError: Error | undefined

  async request(method: string, params: unknown): Promise<unknown> {
    if (method === "sidebar/read") return this.sidebarResponse
    this.requests.push({ method, params })
    return await this.respond(method, params)
  }

  openSessionStream(
    sessionId: string,
    after: number,
    handlers: SessionStreamHandlers,
  ): FakeSessionStream {
    const stream = new FakeSessionStream(sessionId, after, handlers)
    this.streams.push(stream)
    return stream
  }

  answerPermission(
    permissionRequestId: string,
    result: SessionPermissionRequestResult,
  ): void {
    if (this.answerError !== undefined) throw this.answerError
    this.answeredPermissions.push({ permissionRequestId, result })
  }

  subscribeToProjectChanges(
    listener: (notification: ProjectChangedNotification) => void,
  ): () => void {
    this.projectChangeListeners.push(listener)
    return () => {
      const index = this.projectChangeListeners.indexOf(listener)
      if (index >= 0) this.projectChangeListeners.splice(index, 1)
    }
  }

  emitProjectChanged(notification: ProjectChangedNotification): void {
    for (const listener of [...this.projectChangeListeners]) {
      listener(notification)
    }
  }

  readonly sessionActivityListeners = new Set<
    (activeSessionIds: readonly string[] | undefined) => void
  >()
  subscribeToSessionActivity(
    listener: (activeSessionIds: readonly string[] | undefined) => void,
  ): () => void {
    this.sessionActivityListeners.add(listener)
    return () => {
      this.sessionActivityListeners.delete(listener)
    }
  }

  emitSessionActivity(activeSessionIds: readonly string[] | undefined): void {
    for (const listener of [...this.sessionActivityListeners]) {
      listener(activeSessionIds)
    }
  }

  close(): void {}

  requestsFor(method: string): FakeRequest[] {
    return this.requests.filter((request) => request.method === method)
  }
}
