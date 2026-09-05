import packageJson from "../../../package.json" with { type: "json" }
import type { StoredEventEnvelope } from "../../kernel/index.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { ApiErrorCode } from "../../server/protocol.ts"
import type {
  ProjectChangedNotification,
  RpcMethodParams,
  RpcMethodResponses,
  SessionEventNotification,
  SessionPermissionRequestParams,
  SessionPermissionRequestResult,
  SessionReplayCompleteNotification,
  SessionSubscribeResponse,
} from "../../server/rpc/methods.ts"

// The GUI's only server channel: JSON-RPC over one WebSocket at /rpc,
// reproducing the old REST+SSE behavior — snapshot via the session/subscribe
// response, durable/transient deliveries as notifications, replay-complete as
// a notification, and permission answers as responses to the server's
// session/permission/request.

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | undefined

  constructor(message: string, code?: ApiErrorCode) {
    super(message)
    this.name = "ApiRequestError"
    this.code = code
  }
}

export function rpcUrl(apiBase: string): string {
  const url = new URL(apiBase)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/rpc"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export type SessionStreamHandlers = {
  readonly onSnapshot: (response: SessionSubscribeResponse) => void
  readonly onEvent: (event: StoredEventEnvelope) => void
  readonly onTransient: (event: LiveSessionEvent) => void
  readonly onReplayComplete: () => void
  // Terminal subscription failure (e.g. the Session is gone after a
  // reconnect); the stream is closed before this fires.
  readonly onError?: (error: unknown) => void
}

export type SessionStream = {
  readonly sessionId: string
  close(): void
}

type AppMethod = Exclude<
  keyof RpcMethodParams & keyof RpcMethodResponses,
  "initialize"
>

export type AppRpcClient = {
  request<M extends AppMethod>(
    method: M,
    params: RpcMethodParams[M],
  ): Promise<RpcMethodResponses[M]>
  openSessionStream(
    sessionId: string,
    after: number,
    handlers: SessionStreamHandlers,
  ): SessionStream
  // Registers a listener for server-broadcast project/changed notifications;
  // returns the unsubscribe function.
  subscribeToProjectChanges(
    listener: (notification: ProjectChangedNotification) => void,
  ): () => void
  // Answers the pending session/permission/request for this permission;
  // throws when no answer channel is open (e.g. already answered, or the
  // request pruned while disconnected).
  answerPermission(
    permissionRequestId: string,
    result: SessionPermissionRequestResult,
  ): void
  close(): void
}

type StreamRecord = {
  readonly handlers: SessionStreamHandlers
  readonly sessionId: string
  lastSeq: number
  closed: boolean
}

const reconnectBaseDelayMs = 250
const reconnectMaxDelayMs = 5_000

// One client per API origin: the store asks for the client on every action so
// tests can substitute a fake between runs without resetting module state.
const clients = new Map<string, AppRpcClient>()

export function getAppRpcClient(apiBase: string): AppRpcClient {
  const existing = clients.get(apiBase)
  if (existing !== undefined) return existing
  const client = createAppRpcClient({ apiBase })
  clients.set(apiBase, client)
  return client
}

