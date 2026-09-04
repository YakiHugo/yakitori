import { createSessionEventHub, type SessionEventHub } from "../event-hub.ts"
import type { ServerHandlers } from "../handlers.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "../operational-errors.ts"
import type { ProjectRegistry } from "../project-registry.ts"
import { ApiErrorCode, type ApiListProvidersResponse } from "../protocol.ts"
import type { UserConfigStore } from "../user-config.ts"
import { ConnectionRpcGate } from "./connection-gate.ts"
import { RpcConnectionState } from "./connection.ts"
import {
  errorResponse,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  JsonRpcParseError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  parseJsonRpcMessage,
  type RequestId,
  resultResponse,
  SERVER_OVERLOADED,
  serializeJsonRpcMessage,
} from "./messages.ts"
import {
  type InitializeParams,
  type InitializeResponse,
  parseInitializeParams,
  RpcMethodError,
  type RpcMethodContext,
  type RpcMethodDefinition,
  type RpcMethodOutcome,
  rpcMethods,
} from "./methods.ts"
import { PendingServerRequests } from "./pending-requests.ts"
import { RequestSerializationQueues } from "./serialization.ts"
import {
  createSessionSubscriptions,
  type SessionSubscriptions,
} from "./subscriptions.ts"

// Injection mirrors createYakitoriHttpServer so the production wiring stage
// stays mechanical.
export type MessageProcessorOptions = Readonly<{
  handlers: ServerHandlers
  eventHub?: SessionEventHub
  projectRegistry?: ProjectRegistry
  providers?: () => Promise<ApiListProvidersResponse>
  userConfig?: UserConfigStore
  availableProviders?: readonly string[]
  reportOperationalFailure?: OperationalFailureReporter
  userAgent?: string
  drainTimeoutMs?: number
}>

export type ConnectionHandle = Readonly<{
  id: number
  send(text: string): void
  onMessage(listener: (text: string) => void): void
}>

type ConnectionRecord = {
  readonly state: RpcConnectionState
  readonly gate: ConnectionRpcGate
  readonly listeners: Set<(text: string) => void>
}

const defaultDrainTimeoutMs = 30_000

// Implementation safety boundary, not a product quota: at most this many
// client requests may be admitted-or-queued process-wide before new requests
// are rejected with SERVER_OVERLOADED (mirrors Codex's CHANNEL_CAPACITY = 128
// at transport/mod.rs). Responses and notifications are never rejected.
const maxInflightClientRequests = 128

// In-process C8-D1 message processor: one process-wide pending-request
// registry and one serialization-queues instance, with per-connection
// handshake state and gates. The WebSocket stage wraps ConnectionHandle.
export class MessageProcessor {
  readonly pendingServerRequests = new PendingServerRequests()

  private readonly handlers: ServerHandlers
  private readonly projectRegistry: ProjectRegistry | undefined
  private readonly providers:
    | (() => Promise<ApiListProvidersResponse>)
    | undefined
  private readonly userConfig: UserConfigStore | undefined
  private readonly availableProviders: readonly string[] | undefined
  private readonly reporter: OperationalFailureReporter
  private readonly userAgent: string
  private readonly drainTimeoutMs: number
  private readonly serializationQueues = new RequestSerializationQueues()
  private readonly subscriptions: SessionSubscriptions
  private readonly methods: ReadonlyMap<string, RpcMethodDefinition>
  private readonly connections = new Map<number, ConnectionRecord>()
  private nextConnectionId = 1
  private inflightClientRequests = 0

  constructor(options: MessageProcessorOptions) {
    this.handlers = options.handlers
    this.projectRegistry = options.projectRegistry
    this.providers = options.providers
    this.userConfig = options.userConfig
    this.availableProviders = options.availableProviders
    this.reporter =
      options.reportOperationalFailure ?? consoleOperationalFailureReporter
    this.userAgent = options.userAgent ?? "yakitori"
    this.drainTimeoutMs = options.drainTimeoutMs ?? defaultDrainTimeoutMs
    const eventHub =
      options.eventHub ??
      createSessionEventHub({ reportOperationalFailure: this.reporter })
    this.subscriptions = createSessionSubscriptions({
      handlers: options.handlers,
      eventHub,
      notify: (connectionId, method, params) =>
        this.notify(connectionId, method, params),
      reportOperationalFailure: this.reporter,
    })
    this.methods = new Map(rpcMethods.map((entry) => [entry.method, entry]))
  }

