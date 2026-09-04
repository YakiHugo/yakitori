import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import { isAllowedCorsOrigin } from "../http.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "../operational-errors.ts"
import type { MessageProcessor } from "./message-processor.ts"

export const websocketRpcPath = "/rpc"

// Implementation safety boundaries, not product quotas. The queue cap is the
// disconnect trigger: like Codex's disconnectable transports, a client whose
// outbound queue fills is dropped rather than letting server memory grow
// without bound. The high-water mark only pauses dequeueing while the socket
// write buffer is full; sends resume from the send callbacks.
const defaultMaxOutboundQueueFrames = 1024
const outboundHighWaterMarkBytes = 4 * 1024 * 1024
// A stuck client may never answer the close handshake; destroy the socket
// after a short grace so teardown stays bounded.
const closeHandshakeGraceMs = 250

export type WebsocketRpcTransportOptions = Readonly<{
  processor: MessageProcessor
  reportOperationalFailure?: OperationalFailureReporter
  maxOutboundQueueFrames?: number
}>

export type WebsocketRpcTransport = Readonly<{
  readonly connectionCount: number
  disconnectAll(): Promise<void>
}>

// node:http keeps counting upgraded sockets as open connections for
// server.close() but closeAllConnections() skips them, so a plain close
// cannot complete while a WS client is connected and the forced path cannot
// reach them either. The shutdown flow finds the transport through this
// registry and disconnects WS clients after the request drain, before the
// listener close can complete (Codex's stop-accepting -> drain ->
// DisconnectAll order).
const transports = new WeakMap<Server, WebsocketRpcTransport>()

export function disconnectWebsocketRpcClients(server: Server): Promise<void> {
  return transports.get(server)?.disconnectAll() ?? Promise.resolve()
}

// Bridges node:http upgrade events on /rpc to the C8-D1 message processor.
// One WS text frame carries one JSON-RPC message; parsing lives at the
// processor boundary while this module moves text and owns socket lifecycle,
// Origin policy, and outbound backpressure.
export function attachWebsocketRpcTransport(
  server: Server,
  options: WebsocketRpcTransportOptions,
): WebsocketRpcTransport {
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const maxOutboundQueueFrames =
    options.maxOutboundQueueFrames ?? defaultMaxOutboundQueueFrames
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<WebSocket>()
  // Processor-side teardown of closed connections, so disconnectAll waits for
  // in-flight handlers instead of tearing them down mid-write.
  const teardowns = new Set<Promise<void>>()
  // Set by disconnectAll: connections registered afterwards are closed on
  // arrival because the disconnect snapshot is already taken.
  let disconnecting = false

  wss.on("wsClientError", (error, socket: Duplex) => {
    reportOperationalFailure(reporter, {
      component: "websocket-transport",
      operation: "upgrade",
      cause: error,
    })
    socket.destroy()
  })

  server.on("upgrade", (request, socket, head) => {
    // Registering an upgrade listener disables node:http's default socket
    // cleanup, so paths this transport does not own are closed explicitly. An
    // unparseable request-target (e.g. "GET // HTTP/1.1") must not throw out
    // of the listener and kill the process; it gets the same treatment.
    let path: string
    try {
      path = upgradePath(request)
    } catch {
      socket.destroy()
      return
    }
    if (path !== websocketRpcPath) {
      socket.destroy()
      return
    }
    // Codex rejects any Origin header because its clients are never browsers.
    // Yakitori's primary client IS the browser GUI, so a browser upgrade is
    // held to the same loopback Origin rule as the HTTP layer; non-browser
    // clients send no Origin and pass.
    const origin = request.headers.origin
    if (origin !== undefined && !isAllowedCorsOrigin(origin)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      )
      return
    }
    wss.handleUpgrade(request, socket, head, trackConnection)
  })

  function trackConnection(ws: WebSocket): void {
    if (disconnecting) {
      // Registered after disconnectAll began: close immediately. No processor
      // connection is opened, so there is nothing further to await.
      closeSocket(ws, 1001, "Server is shutting down.")
      return
    }
    sockets.add(ws)
    const handle = options.processor.openConnection()
    const outbound: string[] = []
    // closing stops enqueue/flush as soon as teardown starts; cleanedUp gates
    // the one-time close handling.
    let closing = false
    let cleanedUp = false

    const flush = (): void => {
      while (
        !closing &&
        outbound.length > 0 &&
        ws.readyState === WebSocket.OPEN &&
        ws.bufferedAmount <= outboundHighWaterMarkBytes
      ) {
        const text = outbound.shift()
        if (text === undefined) return
        // A failed send means the socket is dying; the connection's
        // error/close handlers own reporting and cleanup, so here the flush
        // just stops and waits for the close path.
        ws.send(text, (error) => {
          if (error !== undefined) return
          flush()
        })
      }
    }

    handle.onMessage((text) => {
      if (closing) return
      outbound.push(text)
      if (outbound.length > maxOutboundQueueFrames) {
        closing = true
        closeSocket(ws, 1008, "Outbound queue full.")
        return
      }
      flush()
    })

    ws.on("message", (data) => {
      handle.send(typeof data === "string" ? data : data.toString("utf8"))
    })
    ws.on("error", (error) => {
      // A 'close' event always follows; the close path owns cleanup.
      reportOperationalFailure(reporter, {
        component: "websocket-transport",
        operation: "socket",
        cause: error,
      })
    })
    ws.once("close", () => {
      if (cleanedUp) return
      cleanedUp = true
      closing = true
      sockets.delete(ws)
      const teardown: Promise<void> = options.processor
        .closeConnection(handle.id)
        .then(
          () => undefined,
          (error: unknown) => {
            reportOperationalFailure(reporter, {
              component: "websocket-transport",
              operation: "close-connection",
              cause: error,
            })
          },
        )
      teardowns.add(teardown)
      void teardown.finally(() => teardowns.delete(teardown))
    })
  }

  function closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.terminate()
      return
    }
    ws.close(code, reason)
    const timer = setTimeout(() => ws.terminate(), closeHandshakeGraceMs)
    timer.unref()
    ws.once("close", () => clearTimeout(timer))
  }

  async function disconnectAll(): Promise<void> {
    disconnecting = true
    await Promise.all(
      [...sockets].map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve()
              return
            }
            ws.once("close", () => resolve())
            closeSocket(ws, 1001, "Server is shutting down.")
          }),
      ),
    )
    // Socket close only starts the processor-side drain; await it so admitted
    // handlers finish before shutdown tears down their dependencies. A late
    // socket close can add a teardown while we wait, so drain to empty.
    while (teardowns.size > 0) {
      await Promise.all([...teardowns])
    }
  }

  const transport: WebsocketRpcTransport = {
    get connectionCount() {
      return sockets.size
    },
    disconnectAll,
  }
  transports.set(server, transport)
  return transport
}

function upgradePath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname
}
