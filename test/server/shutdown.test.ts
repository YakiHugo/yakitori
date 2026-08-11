import { createServer, type Server } from "node:http"
import net from "node:net"
import { describe, expect, it } from "vitest"
import { shutdownHttpApplication } from "../../src/server/shutdown.ts"

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
