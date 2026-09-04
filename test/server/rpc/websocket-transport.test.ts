import { createServer, type Server } from "node:http"
import { createConnection, type AddressInfo, type Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createSessionEventHub } from "../../../src/server/event-hub.ts"
import { createYakitoriHttpServer } from "../../../src/server/http.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import { PARSE_ERROR } from "../../../src/server/rpc/messages.ts"
import {
  attachWebsocketRpcTransport,
  disconnectWebsocketRpcClients,
} from "../../../src/server/rpc/websocket-transport.ts"
import {
  beginHttpServerShutdown,
  shutdownHttpApplication,
} from "../../../src/server/shutdown.ts"
import {
  createFakeHandlers,
  deferred,
  makeSessionDetail,
  makeTurnStarted,
  okResult,
  waitForCondition,
} from "./testkit.ts"

type Frame = Readonly<Record<string, unknown>>

type RpcClient = Readonly<{
  ws: WebSocket
  frames: readonly Frame[]
  closed: Promise<Readonly<{ code: number; reason: string }>>
  request(method: string, params?: unknown): Promise<Frame>
  sendRaw(text: string): void
  waitFor(predicate: (frame: Frame) => boolean): Promise<Frame>
}>

describe("websocket RPC transport", () => {
  it("serves initialize and session/list over a real WebSocket alongside REST", async () => {
    const server = createYakitoriHttpServer({
      handlers: createFakeHandlers(),
      userAgent: "yakitori/1.2.3",
    })
    const port = await listen(server)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)

      const client = connect(port)
      await client.open
      try {
        const initialize = await client.request("initialize", {
          clientInfo: { name: "test-client", version: "0.0.0" },
        })
        expect(initialize).toMatchObject({
          result: { userAgent: "yakitori/1.2.3" },
        })
        const list = await client.request("session/list")
        expect(list).toMatchObject({ result: { sessions: [] } })
      } finally {
        client.ws.close()
        await client.closed
      }
    } finally {
      await closeServer(server)
    }
  })

  it("accepts loopback and missing Origins, rejecting a foreign Origin before upgrade", async () => {
    const server = createYakitoriHttpServer({ handlers: createFakeHandlers() })
    const port = await listen(server)
    try {
      const loopback = connect(port, "http://localhost:5173")
      await loopback.open
      loopback.ws.close()
      await loopback.closed

      const anonymous = connect(port)
      await anonymous.open
      anonymous.ws.close()
      await anonymous.closed

      const foreign = connect(port, "https://example.com")
      await expect(foreign.open).rejects.toThrow("403")
    } finally {
      await closeServer(server)
    }
  })

  it("answers a malformed frame with a parse error and keeps the connection open", async () => {
    const server = createYakitoriHttpServer({ handlers: createFakeHandlers() })
    const port = await listen(server)
    try {
      const client = connect(port)
      await client.open
      try {
        client.sendRaw("{ not json")
        const error = await client.waitFor(
          (frame) => frame.id === null && "error" in frame,
        )
        expect(error).toMatchObject({
          id: null,
          error: { code: PARSE_ERROR },
        })
        const initialize = await client.request("initialize", {
          clientInfo: { name: "test-client", version: "0.0.0" },
        })
        expect(initialize).toHaveProperty("result")
      } finally {
        client.ws.close()
        await client.closed
      }
    } finally {
      await closeServer(server)
    }
  })

  it("disconnects with 1008 when a stalled client fills the outbound queue", async () => {
    const eventHub = createSessionEventHub()
    const processor = new MessageProcessor({
      handlers: createFakeHandlers(),
      eventHub,
    })
    const server = createServer()
    attachWebsocketRpcTransport(server, {
      processor,
      maxOutboundQueueFrames: 8,
    })
    const port = await listen(server)
    try {
      const client = connect(port)
      await client.open
      await client.request("initialize", {
        clientInfo: { name: "test-client", version: "0.0.0" },
      })
      await client.request("session/subscribe", { sessionId: "session_1" })
      await client.waitFor((frame) => frame.method === "session/replayComplete")

      // Stall the peer at the TCP level so the server-side socket buffer
      // fills and notifications pile up in the outbound queue. The payload
      // padding pushes bufferedAmount past the high-water mark quickly.
      const socket = (client.ws as unknown as { _socket: Socket })._socket
      socket.pause()
      const padding = "x".repeat(256 * 1024)
      for (let index = 0; index < 64; index++) {
        eventHub.publishDurable([
          makeTurnStarted("session_1", index + 2, padding),
        ])
      }
      socket.resume()

      const close = await client.closed
      expect(close.code).toBe(1008)
    } finally {
      await closeServer(server)
    }
  })

  it("closes the processor connection and its subscriptions when the client disconnects", async () => {
    const eventHub = createSessionEventHub()
    const processor = new MessageProcessor({
      handlers: createFakeHandlers(),
      eventHub,
    })
    const closedConnections: number[] = []
    const closeConnection = processor.closeConnection.bind(processor)
    processor.closeConnection = (id) => {
      closedConnections.push(id)
      return closeConnection(id)
    }
    const server = createServer()
    const transport = attachWebsocketRpcTransport(server, { processor })
    const port = await listen(server)
    try {
      const first = connect(port)
      await first.open
      await first.request("initialize", {
        clientInfo: { name: "test-client", version: "0.0.0" },
      })
      await first.request("session/subscribe", { sessionId: "session_1" })
      await first.waitFor((frame) => frame.method === "session/replayComplete")

      const second = connect(port)
      await second.open
      await second.request("initialize", {
        clientInfo: { name: "test-client", version: "0.0.0" },
      })
      await second.request("session/subscribe", { sessionId: "session_1" })
      await second.waitFor((frame) => frame.method === "session/replayComplete")

      eventHub.publishDurable([makeTurnStarted("session_1", 2, "turn_2")])
      await first.waitFor((frame) => frame.method === "session/event")
      await second.waitFor((frame) => frame.method === "session/event")

      first.ws.close()
      await first.closed
      await waitForCondition(() => closedConnections.length === 1)
      await waitForCondition(() => transport.connectionCount === 1)

      // The closed connection's subscription is gone; the surviving
      // connection still receives new events for the session.
      eventHub.publishDurable([makeTurnStarted("session_1", 3, "turn_3")])
      await second.waitFor(
        (frame) =>
          frame.method === "session/event" &&
          (frame.params as Readonly<{ seq: number }>).seq === 3,
      )

      second.ws.close()
      await second.closed
      await waitForCondition(() => closedConnections.length === 2)
    } finally {
      await closeServer(server)
    }
  })

  it("destroys a socket with an unparseable request-target and keeps serving /rpc", async () => {
    const server = createServer()
    attachWebsocketRpcTransport(server, {
      processor: new MessageProcessor({ handlers: createFakeHandlers() }),
    })
    const port = await listen(server)
    try {
      // "GET // HTTP/1.1" makes new URL() throw inside the upgrade listener;
      // the socket must be destroyed without taking down the server.
      await new Promise<void>((resolve) => {
        const socket = createConnection(port, "127.0.0.1", () => {
          socket.write(
            "GET // HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Connection: Upgrade\r\n" +
              "Upgrade: websocket\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n\r\n",
          )
        })
        socket.on("error", () => {})
        socket.on("close", () => resolve())
      })

      const client = connect(port)
      await client.open
      const initialize = await client.request("initialize", {
        clientInfo: { name: "test-client", version: "0.0.0" },
      })
      expect(initialize).toHaveProperty("result")
      client.ws.close()
      await client.closed
    } finally {
      await closeServer(server)
    }
  })

  it("waits for an in-flight request handler before disconnectAll resolves", async () => {
    const release = deferred<void>()
    let handlerStarted = false
    let handlerFinished = false
    const processor = new MessageProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          handlerStarted = true
          await release.promise
          handlerFinished = true
          return okResult({ session: makeSessionDetail("session_1") })
        },
      }),
    })
    const server = createServer()
    const transport = attachWebsocketRpcTransport(server, { processor })
    const port = await listen(server)
    try {
      const client = connect(port)
      await client.open
      await client.request("initialize", {
        clientInfo: { name: "test-client", version: "0.0.0" },
      })
      const inFlight = client.request("session/read", {
        sessionId: "session_1",
      })
      // The response is emitted only after the socket is already closing, so
      // the client never receives it; the request waiter times out on its own.
      void inFlight.catch(() => {})
      await waitForCondition(() => handlerStarted)

      let disconnected = false
      const all = transport.disconnectAll().then(() => {
        disconnected = true
      })
      const close = await client.closed
      expect(close.code).toBe(1001)
      await new Promise((resolve) => setTimeout(resolve, 10))
      // The socket is gone but the admitted handler still runs: disconnectAll
      // waits for the processor-side drain.
      expect(disconnected).toBe(false)
      expect(handlerFinished).toBe(false)

      release.resolve()
      await all
      expect(disconnected).toBe(true)
      expect(handlerFinished).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it("closes a connection that upgrades while disconnectAll is running", async () => {
    const server = createServer()
    const transport = attachWebsocketRpcTransport(server, {
      processor: new MessageProcessor({ handlers: createFakeHandlers() }),
    })
    const port = await listen(server)
    try {
      const first = connect(port)
      await first.open

      const all = transport.disconnectAll()
      // This upgrade lands after disconnectAll took its snapshot; the
      // transport closes it on arrival instead of missing it.
      const late = connect(port)
      await late.open
      const lateClose = await late.closed
      expect(lateClose.code).toBe(1001)

      await all
      const firstClose = await first.closed
      expect(firstClose.code).toBe(1001)
    } finally {
      await closeServer(server)
    }
  })

  it("keeps live connections admitted during drain and disconnects them at teardown", async () => {
    const server = createYakitoriHttpServer({ handlers: createFakeHandlers() })
    const port = await listen(server)
    const client = connect(port)
    await client.open
    await client.request("initialize", {
      clientInfo: { name: "test-client", version: "0.0.0" },
    })

    // The production sequence: stop accepting, drain with WS still admitted,
    // then disconnect WS so the listener close can complete.
    const httpShutdown = beginHttpServerShutdown(server)
    const list = await client.request("session/list")
    expect(list).toMatchObject({ result: { sessions: [] } })

    const clean = await shutdownHttpApplication({
      server,
      httpShutdown,
      closeApplication: async () => {},
    })
    expect(clean).toBe(true)
    const close = await client.closed
    expect(close.code).toBe(1001)
  })
})

