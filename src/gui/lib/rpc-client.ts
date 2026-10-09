import packageJson from "../../../package.json" with { type: "json" }
import type { ApiErrorCode } from "../../protocol/application.ts"
import type { AppSessionEventEnvelope } from "../../protocol/events.ts"
import type { LiveSessionEvent } from "../../protocol/live-events.ts"
import {
  type JsonRpcMessage,
  JsonRpcParseError,
  parseJsonRpcMessage,
  type RequestId,
} from "../../protocol/rpc-messages.ts"
import type {
  GoalChangedNotification,
  McpStatusChangedNotification,
  ProjectChangedNotification,
  RpcMethodParams,
  RpcMethodResponses,
  SessionCompletedNotification,
  SessionEventNotification,
  SessionPermissionRequestParams,
  SessionPermissionRequestResult,
  SessionReplayCompleteNotification,
  SessionSubscribeResponse,
  SessionSubscriptionErrorNotification,
  SidebarChangedNotification,
} from "../../protocol/rpc-methods.ts"
import {
  goalChangedMethod,
  mcpStatusChangedMethod,
  projectChangedMethod,
  providerConfigurationChangedMethod,
  sessionCompletedMethod,
  sessionEventMethod,
  sessionPermissionRequestedMethod,
  sessionPermissionRequestMethod,
  sessionQueueChangedMethod,
  sessionReplayCompleteMethod,
  sessionSubscriptionErrorMethod,
  sessionsActivityMethod,
  sessionTransientMethod,
  sidebarChangedMethod,
  sideChatChangedMethod,
  websocketRpcPath,
} from "../../protocol/rpc-wire.ts"
import type { SideChatSnapshot } from "../../protocol/side-chat.ts"

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
  url.pathname = websocketRpcPath
  url.search = ""
  url.hash = ""
  return url.toString()
}