export function createAppRpcClient(options: {
  readonly apiBase: string
  readonly version?: string
}): AppRpcClient {
  const url = rpcUrl(options.apiBase)
  let socket: WebSocket | undefined
  let ready = false
  let closed = false
  let connecting: Promise<void> | undefined
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let nextId = 1
  const inflight = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >()
  const streams = new Map<string, StreamRecord>()
  // Answer channels for server→client permission requests, keyed by
  // permissionRequestId; ids are process-global on the server, so a responder
  // stays valid across reconnects until answered or pruned.
  const permissionResponders = new Map<string, { readonly id: number }>()
  const projectChangeListeners = new Set<
    (notification: ProjectChangedNotification) => void
  >()

  function send(frame: unknown): void {
    socket?.send(JSON.stringify(frame))
  }

  function ensureConnection(): Promise<void> {
    if (closed) {
      return Promise.reject(new ApiRequestError("The client is closed."))
    }
    if (ready) return Promise.resolve()
    connecting ??= open()
    return connecting
  }

  function open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      socket = ws
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        connecting = undefined
        reject(
          error instanceof Error
            ? error
            : new ApiRequestError("Could not connect to the server."),
        )
      }
      ws.addEventListener("open", () => {
        // The handshake runs over the same correlation as every request.
        sendInitialize(ws, resolve, fail, () => settled)
      })
      ws.addEventListener("error", () => fail(undefined))
      ws.addEventListener("close", () => {
        fail(undefined)
        onSocketClosed(ws)
      })
      ws.addEventListener("message", (event) => {
        onMessage(typeof event.data === "string" ? event.data : "")
      })
    })
  }

  function sendInitialize(
    ws: WebSocket,
    resolve: () => void,
    fail: (error: unknown) => void,
    settled: () => boolean,
  ): void {
    const id = 0
    inflight.set(id, {
      resolve: () => {
        if (settled()) return
        ready = true
        reconnectAttempt = 0
        connecting = undefined
        inflight.delete(id)
        send({ method: "initialized" })
        resubscribeAll()
        resolve()
      },
      reject: fail,
    })
    ws.send(
      JSON.stringify({
        id,
        method: "initialize",
        params: {
          clientInfo: {
            name: "yakitori-gui",
            version: options.version ?? packageJson.version,
          },
          capabilities: {},
        },
      }),
    )
  }

  function onSocketClosed(ws: WebSocket): void {
    if (socket !== ws) return
    socket = undefined
    ready = false
    const lost = new ApiRequestError("The connection to the server was lost.")
    for (const [id, pending] of inflight) {
      inflight.delete(id)
      pending.reject(lost)
    }
    if (closed) return
    // Bounded backoff: the delay growth is capped, attempts are not.
    const delay = Math.min(
      reconnectBaseDelayMs * 2 ** reconnectAttempt,
      reconnectMaxDelayMs,
    )
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void ensureConnection().catch(() => {})
    }, delay)
  }

  function onMessage(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message !== "object" || message === null) return
    if ("method" in message && "id" in message) {
      onServerRequest(
        message as { id: number; method: string; params?: unknown },
      )
      return
    }
    if ("method" in message) {
      onNotification(message as { method: string; params?: unknown })
      return
    }
    if (!("id" in message)) return
    const id = (message as { id: unknown }).id
    if (typeof id !== "number") return
    const pending = inflight.get(id)
    if (pending === undefined) return
    inflight.delete(id)
    if ("error" in message) {
      pending.reject(toApiRequestError(message.error))
      return
    }
    pending.resolve((message as Record<string, unknown>).result)
  }

  function onServerRequest(message: {
    id: number
    method: string
    params?: unknown
  }): void {
    if (message.method !== "session/permission/request") {
      send({
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${message.method}` },
      })
      return
    }
    const params = message.params as SessionPermissionRequestParams | undefined
    if (
      params === undefined ||
      typeof params.permissionRequestId !== "string"
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "Invalid permission request." },
      })
      return
    }
    // The store learns about the permission through the permission.requested
    // transient; this frame only opens the answer channel.
    permissionResponders.set(params.permissionRequestId, { id: message.id })
  }

  function onNotification(message: { method: string; params?: unknown }): void {
    if (message.method === "session/event") {
      const params = message.params as SessionEventNotification
      const record = streams.get(params.sessionId)
      if (record === undefined || record.closed) return
      record.lastSeq = Math.max(record.lastSeq, params.seq)
      record.handlers.onEvent(params.event)
      return
    }
    if (message.method === "session/transient") {
      dispatchTransient(message.params as LiveSessionEvent)
      return
    }
    if (message.method === "session/permissionRequested") {
      // The replay form of a still-pending permission; the store consumes it
      // as the same permission.requested transient the SSE stream produced.
      const params = message.params as SessionPermissionRequestParams
      dispatchTransient({ type: "permission.requested", ...params })
      return
    }
    if (message.method === "session/replayComplete") {
      const params = message.params as SessionReplayCompleteNotification
      const record = streams.get(params.sessionId)
      if (record === undefined || record.closed) return
      record.handlers.onReplayComplete()
      return
    }
    if (message.method === "project/changed") {
      const params = message.params as ProjectChangedNotification
      for (const listener of projectChangeListeners) listener(params)
    }
  }

  function dispatchTransient(event: LiveSessionEvent): void {
    const record = streams.get(event.sessionId)
    if (record === undefined || record.closed) return
    record.handlers.onTransient(event)
  }

  function resubscribeAll(): void {
    for (const record of streams.values()) {
      if (!record.closed) void subscribe(record)
    }
  }

  async function subscribe(record: StreamRecord): Promise<void> {
    try {
      // The server replays events after the cursor, so a reconnect only needs
      // the last durable seq this stream observed.
      const response = await request("session/subscribe", {
        sessionId: record.sessionId,
        after: record.lastSeq,
      })
      if (record.closed || streams.get(record.sessionId) !== record) return
      record.handlers.onSnapshot(response)
    } catch (error) {
      if (record.closed || streams.get(record.sessionId) !== record) return
      // A dropped connection is not terminal: the stream stays registered and
      // the next successful handshake re-subscribes it.
      if (!ready) return
      streams.delete(record.sessionId)
      record.closed = true
      record.handlers.onError?.(error)
    }
  }

  async function request<M extends AppMethod>(
    method: M,
    params: RpcMethodParams[M],
  ): Promise<RpcMethodResponses[M]> {
    await ensureConnection()
    const id = nextId++
    return new Promise<RpcMethodResponses[M]>((resolve, reject) => {
      inflight.set(id, {
        resolve: (value) => resolve(value as RpcMethodResponses[M]),
        reject,
      })
      send({ id, method, params })
    })
  }

  return {
    request,
    subscribeToProjectChanges(listener) {
      projectChangeListeners.add(listener)
      return () => {
        projectChangeListeners.delete(listener)
      }
    },
    openSessionStream(sessionId, after, handlers) {
      const record: StreamRecord = {
        sessionId,
        handlers,
        lastSeq: after,
        closed: false,
      }
      streams.set(sessionId, record)
      // When the socket is still connecting, the post-handshake
      // resubscribeAll picks the record up; subscribing here too would send
      // the session/subscribe request twice.
      if (ready) {
        void subscribe(record)
      } else {
        void ensureConnection().catch(() => {})
      }
      return {
        sessionId,
        close() {
          record.closed = true
          if (streams.get(sessionId) !== record) return
          streams.delete(sessionId)
          if (!ready) return
          // Best-effort server-side teardown; the response is uninteresting.
          void request("session/unsubscribe", { sessionId }).catch(() => {})
        },
      }
    },
    answerPermission(permissionRequestId, result) {
      const responder = permissionResponders.get(permissionRequestId)
      if (responder === undefined) {
        throw new ApiRequestError(
          "The permission request is no longer pending.",
        )
      }
      if (!ready) {
        throw new ApiRequestError("Not connected to the server.")
      }
      permissionResponders.delete(permissionRequestId)
      send({ id: responder.id, result })
    },
    close() {
      closed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      const current = socket
      socket = undefined
      current?.close()
      for (const [id, pending] of inflight) {
        inflight.delete(id)
        pending.reject(new ApiRequestError("The client is closed."))
      }
    },
  }
}

function toApiRequestError(error: unknown): ApiRequestError {
  if (typeof error !== "object" || error === null) {
    return new ApiRequestError("Request failed.")
  }
  const record = error as { message?: unknown; data?: unknown }
  const message =
    typeof record.message === "string" ? record.message : "Request failed."
  const data = record.data
  const code =
    typeof data === "object" && data !== null && "code" in data
      ? (data.code as ApiErrorCode)
      : undefined
  return new ApiRequestError(message, code)
}
