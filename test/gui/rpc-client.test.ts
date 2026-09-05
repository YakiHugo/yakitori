// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ApiRequestError,
  createAppRpcClient,
  type SessionStreamHandlers,
} from "../../src/gui/lib/rpc-client.ts"

type Listener = (event: { data?: string }) => void

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit("open")
  }

  emitMessage(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) })
  }

  emitClose(): void {
    this.readyState = 3
    this.emit("close")
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

// Drives the initialize handshake the client starts on socket open.
function completeHandshake(socket: FakeWebSocket | undefined): FakeWebSocket {
  if (socket === undefined) throw new Error("Expected a WebSocket instance.")
  socket.emitOpen()
  const initialize = socket.sentFrames()[0]
  expect(initialize).toMatchObject({
    id: 0,
    method: "initialize",
    params: {
      clientInfo: { name: "yakitori-gui" },
      capabilities: {},
    },
  })
  socket.emitMessage({
    id: 0,
    result: {
      userAgent: "yakitori/0.0.0",
      platformFamily: "unix",
      platformOs: "linux",
    },
  })
  return socket
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal("WebSocket", FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("app RPC client", () => {
  it("derives the WebSocket URL from the api base", async () => {
    const client = createAppRpcClient({ apiBase: "https://api.test:8443/base" })
    const pending = client.request("provider/list", {})
    const socket = FakeWebSocket.instances[0]
    expect(socket?.url).toBe("wss://api.test:8443/rpc")
    completeHandshake(socket)
    await flushMicrotasks()
    socket?.emitMessage({ id: 1, result: { providers: [] } })
    await expect(pending).resolves.toEqual({ providers: [] })
    client.close()
  })

  it("sends the initialized notification after the handshake", async () => {
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("provider/list", {})
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()

    const frames = socket?.sentFrames() ?? []
    expect(frames[1]).toEqual({ method: "initialized" })
    expect(frames[2]).toMatchObject({
      id: 1,
      method: "provider/list",
      params: {},
    })
    socket?.emitMessage({ id: 1, result: { providers: [] } })
    await pending
    client.close()
  })

  it("rejects requests with the server error and preserves data.code", async () => {
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("session/list", {})
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()
    socket?.emitMessage({
      id: 1,
      error: { code: -32603, message: "nope", data: { code: "conflict" } },
    })

    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiRequestError)
    expect((failure as ApiRequestError).message).toBe("nope")
    expect((failure as ApiRequestError).code).toBe("conflict")
    client.close()
  })

  it("rejects in-flight requests when the socket drops", async () => {
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("session/list", {})
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()

    socket?.emitClose()

    await expect(pending).rejects.toBeInstanceOf(ApiRequestError)
    client.close()
  })

  it("dispatches snapshot, events, transients, and replay-complete to the stream", async () => {
    const received: string[] = []
    const snapshot = {
      session: { id: "session_1", seq: 1 },
    }
    const handlers: SessionStreamHandlers = {
      onSnapshot: (response) =>
        received.push(`snapshot:${response.session.id}`),
      onEvent: (event) => received.push(`event:${event.seq}`),
      onTransient: (event) => received.push(`transient:${event.type}`),
      onReplayComplete: () => received.push("replayComplete"),
    }
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, handlers)
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()

    expect(
      socket
        ?.sentFrames()
        .find((frame) => frame.method === "session/subscribe"),
    ).toMatchObject({
      method: "session/subscribe",
      params: { sessionId: "session_1", after: 0 },
    })
    socket?.emitMessage({ id: 1, result: snapshot })
    await flushMicrotasks()
    socket?.emitMessage({
      method: "session/event",
      params: { sessionId: "session_1", seq: 2, event: { seq: 2 } },
    })
    socket?.emitMessage({
      method: "session/transient",
      params: { type: "assistant.delta", sessionId: "session_1" },
    })
    socket?.emitMessage({
      method: "session/permissionRequested",
      params: {
        sessionId: "session_1",
        permissionRequestId: "perm_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        action: "exec",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    })
    socket?.emitMessage({
      method: "session/replayComplete",
      params: { sessionId: "session_1", seq: 1 },
    })
    await flushMicrotasks()

    // The replayed pending permission surfaces as the same permission.requested
    // transient the live path delivers.
    expect(received).toEqual([
      "snapshot:session_1",
      "event:2",
      "transient:assistant.delta",
      "transient:permission.requested",
      "replayComplete",
    ])
    client.close()
  })

  it("answers a server permission request over the same channel", async () => {
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("provider/list", {})
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()
    socket?.emitMessage({ id: 1, result: { providers: [] } })
    await pending

    socket?.emitMessage({
      id: 77,
      method: "session/permission/request",
      params: {
        sessionId: "session_1",
        permissionRequestId: "perm_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        action: "exec",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    })
    client.answerPermission("perm_1", {
      behavior: "allow",
      reason: { kind: "user_allowed" },
    })

    expect(socket?.sentFrames().at(-1)).toEqual({
      id: 77,
      result: { behavior: "allow", reason: { kind: "user_allowed" } },
    })
    // The answer channel is single-use.
    expect(() =>
      client.answerPermission("perm_1", { behavior: "deny" }),
    ).toThrow(ApiRequestError)
    expect(() =>
      client.answerPermission("perm_unknown", { behavior: "deny" }),
    ).toThrow(ApiRequestError)
    client.close()
  })

  it("reconnects with bounded backoff and re-subscribes with the last cursor", async () => {
    vi.useFakeTimers()
    const snapshots: number[] = []
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot: () => snapshots.push(1),
      onEvent: () => {},
      onTransient: () => {},
      onReplayComplete: () => {},
    })
    const first = FakeWebSocket.instances[0]
    completeHandshake(first)
    await flushMicrotasks()
    first?.emitMessage({ id: 1, result: { session: { id: "session_1" } } })
    await flushMicrotasks()
    // The stream observes a durable event at seq 5.
    first?.emitMessage({
      method: "session/event",
      params: { sessionId: "session_1", seq: 5, event: { seq: 5 } },
    })
    expect(snapshots).toEqual([1])

    first?.emitClose()
    // No immediate reconnect; the first retry waits 250ms.
    await vi.advanceTimersByTimeAsync(249)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const second = FakeWebSocket.instances[1]
    completeHandshake(second)
    await flushMicrotasks()

    // Re-subscribe resumes from the last received durable seq, not from 0.
    const resubscribe = second
      ?.sentFrames()
      .find((frame) => frame.method === "session/subscribe")
    expect(resubscribe).toMatchObject({
      method: "session/subscribe",
      params: { sessionId: "session_1", after: 5 },
    })
    second?.emitMessage({
      id: resubscribe?.id,
      result: { session: { id: "session_1" } },
    })
    await flushMicrotasks()
    expect(snapshots).toEqual([1, 1])

    // The successful reconnect reset the backoff: the next retry waits 250ms
    // again. A socket that drops before its handshake completes grows the
    // delay (500ms) since no connection was ever established.
    second?.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    expect(FakeWebSocket.instances).toHaveLength(3)
    const third = FakeWebSocket.instances[2]
    third?.emitClose()
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(4)
    client.close()
  })

  it("reports a terminal subscribe failure through onError", async () => {
    const failures: unknown[] = []
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_gone", 0, {
      onSnapshot: () => {},
      onEvent: () => {},
      onTransient: () => {},
      onReplayComplete: () => {},
      onError: (error) => failures.push(error),
    })
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()
    socket?.emitMessage({
      id: 1,
      error: {
        code: -32603,
        message: "Session session_gone was not found.",
        data: { code: "not_found" },
      },
    })
    await flushMicrotasks()

    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(ApiRequestError)
    expect((failures[0] as ApiRequestError).code).toBe("not_found")
    client.close()
  })
})
