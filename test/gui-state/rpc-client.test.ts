import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createExecutionViewState,
  projectExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  ApiRequestError,
  createAppRpcClient,
  type SessionStreamHandlers,
} from "../../src/gui/lib/rpc-client.ts"
import { sessionDisplayEvents } from "../../src/gui/lib/session-turn-history.ts"

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
async function replyLiveView(socket: FakeWebSocket, id: unknown, seq: number) {
  const rolloutId = "rollout_1"
  socket.emitMessage({
    id,
    result: {
      session: { id: "session_1", rolloutId, seq },
      watermarkSeq: seq,
      history: { view: "summary", rolloutId, seq, turns: [] },
    },
  })
  await flushMicrotasks()
}

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
  it("invalidates model sources on external changes and after reconnect", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const changed = vi.fn()
    const unsubscribe = client.subscribeToProviderChanges(changed)
    const pending = client.request("provider/configuration/read", {})
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({
      id: 1,
      result: { providers: [], presets: [], subscriptions: [] },
    })
    await pending
    expect(changed).not.toHaveBeenCalled()
    socket.emitMessage({ method: "provider/configuration/changed", params: {} })
    expect(changed).toHaveBeenCalledOnce()
    socket.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    const reconnected = completeHandshake(FakeWebSocket.instances[1])
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    reconnected.emitMessage({
      method: "provider/configuration/changed",
      params: {},
    })
    expect(changed).toHaveBeenCalledTimes(2)
    client.close()
  })

  it("delivers goal changes and invalidates them after reconnect", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const changed = vi.fn()
    const unsubscribe = client.subscribeToGoalChanges(changed)
    const pending = client.request("goal/read", { sessionId: "session_1" })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({ id: 1, result: { goal: null } })
    await expect(pending).resolves.toEqual({ goal: null })
    const notification = { sessionId: "session_1", goal: null }
    socket.emitMessage({ method: "goal/changed", params: notification })
    expect(changed).toHaveBeenCalledExactlyOnceWith(notification)
    socket.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    const reconnected = completeHandshake(FakeWebSocket.instances[1])
    expect(changed).toHaveBeenLastCalledWith(undefined)
    unsubscribe()
    changed.mockClear()
    reconnected.emitMessage({ method: "goal/changed", params: notification })
    expect(changed).not.toHaveBeenCalled()
    client.close()
  })

  it("delivers live completions without a session stream and does not replay them on reconnect", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const completed = vi.fn()
    const unsubscribe = client.subscribeToCompletions(completed)
    const pending = client.request("provider/list", {})
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({ id: 1, result: { providers: [] } })
    await pending
    const completion = {
      sessionId: "background",
      turnId: "turn_1",
      title: "Task",
    }
    socket.emitMessage({ method: "session/completed", params: completion })
    expect(completed).toHaveBeenCalledExactlyOnceWith(completion)

    socket.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    const reconnected = completeHandshake(FakeWebSocket.instances[1])
    reconnected.emitMessage({
      method: "session/event",
      params: {
        sessionId: "background",
        seq: 5,
        event: { type: "turn.completed", data: { turnId: "turn_1" } },
      },
    })
    reconnected.emitMessage({
      method: "session/liveReady",
      params: { sessionId: "background", seq: 5 },
    })
    expect(completed).toHaveBeenCalledOnce()
    reconnected.emitMessage({
      method: "session/completed",
      params: { ...completion, turnId: "turn_2" },
    })
    expect(completed).toHaveBeenCalledTimes(2)
    unsubscribe()
    reconnected.emitMessage({
      method: "session/completed",
      params: { ...completion, turnId: "turn_3" },
    })
    expect(completed).toHaveBeenCalledTimes(2)
    client.close()
  })

  it("delivers side-chat snapshots and requests a refetch after reconnection", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const changes = vi.fn()
    const unsubscribe = client.subscribeToSideChatChanges(changes)
    const pending = client.request("sideChat/create", {})
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    const sideChat = {
      id: "side",
      revision: 0,
      cwd: "/workspace",
      modelSelection: { provider: "faux", model: "scripted" },
      expiresAt: "2099-01-01T00:00:00Z",
      execution: projectExecutionView(createExecutionViewState()),
    }
    socket.emitMessage({ id: 1, result: sideChat })
    await pending
    socket.emitMessage({
      method: "sideChat/changed",
      params: { sideChat: { ...sideChat, revision: 1 } },
    })
    expect(changes).toHaveBeenCalledWith({ ...sideChat, revision: 1 })
    socket.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    completeHandshake(FakeWebSocket.instances[1])
    expect(changes).toHaveBeenLastCalledWith(undefined)
    unsubscribe()
    changes.mockClear()
    FakeWebSocket.instances[1]?.emitMessage({
      method: "sideChat/changed",
      params: { sideChat },
    })
    expect(changes).not.toHaveBeenCalled()
    client.close()
  })

  it("invalidates external engine history after changes and reconnection", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const changes = vi.fn()
    const unsubscribe = client.subscribeToEngineSessionChanges(changes)
    const pending = client.request("engine/list", {})
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({ id: 1, result: { engines: [] } })
    await pending
    socket.emitMessage({
      method: "engineSession/changed",
      params: { sessionId: "external" },
    })
    expect(changes).toHaveBeenLastCalledWith("external")
    socket.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    const restored = completeHandshake(FakeWebSocket.instances[1])
    expect(changes).toHaveBeenLastCalledWith(undefined)
    unsubscribe()
    changes.mockClear()
    restored.emitMessage({
      method: "engineSession/changed",
      params: { sessionId: "external" },
    })
    expect(changes).not.toHaveBeenCalled()
    client.close()
  })

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

  it("opens with one RPC and delivers buffered live traffic after the snapshot", async () => {
    const received: string[] = []
    const handlers: SessionStreamHandlers = {
      onSnapshot: (response) =>
        received.push(
          `snapshot:${[...sessionDisplayEvents(response)].map((event) => event.seq).join(",")}`,
        ),
      onEvent: (event) => received.push(`event:${event.seq}`),
      onTransient: (event) => received.push(`transient:${event.type}`),
      onReady: () => received.push("ready"),
    }
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, handlers)
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()

    expect(
      socket?.sentFrames().find((frame) => frame.method === "session/open"),
    ).toMatchObject({
      method: "session/open",
      params: { sessionId: "session_1" },
    })
    socket.emitMessage({
      id: 1,
      result: {
        session: { id: "session_1", rolloutId: "rollout_1", seq: 7 },
        watermarkSeq: 7,
        activeTurn: { turnId: "active", events: [{ seq: 7 }] },
        history: {
          rolloutId: "rollout_1",
          seq: 7,
          view: "summary",
          turns: [
            { turnId: "complete", events: [{ seq: 4 }], activityCount: 0 },
          ],
        },
      },
    })
    socket?.emitMessage({
      method: "session/event",
      params: { sessionId: "session_1", seq: 8, event: { seq: 8 } },
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
    expect(received).toEqual([])
    await flushMicrotasks()

    // The replayed pending permission surfaces as the same permission.requested
    // transient the live path delivers.
    expect(received).toEqual([
      "snapshot:4,7",
      "event:8",
      "transient:assistant.delta",
      "transient:permission.requested",
      "ready",
    ])
    expect(socket.sentFrames().map(({ method }) => method)).toEqual([
      "initialize",
      "session/open",
    ])
    client.close()
  })

  it.each([
    77,
    "permission-77",
  ])("answers permission request %s over the same channel", async (requestId) => {
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("provider/list", {})
    const socket = FakeWebSocket.instances[0]
    completeHandshake(socket)
    await flushMicrotasks()
    socket?.emitMessage({ id: 1, result: { providers: [] } })
    await pending

    socket?.emitMessage({
      id: requestId,
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
      id: requestId,
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

  it("reconnects with bounded backoff and reads the new live watermark", async () => {
    vi.useFakeTimers()
    const snapshots: number[] = []
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot: () => snapshots.push(1),
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
    })
    const first = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    await replyLiveView(first, 1, 1)
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

    const second = completeHandshake(FakeWebSocket.instances[1])
    await flushMicrotasks()

    // A reset could have happened while offline, even beyond the old cursor.
    const resubscribe = second
      ?.sentFrames()
      .find((frame) => frame.method === "session/open")
    expect(resubscribe).toMatchObject({
      method: "session/open",
      params: {
        sessionId: "session_1",
      },
    })
    await replyLiveView(second, resubscribe?.id, 6)
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

  it("resets a private stream and subscribes from zero on historyReset", async () => {
    const received: string[] = []
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 5, {
      onSnapshot: () => received.push("snapshot"),
      onEvent: () => received.push("event"),
      onTransient: () => received.push("transient"),
      onReady: () => received.push("ready"),
      onHistoryReset: () => received.push("reset"),
    })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    await replyLiveView(socket, 1, 5)
    socket.emitMessage({
      method: "session/historyReset",
      params: { sessionId: "session_1" },
    })
    expect(received).toEqual(["snapshot", "ready", "reset"])
    await flushMicrotasks()
    const subscriptions = socket
      .sentFrames()
      .filter((frame) => frame.method === "session/open")
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]).toMatchObject({
      params: { sessionId: "session_1" },
    })
    await replyLiveView(socket, subscriptions[1]?.id, 2)
    expect(received).toEqual([
      "snapshot",
      "ready",
      "reset",
      "snapshot",
      "ready",
    ])
    client.close()
  })

  it("does not subscribe twice when a global history listener replaces the stream", async () => {
    const oldReset = vi.fn()
    const newSnapshot = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const handlers: SessionStreamHandlers = {
      onSnapshot: newSnapshot,
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
    }
    client.openSessionStream("session_1", 5, {
      ...handlers,
      onHistoryReset: oldReset,
    })
    client.subscribeToSessionHistoryChanges((sessionId) => {
      if (sessionId) client.openSessionStream(sessionId, 0, handlers)
    })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({
      method: "session/historyReset",
      params: { sessionId: "session_1" },
    })
    await flushMicrotasks()
    const subscriptions = socket
      .sentFrames()
      .filter((frame) => frame.method === "session/open")
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]).toMatchObject({
      params: { sessionId: "session_1" },
    })
    expect(oldReset).not.toHaveBeenCalled()
    await replyLiveView(socket, subscriptions[1]?.id, 2)
    expect(newSnapshot).toHaveBeenCalledOnce()
    client.close()
  })

  it.each([
    "snapshot",
    "error",
  ] as const)("ignores an old subscribe %s and replay notifications while replacement history is pending", async (oldResponse) => {
    const onSnapshot = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 5, {
      onSnapshot,
      onEvent: () => {},
      onTransient: () => {},
      onReady,
      onError,
    })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({
      method: "session/historyReset",
      params: { sessionId: "session_1" },
    })
    await flushMicrotasks()
    socket.emitMessage(
      oldResponse === "snapshot"
        ? { id: 1, result: { session: { id: "session_1", seq: 5 } } }
        : { id: 1, error: { code: -32603, message: "Old replay failed" } },
    )
    await flushMicrotasks()
    socket.emitMessage({
      method: "session/liveReady",
      params: { sessionId: "session_1", seq: 5 },
    })
    socket.emitMessage({
      method: "session/subscriptionError",
      params: { sessionId: "session_1", message: "Old replay failed" },
    })
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    const subscription = socket
      .sentFrames()
      .filter((frame) => frame.method === "session/open")
      .at(-1)
    await replyLiveView(socket, subscription?.id, 2)
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        session: { id: "session_1", rolloutId: "rollout_1", seq: 2 },
        completedTurns: [],
      }),
    )
    expect(onReady).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    client.close()
  })

  it("drops a pending open and buffered events when history is replaced", async () => {
    const snapshots: number[] = []
    const onEvent = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot: ({ session }) => snapshots.push(session.seq),
      onEvent,
      onTransient: () => {},
      onReady: () => {},
    })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    const oldPage = socket.sentFrames().at(-1)
    expect(oldPage?.method).toBe("session/open")
    socket.emitMessage({
      method: "session/event",
      params: { sessionId: "session_1", seq: 8, event: { seq: 8 } },
    })
    socket.emitMessage({
      method: "session/historyReset",
      params: { sessionId: "session_1" },
    })
    await flushMicrotasks()
    const replacement = socket.sentFrames().at(-1)
    expect(replacement?.method).toBe("session/open")
    socket.emitMessage({
      id: oldPage?.id,
      result: {
        session: { id: "session_1", rolloutId: "old", seq: 7 },
        watermarkSeq: 7,
        history: { view: "summary", rolloutId: "old", seq: 7, turns: [] },
      },
    })
    await replyLiveView(socket, replacement?.id, 2)
    expect(snapshots).toEqual([2])
    expect(onEvent).not.toHaveBeenCalled()
    client.close()
  })

  it("reconnects a half-open connection and restores its session stream", async () => {
    vi.useFakeTimers()
    const onDisconnected = vi.fn()
    const onSnapshot = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot,
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
      onDisconnected,
    })
    const first = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    await replyLiveView(first, 1, 1)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(first.sentFrames().at(-1)).toMatchObject({
      method: "server/ping",
    })
    // The socket stays OPEN and no close event arrives after network loss.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(first.readyState).toBe(3)
    expect(onDisconnected).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(250)

    const second = completeHandshake(FakeWebSocket.instances[1])
    await flushMicrotasks()
    const subscribe = second
      .sentFrames()
      .find((frame) => frame.method === "session/open")
    expect(subscribe).toMatchObject({
      params: { sessionId: "session_1" },
    })
    await replyLiveView(second, subscribe?.id, 1)
    expect(onSnapshot).toHaveBeenCalledTimes(2)
    client.close()
  })

  it("keeps a responsive idle connection open across heartbeat intervals", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const request = client.request("provider/list", {})
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    socket.emitMessage({ id: 1, result: { providers: [] } })
    await request

    for (let index = 0; index < 2; index += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      const ping = socket.sentFrames().at(-1)
      expect(ping).toMatchObject({ method: "server/ping" })
      socket.emitMessage({ id: ping?.id, result: {} })
      await flushMicrotasks()
    }
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.close()
  })

  it("times out an unanswered initialize handshake and retries", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const pending = client.request("provider/list", {})
    const rejected = expect(pending).rejects.toThrow(
      "The connection to the server timed out.",
    )
    FakeWebSocket.instances[0]?.emitOpen()
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(FakeWebSocket.instances[0]?.readyState).toBe(3)
    await vi.advanceTimersByTimeAsync(250)
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.close()
  })

  it("rejects a request when the socket closes after the connection await", async () => {
    vi.useFakeTimers()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    // Initialize the connection through a stream before issuing the request.
    client.openSessionStream("session_1", 0, {
      onSnapshot: () => {},
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
    })
    const socket = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    const pending = client.request("provider/list", {})
    const rejected = expect(pending).rejects.toThrow(
      "The connection to the server was lost.",
    )
    socket.emitClose()
    await rejected
    expect(
      socket.sentFrames().filter((frame) => frame.method === "provider/list"),
    ).toHaveLength(0)
    client.close()
  })

  it("reconnects after an initialize error instead of leaving a stream waiting", async () => {
    vi.useFakeTimers()
    const onDisconnected = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot: () => {},
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
      onDisconnected,
    })
    const socket = FakeWebSocket.instances[0]
    socket?.emitOpen()
    socket?.emitMessage({
      id: 0,
      error: { code: -32603, message: "Initialization failed." },
    })
    expect(onDisconnected).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(250)
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.close()
  })

  it("reports a dropped session stream while keeping it available for reconnect", async () => {
    vi.useFakeTimers()
    const onDisconnected = vi.fn()
    const onReady = vi.fn()
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_1", 0, {
      onSnapshot: () => {},
      onEvent: () => {},
      onTransient: () => {},
      onReady,
      onDisconnected,
    })
    const first = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    first.emitClose()
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "The connection to the server was lost.",
      }),
    )

    await vi.advanceTimersByTimeAsync(250)
    const second = completeHandshake(FakeWebSocket.instances[1])
    await flushMicrotasks()
    expect(
      second.sentFrames().filter((frame) => frame.method === "session/open"),
    ).toHaveLength(1)
    await replyLiveView(second, 2, 0)
    expect(onReady).toHaveBeenCalledOnce()
    client.close()
  })

  it("reports a terminal subscribe failure through onError", async () => {
    const failures: unknown[] = []
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    client.openSessionStream("session_gone", 0, {
      onSnapshot: () => {},
      onEvent: () => {},
      onTransient: () => {},
      onReady: () => {},
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

  it("closes a failed live stream and only subscribes again when explicitly reopened", async () => {
    vi.useFakeTimers()
    const received: string[] = []
    const onError = vi.fn()
    const handlers: SessionStreamHandlers = {
      onSnapshot: () => received.push("snapshot"),
      onEvent: () => received.push("event"),
      onTransient: () => received.push("transient"),
      onReady: () => received.push("ready"),
      onError,
    }
    const client = createAppRpcClient({ apiBase: "http://api.test" })
    const failedStream = client.openSessionStream("session_1", 0, handlers)
    const first = completeHandshake(FakeWebSocket.instances[0])
    await flushMicrotasks()
    await replyLiveView(first, 1, 1)

    const failure = {
      method: "session/subscriptionError",
      params: {
        sessionId: "session_1",
        message: "Session live delivery could not start.",
      },
    }
    first.emitMessage(failure)
    first.emitMessage(failure)
    first.emitMessage({
      method: "session/event",
      params: { sessionId: "session_1", seq: 2, event: { seq: 2 } },
    })
    first.emitMessage({
      method: "session/transient",
      params: { type: "assistant.delta", sessionId: "session_1" },
    })
    first.emitMessage({
      method: "session/liveReady",
      params: { sessionId: "session_1", seq: 1 },
    })
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "ApiRequestError",
        message: "Session live delivery could not start.",
      }),
    )
    expect(received).toEqual(["snapshot", "ready"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(
      first.sentFrames().filter((frame) => frame.method === "session/open"),
    ).toHaveLength(1)

    first.emitClose()
    await vi.advanceTimersByTimeAsync(250)
    const second = completeHandshake(FakeWebSocket.instances[1])
    await flushMicrotasks()
    expect(
      second.sentFrames().filter((frame) => frame.method === "session/open"),
    ).toHaveLength(0)

    client.openSessionStream("session_1", 0, handlers)
    // A stale handle cannot close the explicitly reopened stream.
    failedStream.close()
    await flushMicrotasks()
    const reopened = second
      .sentFrames()
      .find((frame) => frame.method === "session/open")
    expect(reopened).toMatchObject({
      params: { sessionId: "session_1" },
    })
    expect(
      second
        .sentFrames()
        .filter((frame) => frame.method === "session/unsubscribe"),
    ).toHaveLength(0)
    await replyLiveView(second, reopened?.id, 0)
    expect(received).toEqual(["snapshot", "ready", "snapshot", "ready"])
    client.close()
  })
})

it("ignores malformed envelopes without consuming the pending response", async () => {
  const client = createAppRpcClient({ apiBase: "http://api.test" })
  const pending = client.request("provider/list", {})
  const socket = FakeWebSocket.instances[0]
  completeHandshake(socket)
  await flushMicrotasks()
  let settled = false
  void pending.then(() => {
    settled = true
  })
  socket?.emitMessage({ id: 1 })
  socket?.emitMessage({ id: 1, error: { code: "invalid", message: "bad" } })
  await flushMicrotasks()
  expect(settled).toBe(false)
  socket?.emitMessage({ id: 1, result: { providers: [] } })
  await expect(pending).resolves.toEqual({ providers: [] })
  client.close()
})

it.each([
  "session/input/steer",
  "session/question/answer",
] as const)("bounds %s acknowledgement waiting even when heartbeats still succeed", async (method) => {
  vi.useFakeTimers()
  const client = createAppRpcClient({ apiBase: "http://api.test" })
  const pending =
    method === "session/question/answer"
      ? client.request(method, {
          sessionId: "session_1",
          toolCallId: "question_1",
          answers: ["new direction"],
        })
      : client.request(method, {
          sessionId: "session_1",
          requestId: "request_1",
          expectedTurnId: "turn_1",
          content: {
            kind: "input",
            text: "change direction",
            elements: [],
            attachments: [],
          },
        })
  const result = pending.catch((error: unknown) => error)
  const socket = completeHandshake(FakeWebSocket.instances[0])
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(15_000)
  const ping = socket.sentFrames().at(-1)
  socket.emitMessage({ id: ping?.id, result: {} })
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(15_000)
  const error = await result
  expect(error).toBeInstanceOf(ApiRequestError)
  expect(error).toMatchObject({
    code: undefined,
    message: "Input acknowledgement timed out; delivery is unknown.",
  })
  expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  socket.emitMessage({
    id: 1,
    result: { requestId: "request_1", turnId: "turn_1" },
  })
  expect(
    socket.sentFrames().filter((frame) => frame.method === method),
  ).toHaveLength(1)
  client.close()
})