  openConnection(): ConnectionHandle {
    const id = this.nextConnectionId++
    const record: ConnectionRecord = {
      state: new RpcConnectionState(),
      gate: new ConnectionRpcGate(),
      listeners: new Set(),
    }
    this.connections.set(id, record)
    return {
      id,
      send: (text) => this.receive(id, text),
      onMessage: (listener) => {
        record.listeners.add(listener)
      },
    }
  }

  // Closes the gate (new work is dropped, never polled once queued), removes
  // the connection's subscriptions, then drains admitted requests. The
  // subscription sweep runs again after the drain: a subscribe admitted just
  // before the gate closed can register its hub subscriber during the drain,
  // after the first sweep, and would otherwise leak (the removal is
  // idempotent).
  async closeConnection(id: number): Promise<"drained" | "timedOut"> {
    const connection = this.connections.get(id)
    if (connection === undefined) return "drained"
    this.subscriptions.removeConnection(id)
    const result = await connection.gate.shutdown(this.drainTimeoutMs)
    this.subscriptions.removeConnection(id)
    this.connections.delete(id)
    return result
  }

  private receive(connectionId: number, text: string): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    let message: JsonRpcMessage
    try {
      message = parseJsonRpcMessage(text)
    } catch (error) {
      if (error instanceof JsonRpcParseError) {
        // The id is unknowable on malformed input; JSON-RPC reports it as null.
        this.emit(
          connection,
          JSON.stringify({
            id: null,
            error: { code: error.code, message: error.message },
          }),
        )
        return
      }
      throw error
    }
    if ("method" in message) {
      if ("id" in message) {
        this.dispatchRequest(connectionId, connection, message)
        return
      }
      // Client notifications need no answer: "initialized" acknowledges the
      // handshake and unknown notifications are ignored by design.
      return
    }
    // Responses resolve process-wide pending server→client requests; any
    // connection may answer.
    if ("error" in message) {
      this.pendingServerRequests.reject(message.id, message.error)
      return
    }
    this.pendingServerRequests.resolve(message.id, message.result)
  }

  private dispatchRequest(
    connectionId: number,
    connection: ConnectionRecord,
    request: JsonRpcRequest,
  ): void {
    // A request counts from dispatch until its handler settles; past the
    // bound, new requests are rejected immediately so a flood cannot queue
    // without limit.
    if (this.inflightClientRequests >= maxInflightClientRequests) {
      this.emitMessage(
        connection,
        errorResponse(
          request.id,
          SERVER_OVERLOADED,
          "Server overloaded; retry later.",
        ),
      )
      return
    }
    this.inflightClientRequests += 1
    const settle = (): void => {
      this.inflightClientRequests -= 1
    }
    if (request.method === "initialize") {
      this.handleInitialize(connection, request)
      settle()
      return
    }
    if (!connection.state.initialized) {
      this.emitMessage(
        connection,
        errorResponse(request.id, INVALID_REQUEST, "Not initialized"),
      )
      settle()
      return
    }
    const entry = this.methods.get(request.method)
    if (entry === undefined) {
      this.emitMessage(
        connection,
        errorResponse(
          request.id,
          METHOD_NOT_FOUND,
          `Unknown method: ${request.method}`,
        ),
      )
      settle()
      return
    }
    if (
      entry.experimental === true &&
      connection.state.capabilities?.experimentalApi !== true
    ) {
      this.emitMessage(
        connection,
        errorResponse(
          request.id,
          INVALID_REQUEST,
          `${request.method} requires the experimental API capability.`,
        ),
      )
      settle()
      return
    }
    const context: RpcMethodContext = {
      connectionId,
      handlers: this.handlers,
      subscriptions: this.subscriptions,
      projectRegistry: this.projectRegistry,
      providers: this.providers,
      userConfig: this.userConfig,
      availableProviders: this.availableProviders,
    }
    const runUnderGate = async (): Promise<void> => {
      try {
        await this.invoke(entry, request, context, connection)
      } finally {
        settle()
      }
    }
    const scope = entry.scope(request.params)
    if (scope === undefined) {
      // Unserialized methods spawn directly under the connection gate
      // (Codex's message_processor: no scope, no queue).
      if (!connection.gate.submit(runUnderGate)) settle()
      return
    }
    // The gate admits the request when the serialization queue polls it:
    // queued work of a closed connection is skipped, while admitted work runs
    // to completion so closeConnection drains it.
    this.serializationQueues.enqueue(
      scope,
      () =>
        new Promise<void>((resolve) => {
          const admitted = connection.gate.submit(async () => {
            try {
              await runUnderGate()
            } finally {
              resolve()
            }
          })
          if (!admitted) {
            settle()
            resolve()
          }
        }),
      connection.gate,
    )
  }

  private async invoke(
    entry: RpcMethodDefinition,
    request: JsonRpcRequest,
    context: RpcMethodContext,
    connection: ConnectionRecord,
  ): Promise<void> {
    let outcome: RpcMethodOutcome
    try {
      outcome = await entry.invoke(request.params, context)
    } catch (error) {
      this.emitMessage(
        connection,
        this.errorMessageFor(request.id, request.method, error),
      )
      return
    }
    this.emitMessage(connection, resultResponse(request.id, outcome.result))
    if (outcome.afterResponse === undefined) return
    // The replay chain runs detached from the gate and the serialization
    // queue: a multi-page replay must not block same-session methods behind
    // the subscribe, and keeping it outside the gate keeps closeConnection
    // bounded. The response precedes replay notifications because the emit
    // above is synchronous; the subscription's closed flag (set by
    // closeConnection's subscription sweep) stops a replay whose connection
    // went away.
    void outcome.afterResponse().then(undefined, (error: unknown) => {
      reportOperationalFailure(this.reporter, {
        component: "message-processor",
        operation: `${request.method}:after-response`,
        cause: error,
      })
    })
  }

  private handleInitialize(
    connection: ConnectionRecord,
    request: JsonRpcRequest,
  ): void {
    if (connection.state.initialized) {
      this.emitMessage(
        connection,
        errorResponse(request.id, INVALID_REQUEST, "Already initialized"),
      )
      return
    }
    let params: InitializeParams
    try {
      params = parseInitializeParams(request.params)
    } catch (error) {
      if (error instanceof RpcMethodError) {
        this.emitMessage(
          connection,
          errorResponse(request.id, error.rpcCode, error.message, error.data),
        )
        return
      }
      throw error
    }
    connection.state.markInitialized({
      experimentalApi: params.capabilities?.experimentalApi ?? false,
      optOutNotificationMethods: new Set(
        params.capabilities?.optOutNotificationMethods ?? [],
      ),
    })
    this.emitMessage(
      connection,
      resultResponse(request.id, {
        userAgent: this.userAgent,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
      } satisfies InitializeResponse),
    )
  }

  private errorMessageFor(
    id: RequestId,
    method: string,
    error: unknown,
  ): ReturnType<typeof errorResponse> {
    if (error instanceof RpcMethodError) {
      return errorResponse(id, error.rpcCode, error.message, error.data)
    }
    reportOperationalFailure(this.reporter, {
      component: "message-processor",
      operation: method,
      cause: error,
    })
    return errorResponse(id, INTERNAL_ERROR, "Unexpected server error.", {
      code: ApiErrorCode.InternalError,
    })
  }

  private notify(connectionId: number, method: string, params: unknown): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    if (connection.state.capabilities?.optOutNotificationMethods.has(method)) {
      return
    }
    this.emitMessage(connection, { method, params })
  }

  private emitMessage(
    connection: ConnectionRecord,
    message: JsonRpcMessage,
  ): void {
    this.emit(connection, serializeJsonRpcMessage(message))
  }

  private emit(connection: ConnectionRecord, text: string): void {
    for (const listener of connection.listeners) listener(text)
  }
}