export type SessionStreamHandlers = {
  readonly onSnapshot: (response: SessionSubscribeResponse) => void
  readonly onEvent: (event: AppSessionEventEnvelope) => void
  readonly onTransient: (event: LiveSessionEvent) => void
  readonly onReplayComplete: () => void
  // The stream stays registered and will be re-subscribed after reconnect.
  readonly onDisconnected?: (error: unknown) => void
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
  subscribeToEngineSessionChanges(
    listener: (sessionId: string | undefined) => void,
  ): () => void
  subscribeToProviderChanges(listener: () => void): () => void
  subscribeToGoalChanges(
    listener: (notification: GoalChangedNotification | undefined) => void,
  ): () => void
  subscribeToCompletions(
    listener: (notification: SessionCompletedNotification) => void,
  ): () => void
  subscribeToSideChatChanges(
    listener: (snapshot: SideChatSnapshot | undefined) => void,
  ): () => void
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
  subscribeToSidebarChanges(
    listener: (notification: SidebarChangedNotification) => void,
  ): () => void
  subscribeToProjectChanges(
    listener: (notification: ProjectChangedNotification) => void,
  ): () => void
  // Server-broadcast MCP connection-state changes for a session; refetch
  // mcp/status to read the new state.
  subscribeToMcpStatusChanges(
    listener: (notification: McpStatusChangedNotification) => void,
  ): () => void
  // Server-broadcast session activity. `undefined` means the connection
  // re-initialized and the current active set is unknown: refetch lists.
  subscribeToSessionActivity(
    listener: (activeSessionIds: readonly string[] | undefined) => void,
  ): () => void
  subscribeToQueueChanges(listener: (sessionId: string) => void): () => void
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
// Local UI safety boundaries: a half-open WebSocket must not leave session
// hydration pending indefinitely. A 15s interval plus 10s reply window bounds
// detection to about 25s while allowing short local scheduling delays. The
// ping is local RPC work and must answer even while a model request is stuck.
const connectionTimeoutMs = 10_000
const heartbeatIntervalMs = 15_000
const heartbeatTimeoutMs = 10_000

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
  let initializedOnce = false
  let closed = false
  let connecting: Promise<void> | undefined
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined
  let nextId = 1
  const inflight = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >()
  const streams = new Map<string, StreamRecord>()
  // Answer channels for server→client permission requests, keyed by
  // permissionRequestId; ids are process-global on the server, so a responder
  // stays valid across reconnects until answered or pruned.
  const permissionResponders = new Map<string, { readonly id: RequestId }>()
  const sidebarChangeListeners = new Set<
    (notification: SidebarChangedNotification) => void
  >()
  const goalChangeListeners = new Set<
    (notification: GoalChangedNotification | undefined) => void
  >()
  const projectChangeListeners = new Set<
    (notification: ProjectChangedNotification) => void
  >()
  const mcpStatusChangedListeners = new Set<
    (notification: McpStatusChangedNotification) => void
  >()
  const providerChangeListeners = new Set<() => void>()
  const sessionActivityListeners = new Set<
    (activeSessionIds: readonly string[] | undefined) => void
  >()
  const queueChangeListeners = new Set<(sessionId: string) => void>()
  const engineSessionListeners = new Set<
    (sessionId: string | undefined) => void
  >()
  const sideChatListeners = new Set<
    (snapshot: SideChatSnapshot | undefined) => void
  >()
  const completionListeners = new Set<
    (notification: SessionCompletedNotification) => void
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
      const connectionDeadline = setTimeout(() => {
        fail(new ApiRequestError("The connection to the server timed out."))
        dropSocket(ws)
      }, connectionTimeoutMs)
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(connectionDeadline)
        connecting = undefined
        reject(
          error instanceof Error
            ? error
            : new ApiRequestError("Could not connect to the server."),
        )
      }
      ws.addEventListener("open", () => {
        if (socket !== ws) return
        // The handshake runs over the same correlation as every request.
        sendInitialize(
          ws,
          () => {
            settled = true
            clearTimeout(connectionDeadline)
            resolve()
          },
          fail,
          () => settled,
        )
      })
      ws.addEventListener("error", () => {
        fail(undefined)
        dropSocket(ws)
      })
      ws.addEventListener("close", () => {
        fail(undefined)
        onSocketClosed(ws)
      })
      ws.addEventListener("message", (event) => {
        if (socket !== ws) return
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
        resubscribeAll()
        if (initializedOnce) {
          for (const listener of providerChangeListeners) listener()
          for (const listener of goalChangeListeners) listener(undefined)
          for (const listener of sidebarChangeListeners) listener({})
          for (const listener of sessionActivityListeners) listener(undefined)
          for (const listener of sideChatListeners) listener(undefined)
          for (const listener of engineSessionListeners) listener(undefined)
        }
        initializedOnce = true
        scheduleHeartbeat(ws)
        resolve()
      },
      reject: (error) => {
        fail(error)
        dropSocket(ws)
      },
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
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer)
    if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline)
    heartbeatTimer = undefined
    heartbeatDeadline = undefined
    const lost = new ApiRequestError("The connection to the server was lost.")
    for (const [id, pending] of inflight) {
      inflight.delete(id)
      pending.reject(lost)
    }
    if (closed) return
    for (const record of streams.values()) {
      if (!record.closed) record.handlers.onDisconnected?.(lost)
    }
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

  function dropSocket(ws: WebSocket): void {
    if (socket !== ws) return
    onSocketClosed(ws)
    ws.close()
  }

  function scheduleHeartbeat(ws: WebSocket): void {
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined
      if (socket !== ws || !ready) return
      heartbeatDeadline = setTimeout(() => dropSocket(ws), heartbeatTimeoutMs)
      void request("server/ping", {}).then(
        () => {
          if (socket !== ws) return
          if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline)
          heartbeatDeadline = undefined
          scheduleHeartbeat(ws)
        },
        () => dropSocket(ws),
      )
    }, heartbeatIntervalMs)
  }

  function onMessage(text: string): void {
    let message: JsonRpcMessage
    try {
      message = parseJsonRpcMessage(text)
    } catch (error) {
      if (error instanceof JsonRpcParseError) return
      throw error
    }
    if ("method" in message && "id" in message) {
      onServerRequest(message)
      return
    }
    if ("method" in message) {
      onNotification(message)
      return
    }
    const id = message.id
    if (typeof id !== "number") return
    const pending = inflight.get(id)
    if (pending === undefined) return
    inflight.delete(id)
    if ("error" in message) {
      pending.reject(toApiRequestError(message.error))
      return
    }
    pending.resolve(message.result)
  }

  function onServerRequest(message: {
    id: RequestId
    method: string
    params?: unknown
  }): void {
    if (message.method !== sessionPermissionRequestMethod) {
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
    if (message.method === goalChangedMethod) {
      const params = message.params as GoalChangedNotification
      for (const listener of goalChangeListeners) listener(params)
      return
    }
    if (message.method === sessionCompletedMethod) {
      const params = message.params as SessionCompletedNotification
      for (const listener of completionListeners) listener(params)
      return
    }
    if (message.method === "engineSession/changed") {
      const params = message.params as { sessionId: string }
      for (const listener of engineSessionListeners) listener(params.sessionId)
      return
    }
    if (message.method === sideChatChangedMethod) {
      const params = message.params as { sideChat: SideChatSnapshot }
      for (const listener of sideChatListeners) listener(params.sideChat)
      return
    }
    if (message.method === sessionEventMethod) {
      const params = message.params as SessionEventNotification
      const record = streams.get(params.sessionId)
      if (record === undefined || record.closed) return
      record.lastSeq = Math.max(record.lastSeq, params.seq)
      record.handlers.onEvent(params.event)
      return
    }
    if (message.method === sessionTransientMethod) {
      dispatchTransient(message.params as LiveSessionEvent)
      return
    }
    if (message.method === sessionPermissionRequestedMethod) {
      // The replay form of a still-pending permission; the store consumes it
      // as the same permission.requested transient the SSE stream produced.
      const params = message.params as SessionPermissionRequestParams
      dispatchTransient({ type: "permission.requested", ...params })
      return
    }
    if (message.method === sessionReplayCompleteMethod) {
      const params = message.params as SessionReplayCompleteNotification
      const record = streams.get(params.sessionId)
      if (record === undefined || record.closed) return
      record.handlers.onReplayComplete()
      return
    }
    if (message.method === sessionSubscriptionErrorMethod) {
      const params = message.params as SessionSubscriptionErrorNotification
      const record = streams.get(params.sessionId)
      if (record === undefined || record.closed) return
      streams.delete(params.sessionId)
      record.closed = true
      record.handlers.onError?.(new ApiRequestError(params.message))
      return
    }
    if (message.method === sidebarChangedMethod) {
      const notification = (message.params ?? {}) as SidebarChangedNotification
      for (const listener of sidebarChangeListeners) listener(notification)
    }
    if (message.method === providerConfigurationChangedMethod) {
      for (const listener of providerChangeListeners) listener()
    }
    if (message.method === sessionsActivityMethod) {
      const params: unknown = message.params
      const ids =
        typeof params === "object" &&
        params !== null &&
        Array.isArray(
          (params as { activeSessionIds?: unknown }).activeSessionIds,
        )
          ? ((
              params as { activeSessionIds: unknown[] }
            ).activeSessionIds.filter(
              (id): id is string => typeof id === "string",
            ) as readonly string[])
          : []
      for (const listener of sessionActivityListeners) listener(ids)
    }
    if (message.method === sessionQueueChangedMethod) {
      const sessionId = (message.params as { sessionId?: unknown } | undefined)
        ?.sessionId
      if (typeof sessionId === "string")
        for (const listener of queueChangeListeners) listener(sessionId)
    }
    if (message.method === projectChangedMethod) {
      const params = message.params as ProjectChangedNotification
      for (const listener of projectChangeListeners) listener(params)
    }
    if (message.method === mcpStatusChangedMethod) {
      const params = message.params as McpStatusChangedNotification
      for (const listener of mcpStatusChangedListeners) listener(params)
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
    // The connection may close between the awaited handshake and this
    // continuation. Registering a request after that close would leave it
    // pending forever because the close sweep has already run.
    const ws = socket
    if (!ready || ws?.readyState !== WebSocket.OPEN) {
      throw new ApiRequestError("The connection to the server was lost.")
    }
    const id = nextId++
    return new Promise<RpcMethodResponses[M]>((resolve, reject) => {
      inflight.set(id, {
        resolve: (value) => resolve(value as RpcMethodResponses[M]),
        reject,
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        inflight.delete(id)
        reject(error)
        dropSocket(ws)
      }
    })
  }

  return {
    request,
    subscribeToGoalChanges(listener) {
      goalChangeListeners.add(listener)
      return () => {
        goalChangeListeners.delete(listener)
      }
    },
    subscribeToCompletions(listener) {
      completionListeners.add(listener)
      return () => {
        completionListeners.delete(listener)
      }
    },
    subscribeToSidebarChanges(listener) {
      sidebarChangeListeners.add(listener)
      return () => {
        sidebarChangeListeners.delete(listener)
      }
    },
    subscribeToProjectChanges(listener) {
      projectChangeListeners.add(listener)
      return () => {
        projectChangeListeners.delete(listener)
      }
    },
    subscribeToMcpStatusChanges(listener) {
      mcpStatusChangedListeners.add(listener)
      return () => {
        mcpStatusChangedListeners.delete(listener)
      }
    },
    subscribeToProviderChanges(listener) {
      providerChangeListeners.add(listener)
      return () => providerChangeListeners.delete(listener)
    },
    subscribeToSessionActivity(listener) {
      sessionActivityListeners.add(listener)
      return () => {
        sessionActivityListeners.delete(listener)
      }
    },
    subscribeToQueueChanges(listener) {
      queueChangeListeners.add(listener)
      return () => queueChangeListeners.delete(listener)
    },
    subscribeToEngineSessionChanges(listener) {
      engineSessionListeners.add(listener)
      return () => {
        engineSessionListeners.delete(listener)
      }
    },
    subscribeToSideChatChanges(listener) {
      sideChatListeners.add(listener)
      return () => {
        sideChatListeners.delete(listener)
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
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer)
      if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline)
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