function connect(
  port: number,
  origin?: string,
): RpcClient & { open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    ...(origin === undefined ? {} : { headers: { origin } }),
  })
  const frames: Frame[] = []
  const waiters: {
    predicate: (frame: Frame) => boolean
    resolve: (frame: Frame) => void
  }[] = []
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Frame
    frames.push(frame)
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]
      if (waiter?.predicate(frame)) {
        waiters.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })
  const open = new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    ws.once("open", () => {
      ws.off("error", onError)
      resolve()
    })
    ws.once("error", onError)
  })
  const closed = new Promise<Readonly<{ code: number; reason: string }>>(
    (resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      )
    },
  )
  let nextId = 0
  const client: RpcClient & { open: Promise<void> } = {
    ws,
    frames,
    open,
    closed,
    request(method, params) {
      const id = ++nextId
      const response = client.waitFor(
        (frame) => frame.id === id && !("method" in frame),
      )
      ws.send(
        JSON.stringify(
          params === undefined ? { id, method } : { id, method, params },
        ),
      )
      return response
    },
    sendRaw(text) {
      ws.send(text)
    },
    waitFor(predicate) {
      const existing = frames.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for a frame.")),
          2000,
        )
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        })
      })
    },
  }
  return client
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve(address.port)
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  // Upgraded sockets keep server.close() from completing, so disconnect them
  // first.
  await disconnectWebsocketRpcClients(server)
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}
