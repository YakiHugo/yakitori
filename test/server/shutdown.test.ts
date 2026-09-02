import { createServer, type Server } from "node:http"
import net from "node:net"
import { describe, expect, it } from "vitest"
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
  it("force-closes hanging SSE-style connections and completes promptly", async () => {
    const server = createSseServer()
    const port = await listen(server)
    const socket = await openHangingRequest(port)

    const started = Date.now()
    const clean = await shutdownHttpApplication({
      server,
      closeApplication: async () => {},
      timeoutMs: 1_000,
    })
    const elapsed = Date.now() - started

    expect(clean).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
    socket.destroy()
  })

  it("times out a wedged application close instead of hanging forever", async () => {
    const server = createSseServer()
    await listen(server)
    const timeouts: string[] = []

    const started = Date.now()
    const clean = await shutdownHttpApplication({
      server,
      closeApplication: () => new Promise<void>(() => {}),
      timeoutMs: 200,
      onTimeout: (step) => timeouts.push(step),
    })
    const elapsed = Date.now() - started

    expect(clean).toBe(false)
    expect(timeouts).toEqual(["application-close"])
    expect(elapsed).toBeLessThan(1_000)
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
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  socket.write(
    "GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
  )
  // Give the server a tick to accept and hold the connection.
  await new Promise((resolve) => setTimeout(resolve, 100))
  return socket
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
