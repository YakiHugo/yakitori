import { once } from "node:events"
import { createServer, type Server } from "node:http"
import net from "node:net"
import { describe, expect, it, vi } from "vitest"
import {
  createShutdownController,
  drainAdmittedRequestsAndTurns,
  ShutdownPhase,
  shutdownHttpApplication,
} from "../../src/server/shutdown.ts"
import { createRequestGate } from "../../src/server/request-gate.ts"

describe("createShutdownController", () => {
  it("waits for active Turns before closing admission and transports", async () => {
    let runningTurnCount = 1
    let onRunningTurnCount: ((count: number) => void) | undefined
    let beganShutdown = false
    let shutdownCalls = 0
    const shutdownFinished = deferred<boolean>()
    const controller = createShutdownController({
      runningTurnCount: () => runningTurnCount,
      subscribeRunningTurnCount(listener) {
        onRunningTurnCount = listener
        return () => {
          onRunningTurnCount = undefined
        }
      },
      beginShutdown: () => {
        beganShutdown = true
      },
      shutdown: () => {
        shutdownCalls += 1
        return shutdownFinished.promise
      },
      forceShutdown: () => {
        throw new Error("unreachable")
      },
      reportOperationalFailure: () => {},
    })

    controller.requestShutdown()

    expect(controller.phase).toBe(ShutdownPhase.Draining)
    expect(beganShutdown).toBe(false)
    expect(shutdownCalls).toBe(0)

    runningTurnCount = 0
    onRunningTurnCount?.(0)
    expect(controller.phase).toBe(ShutdownPhase.ShuttingDown)
    expect(beganShutdown).toBe(true)
    expect(shutdownCalls).toBe(1)

    shutdownFinished.resolve(true)
    await expect(controller.termination).resolves.toEqual({
      clean: true,
      forced: false,
    })
    expect(controller.phase).toBe(ShutdownPhase.Finished)
  })

  it("forces shutdown when requested a second time", async () => {
    let forced = false
    const controller = createShutdownController({
      runningTurnCount: () => 1,
      subscribeRunningTurnCount: () => () => {},
      beginShutdown: () => {},
      shutdown: () => Promise.resolve(true),
      forceShutdown: () => {
        forced = true
      },
      reportOperationalFailure: () => {},
    })

    controller.requestShutdown()
    controller.requestShutdown()

    expect(forced).toBe(true)
    await expect(controller.termination).resolves.toEqual({
      clean: false,
      forced: true,
    })
    expect(controller.phase).toBe(ShutdownPhase.Forced)
  })

  it("waits for a Turn started by a request admitted before shutdown", async () => {
    const gate = createRequestGate()
    const releaseRequest = deferred<void>()
    let runningTurnCount = 0
    let onRunningTurnCount: ((count: number) => void) | undefined
    const admitted = gate.run(async () => {
      await releaseRequest.promise
      runningTurnCount = 1
      onRunningTurnCount?.(1)
    })
    const controller = createShutdownController({
      runningTurnCount: () => runningTurnCount,
      subscribeRunningTurnCount(listener) {
        onRunningTurnCount = listener
        return () => {
          onRunningTurnCount = undefined
        }
      },
      beginShutdown: () => gate.close(),
      shutdown: () =>
        drainAdmittedRequestsAndTurns({
          drainRequests: gate.shutdown(),
          runningTurnCount: () => runningTurnCount,
          subscribeRunningTurnCount(listener) {
            onRunningTurnCount = listener
            return () => {
              onRunningTurnCount = undefined
            }
          },
        }),
      forceShutdown: () => {
        throw new Error("unreachable")
      },
      reportOperationalFailure: () => {},
    })

    controller.requestShutdown()
    expect(controller.phase).toBe(ShutdownPhase.ShuttingDown)
    await expect(gate.run(async () => {})).resolves.toEqual({
      accepted: false,
    })

    let terminated = false
    void controller.termination.then(() => {
      terminated = true
    })
    releaseRequest.resolve()
    await admitted
    await Promise.resolve()
    expect(runningTurnCount).toBe(1)
    expect(terminated).toBe(false)

    runningTurnCount = 0
    onRunningTurnCount?.(0)
    await expect(controller.termination).resolves.toEqual({
      clean: true,
      forced: false,
    })
  })
})

describe("shutdownHttpApplication", () => {
  it("force-closes an established hanging SSE connection", async () => {
    const server = createSseServer()
    let socket: net.Socket | undefined
    try {
      const port = await listen(server)
      socket = await openHangingRequest(port)
      socket.resume()
      const clientClosed = once(socket, "close")
      const serverClosed = once(server, "close")
      const timeouts: string[] = []
      expect(socket.destroyed).toBe(false)

      const clean = await shutdownHttpApplication({
        server,
        closeApplication: async () => {},
        timeoutMs: 1_000,
        onTimeout: (step) => timeouts.push(step),
      })

      expect(clean).toBe(true)
      expect(timeouts).toEqual([])
      await serverClosed
      expect(server.listening).toBe(false)
      expect(await clientClosed).toEqual([false])
      expect(socket.readableEnded).toBe(true)
      expect(socket.destroyed).toBe(true)
    } finally {
      socket?.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("times out a wedged application close instead of hanging forever", async () => {
    const server = createSseServer()
    const closeStarted = deferred<void>()
    const releaseClose = deferred<void>()
    const timeouts: string[] = []
    try {
      await listen(server)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let completed = false
      const closing = shutdownHttpApplication({
        server,
        closeApplication: () => {
          closeStarted.resolve()
          return releaseClose.promise
        },
        timeoutMs: 200,
        onTimeout: (step) => timeouts.push(step),
      }).then((clean) => {
        completed = true
        return clean
      })

      await closeStarted.promise
      expect(server.listening).toBe(false)
      await vi.advanceTimersByTimeAsync(199)
      expect(completed).toBe(false)
      expect(timeouts).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await expect(closing).resolves.toBe(false)
      expect(timeouts).toEqual(["application-close"])
    } finally {
      releaseClose.resolve()
      vi.useRealTimers()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// A server whose responses never end, like the session SSE stream.
function createSseServer(): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(": connected\n\n")
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address.")
      }
      resolve(address.port)
    })
  })
}

async function openHangingRequest(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1")
  try {
    await once(socket, "connect")
    socket.write(
      "GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
    )
    let received = ""
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      received += chunk.toString()
      if (received.includes(": connected\n\n")) return socket
    }
    throw new Error("SSE connection closed before its first frame.")
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}
