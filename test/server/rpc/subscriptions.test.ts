import { describe, expect, it, vi } from "vitest"
import { createEventEnvelope, EventType } from "../../../src/kernel/index.ts"
import type { LiveRuntimeWarning } from "../../../src/runtime/live-events.ts"
import {
  createSessionEventHub,
  type SessionDelivery,
  type SessionEventHub,
} from "../../../src/server/event-hub.ts"
import type {
  ApiPendingPermission,
  ApiSessionDetail,
} from "../../../src/server/protocol.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import {
  INTERNAL_ERROR,
  type JsonRpcResponse,
} from "../../../src/server/rpc/messages.ts"
import { PendingServerRequests } from "../../../src/server/rpc/pending-requests.ts"
import {
  createSessionSubscriptions,
  reconcileBufferedSessionDeliveries,
} from "../../../src/server/rpc/subscriptions.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  deferred,
  errorResult,
  flush,
  initializeConnection,
  makeAssistantDelta,
  makePendingPermission,
  makePermissionRequested,
  makeSessionDetail,
  makeTurnCompleted,
  makeTurnStarted,
  okResult,
  openTestConnection,
  type TestConnection,
  waitForCondition,
} from "./testkit.ts"

const sessionId = "session_1"

function subscribeSetup(options: {
  detail?: Partial<ApiSessionDetail>
  capture?: {
    gate: ReturnType<typeof deferred<void>>
    calls: { count: number }
  }
}) {
  const handlers = createFakeHandlers({
    readSession: async () => {
      if (options.capture !== undefined && ++options.capture.calls.count === 1)
        await options.capture.gate.promise
      return okResult({ session: makeSessionDetail(sessionId, options.detail) })
    },
  })
  return createTestProcessor({ handlers })
}

async function subscribe(connection: TestConnection): Promise<JsonRpcResponse> {
  const response = await connection.sendRequest("session/subscribe", {
    sessionId,
  })
  expect(response).toHaveProperty("result")
  return response as JsonRpcResponse
}

function frameIndex(connection: TestConnection, method: string): number {
  return connection.frames.findIndex(
    (frame) => "method" in frame && frame.method === method,
  )
}

describe("buffered turn lifecycle", () => {
  it("delivers runtime finish in order and drops later display events for that turn", () => {
    const before: SessionDelivery = {
      kind: "transient",
      event: makeAssistantDelta(sessionId, "turn_1", "before"),
    }
    const finished: SessionDelivery = {
      kind: "transient",
      event: {
        type: "turn.finished",
        sessionId,
        turnId: "turn_1",
        outcome: { status: "completed" },
        createdAt: "2026-09-17T00:00:00.000Z",
      },
    }
    const lateDelta = makeAssistantDelta(sessionId, "turn_1", "late")
    const delivered: SessionDelivery[] = []
    reconcileBufferedSessionDeliveries(
      [
        before,
        finished,
        { kind: "transient", event: lateDelta },
        {
          kind: "transient",
          event: {
            type: "reasoning.delta",
            streamId: "stream_1",
            offset: 0,
            sessionId,
            turnId: "turn_1",
            itemId: "late_reasoning",
            delta: "late",
            createdAt: lateDelta.createdAt,
          },
        },
        {
          kind: "transient",
          event: {
            type: "item.started",
            sessionId,
            turnId: "turn_1",
            item: { type: "reasoning", itemId: "late_item" },
            createdAt: lateDelta.createdAt,
          },
        },
      ],
      "turn_1",
      (delivery) => delivered.push(delivery),
    )
    expect(delivered).toEqual([before, finished])
  })

  it.each([
    "snapshot",
    "buffer",
  ])("keeps the newer turn from the %s active when an old turn finishes", (source) => {
    const buffered: SessionDelivery[] = []
    if (source === "buffer") {
      buffered.push({
        kind: "durable",
        events: [makeTurnStarted(sessionId, 2, "turn_new")],
      })
    }
    buffered.push(
      {
        kind: "transient",
        event: {
          type: "turn.finished",
          sessionId,
          turnId: "turn_old",
          outcome: { status: "completed" },
          createdAt: "2026-09-17T00:00:00.000Z",
        },
      },
      {
        kind: "transient",
        event: makeAssistantDelta(sessionId, "turn_new", "current"),
      },
    )
    const delivered: SessionDelivery[] = []
    reconcileBufferedSessionDeliveries(
      buffered,
      source === "snapshot" ? "turn_new" : "turn_old",
      (delivery) => delivered.push(delivery),
    )
    expect(delivered).toEqual(buffered)
  })
})

describe("session/subscribe", () => {
  it.each([
    false,
    true,
  ])("reconciles retry against progress already in the snapshot (newer retry: %s)", async (retryAfterProgress) => {
    const progress = createEventEnvelope({
      sessionId,
      seq: 2,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: {
            type: "context_compaction",
            itemId: "compaction_1",
            status: "completed",
          },
        },
      },
    })
    const retry: LiveRuntimeWarning = {
      type: "runtime.warning",
      sessionId,
      turnId: "turn_1",
      code: "model.retry",
      message: "Retrying model request",
      details: {
        kind: "rate_limited",
        nextAttempt: 2,
        maxAttempts: 4,
        delayMs: 1000,
      },
      createdAt: progress.createdAt,
    }
    const handlers = createFakeHandlers({
      readSession: async () => {
        // These events are buffered while the initial snapshot is read.
        eventHub.publishTransient(retry)
        eventHub.publishDurable([progress])
        if (retryAfterProgress) {
          eventHub.publishTransient({
            ...retry,
            message: "Retrying the next model request",
          })
        }
        return okResult({
          session: makeSessionDetail(sessionId, {
            seq: 2,
            activeTurnId: "turn_1",
          }),
        })
      },
    })
    const { processor, eventHub } = createTestProcessor({ handlers })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
    await flush()

    // Snapshot progress is already covered by the watermark. Only a retry
    // published after that progress still describes live work.
    expect(connection.notifications("session/event")).toHaveLength(0)
    expect(
      connection
        .notifications("session/transient")
        .map((frame) => frame.params),
    ).toEqual(
      retryAfterProgress
        ? [{ ...retry, message: "Retrying the next model request" }]
        : [],
    )
  })

  it("does not retire another interaction using a permission snapshot", async () => {
    const { processor } = subscribeSetup({ detail: { seq: 0 } })
    const request = processor.pendingServerRequests.register({
      sessionId,
      method: "session/elicitation/request",
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
    expect(
      processor.pendingServerRequests.resolve(request.id, { action: "cancel" }),
    ).toBe(true)
    await expect(request.response).resolves.toEqual({ action: "cancel" })
  })

  it("delivers live durable and transient events after replay-complete; transient carries no cursor", async () => {
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 0, activeTurnId: "turn_1" },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )

    const event = makeTurnStarted(sessionId, 1, "turn_1")
    eventHub.publishDurable([event])
    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "hel"))
    await flush()

    const durable = connection.notifications("session/event")
    expect(durable.map((frame) => frame.params)).toEqual([
      { sessionId, seq: 1, event },
    ])
    const transient = connection.notifications("session/transient")
    expect(transient).toHaveLength(1)
    const params = transient[0]?.params
    expect(params).toMatchObject({ type: "assistant.delta", delta: "hel" })
    expect(params).not.toHaveProperty("seq")
  })

  it("delivers live events published during replay after replay-complete in arrival order", async () => {
    const capture = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 1, activeTurnId: "turn_1" },
      capture,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const subscribing = subscribe(connection)
    await waitForCondition(() => capture.calls.count === 1)

    // The delta precedes the durable terminal in arrival order, as the
    // runtime flushes pending deltas before terminal Turn events.
    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "hel"))
    const bufferedEvent = makeTurnCompleted(sessionId, 2, "turn_1")
    eventHub.publishDurable([bufferedEvent])
    capture.gate.resolve()
    await subscribing
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/event" &&
        (frame.params as { seq: number }).seq === 2,
    )

    const methods = connection.frames.map((frame) =>
      "method" in frame ? frame.method : "response",
    )
    const replayCompleteAt = methods.indexOf("session/liveReady")
    expect(replayCompleteAt).toBeGreaterThan(0)
    // The buffered transient and durable event follow replay-complete in
    // their original publish order.
    expect(methods.slice(replayCompleteAt)).toEqual([
      "session/liveReady",
      "session/transient",
      "session/event",
    ])
    expect(
      connection
        .notifications("session/event")
        .map((frame) => (frame.params as { seq: number }).seq),
    ).toEqual([2])
  })

  it("drops a stale buffered delta when the snapshot already shows the turn as terminal", async () => {
    const capture = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const { processor, eventHub } = subscribeSetup({
      // The snapshot is already terminal: no active turn.
      detail: { seq: 1 },
      capture,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const subscribing = subscribe(connection)
    await waitForCondition(() => capture.calls.count === 1)

    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "stale"))
    eventHub.publishDurable([makeTurnCompleted(sessionId, 2, "turn_1")])
    capture.gate.resolve()
    await subscribing
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/event" &&
        (frame.params as { seq: number }).seq === 2,
    )
    await flush()

    // The durable terminal event is delivered; the stale delta that preceded
    // it in the buffer is reconciled away.
    expect(connection.notifications("session/transient")).toHaveLength(0)
  })

  it("replays a still-pending permission after replay-complete", async () => {
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    const { processor } = subscribeSetup({
      detail: { seq: 0, pendingPermissions: [permission] },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await subscribe(connection)
    await connection.waitForFrame(
      (frame) =>
        "method" in frame && frame.method === "session/permissionRequested",
    )

    expect(
      connection
        .notifications("session/permissionRequested")
        .map((f) => f.params),
    ).toEqual([{ sessionId, ...permission }])
    expect(
      frameIndex(connection, "session/permissionRequested"),
    ).toBeGreaterThan(frameIndex(connection, "session/liveReady"))
  })

  it("does not replay a pending permission that already arrived live during replay", async () => {
    const capture = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 0, pendingPermissions: [permission] },
      capture,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const subscribing = subscribe(connection)
    await waitForCondition(() => capture.calls.count === 1)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    capture.gate.resolve()
    await subscribing
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/transient",
    )
    await flush()

    expect(
      connection.notifications("session/permissionRequested"),
    ).toHaveLength(0)
    expect(connection.notifications("session/transient")).toHaveLength(1)
  })

  it.each([
    "error result",
    "rejection",
  ])("answers an initial snapshot failure and releases its live listener (%s)", async (failureMode) => {
    const eventHub = createSessionEventHub()
    const subscribe = eventHub.subscribe.bind(eventHub)
    const close = vi.fn()
    vi.spyOn(eventHub, "subscribe").mockImplementation((id, listener) => {
      const subscription = subscribe(id, listener)
      return {
        close() {
          close()
          subscription.close()
        },
      }
    })
    const { processor } = createTestProcessor({
      eventHub,
      handlers: createFakeHandlers({
        readSession: async () => {
          if (failureMode === "rejection")
            throw new Error("Snapshot storage is unavailable")
          return errorResult("not_found", `Session ${sessionId} was not found.`)
        },
      }),
      reportOperationalFailure: () => {},
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    try {
      const response = await connection.sendRequest("session/subscribe", {
        sessionId,
      })
      expect(response).toMatchObject({
        error: {
          code: INTERNAL_ERROR,
          ...(failureMode === "error result"
            ? { data: { code: "not_found" } }
            : {}),
        },
      })
      // Closing the live listener is the ownership contract: otherwise every
      // future event is retained in a replay buffer with no replay consumer.
      expect(close).toHaveBeenCalledOnce()
      eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
      await flush()
      expect(connection.notifications("session/event")).toHaveLength(0)
      expect(await connection.sendRequest("server/ping", {})).toMatchObject({
        result: {},
      })
    } finally {
      await processor.closeConnection(connection.id)
    }
  })

  it.each([
    "error result",
    "rejection",
  ])("a replaced snapshot failure leaves the current subscription alive (%s)", async (failureMode) => {
    const firstSnapshot = deferred<void>()
    const eventHub = createSessionEventHub()
    const hubSubscribe = eventHub.subscribe.bind(eventHub)
    const closedListeners: ReturnType<typeof vi.fn>[] = []
    vi.spyOn(eventHub, "subscribe").mockImplementation((id, listener) => {
      const subscription = hubSubscribe(id, listener)
      const close = vi.fn(() => subscription.close())
      closedListeners.push(close)
      return { close }
    })
    const notify = vi.fn()
    let reads = 0
    const subscriptions = createSessionSubscriptions({
      eventHub,
      pendingRequests: new PendingServerRequests(),
      handlers: createFakeHandlers({
        readSession: async () => {
          if (++reads === 1) {
            await firstSnapshot.promise
            if (failureMode === "rejection")
              throw new Error("Snapshot read failed")
            return errorResult("not_found", "Session unavailable")
          }
          return okResult({ session: makeSessionDetail(sessionId, { seq: 0 }) })
        },
      }),
      notify,
      sendRequest: () => {},
    })
    const first = subscriptions.subscribe({
      connectionId: 1,
      sessionId,
    })
    const firstResult = first.catch((error: unknown) => error)
    const replacement = await subscriptions.subscribe({
      connectionId: 1,
      sessionId,
    })
    expect(replacement.ok).toBe(true)
    if (!replacement.ok) throw new Error("Expected replacement subscription")
    await replacement.startLiveDelivery()
    firstSnapshot.resolve()
    await firstResult
    expect(closedListeners[0]).toHaveBeenCalledOnce()
    expect(closedListeners[1]).not.toHaveBeenCalled()
    eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
    await flush()
    expect(notify).toHaveBeenCalledWith(
      1,
      "session/event",
      expect.objectContaining({ sessionId, seq: 1 }),
    )
    subscriptions.removeConnection(1)
    expect(closedListeners[0]).toHaveBeenCalledOnce()
    expect(closedListeners[1]).toHaveBeenCalledOnce()
  })

  it("removes a subscription registered during the closeConnection drain window", async () => {
    const baseHub = createSessionEventHub()
    let liveSubscriptions = 0
    const countingHub: SessionEventHub = {
      publishDurable: (events) => baseHub.publishDurable(events),
      publishTransient: (event) => baseHub.publishTransient(event),
      resetSession: (id) => baseHub.resetSession(id),
      subscribe: (subscribedSessionId, listener) => {
        liveSubscriptions += 1
        const subscription = baseHub.subscribe(subscribedSessionId, listener)
        return {
          close() {
            liveSubscriptions -= 1
            subscription.close()
          },
        }
      },
    }
    const snapshotGate = deferred<void>()
    const processor = new MessageProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          await snapshotGate.promise
          return okResult({ session: makeSessionDetail(sessionId) })
        },
      }),
      eventHub: countingHub,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    connection.sendRaw(
      JSON.stringify({
        id: 42,
        method: "session/subscribe",
        params: { sessionId },
      }),
    )
    // One microtask: the serialization queue has admitted the request to the
    // connection gate, but the admitted task body has not registered the hub
    // subscriber yet — exactly the window closeConnection's first sweep
    // misses.
    await Promise.resolve()
    const closing = processor.closeConnection(connection.id)

    // The subscribe body registers after the first sweep and blocks on the
    // snapshot read, so the drain stays open with a live subscription.
    await waitForCondition(() => liveSubscriptions === 1)
    snapshotGate.resolve()

    await expect(closing).resolves.toBe("drained")
    // The post-drain sweep must not leave the late subscription behind.
    expect(liveSubscriptions).toBe(0)
  })
})

describe("session/open recovery", () => {
  it("opens the new rollout after a reset during the history read and replays only its tail", async () => {
    const historyStarted = deferred<void>()
    const finishHistory = deferred<void>()
    let rolloutId = "old_rollout"
    let seq = 40
    const { processor, eventHub } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () =>
          okResult({
            session: makeSessionDetail(sessionId, { rolloutId, seq }),
          }),
        listCompletedTurns: async () => {
          if (rolloutId === "old_rollout") {
            historyStarted.resolve()
            await finishHistory.promise
            return okResult({
              view: "summary",
              rolloutId: "old_rollout",
              seq: 40,
              turns: [],
            })
          }
          return okResult({
            view: "summary",
            rolloutId: "new_rollout",
            seq: 3,
            turns: [],
          })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const opening = connection.sendRequest("session/open", { sessionId })
    await historyStarted.promise
    eventHub.publishDurable([makeTurnStarted(sessionId, 41, "old_turn")])
    rolloutId = "new_rollout"
    seq = 3
    eventHub.resetSession(sessionId)
    eventHub.publishDurable([makeTurnStarted(sessionId, 4, "new_turn")])
    finishHistory.resolve()
    expect(await opening).toMatchObject({
      result: {
        session: { rolloutId: "new_rollout" },
        history: { rolloutId: "new_rollout", seq: 3 },
        watermarkSeq: 3,
      },
    })
    await flush()
    expect(
      connection.notifications("session/event").map(({ params }) => params),
    ).toMatchObject([
      { seq: 4, event: { type: "turn.started", data: { turnId: "new_turn" } } },
    ])
  })

  it("rereads both snapshots when the history projection temporarily conflicts", async () => {
    let seq = 1
    const listCompletedTurns = vi.fn(async () => {
      if (seq++ === 1) return errorResult("conflict", "History changed")
      return okResult({
        view: "summary" as const,
        rolloutId: "rollout_session_1",
        seq: 2,
        turns: [],
      })
    })
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () =>
          okResult({ session: makeSessionDetail(sessionId, { seq }) }),
        listCompletedTurns,
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    expect(
      await connection.sendRequest("session/open", { sessionId }),
    ).toMatchObject({
      result: { watermarkSeq: 2, history: { seq: 2 } },
    })
  })

  it.each([
    ["conflict", 3],
    ["not_found", 1],
  ] as const)("returns %s after %i attempts and releases the listener", async (code, attempts) => {
    const listCompletedTurns = vi.fn(async () =>
      errorResult(code, "Fixture failure"),
    )
    const { processor, eventHub } = createTestProcessor({
      handlers: createFakeHandlers({ listCompletedTurns }),
    })
    const subscribe = eventHub.subscribe.bind(eventHub)
    const close = vi.fn()
    vi.spyOn(eventHub, "subscribe").mockImplementation((id, listener) => {
      const subscription = subscribe(id, listener)
      return {
        close() {
          close()
          subscription.close()
        },
      }
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    expect(
      await connection.sendRequest("session/open", { sessionId }),
    ).toMatchObject({
      error: { data: { code } },
    })
    expect(listCompletedTurns).toHaveBeenCalledTimes(attempts)
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not reopen a pending request that was disconnected after reset", async () => {
    const eventHub = createSessionEventHub()
    const historyStarted = deferred<void>()
    const finishHistory = deferred<void>()
    const listCompletedTurns = vi.fn(async () => {
      historyStarted.resolve()
      await finishHistory.promise
      return errorResult("conflict", "History changed")
    })
    const subscriptions = createSessionSubscriptions({
      eventHub,
      pendingRequests: new PendingServerRequests(),
      notify: () => {},
      sendRequest: () => {},
      handlers: createFakeHandlers({ listCompletedTurns }),
    })
    const opening = subscriptions.open({ connectionId: 1, sessionId })
    await historyStarted.promise
    eventHub.resetSession(sessionId)
    subscriptions.removeConnection(1)
    finishHistory.resolve()
    expect(await opening).toMatchObject({
      ok: false,
      result: { error: { code: "conflict" } },
    })
    expect(listCompletedTurns).toHaveBeenCalledOnce()
  })
})

describe("session history reset", () => {
  it("retires permission channels after the last subscriber disconnects", async () => {
    const eventHub = createSessionEventHub()
    const pendingRequests = new PendingServerRequests()
    const resolvePermission = vi.fn()
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    const subscriptions = createSessionSubscriptions({
      eventHub,
      pendingRequests,
      notify: () => {},
      sendRequest: () => {},
      handlers: createFakeHandlers({
        readSession: async () =>
          okResult({
            session: makeSessionDetail(sessionId, {
              pendingPermissions: [permission],
            }),
          }),
        resolvePermission,
      }),
    })
    const outcome = await subscriptions.subscribe({
      connectionId: 1,
      sessionId,
    })
    if (!outcome.ok) throw new Error("Expected permission subscription")
    await outcome.startLiveDelivery()
    const oldRequest = pendingRequests.pendingForSession(sessionId)[0]
    if (oldRequest === undefined) throw new Error("Expected pending permission")
    subscriptions.removeConnection(1)
    expect(pendingRequests.size).toBe(1)
    eventHub.resetSession(sessionId)
    expect(pendingRequests.size).toBe(0)
    expect(pendingRequests.resolve(oldRequest.id, { behavior: "allow" })).toBe(
      false,
    )
    await flush()
    expect(resolvePermission).not.toHaveBeenCalled()
  })

  it("rejects a snapshot crossing reset without disturbing its replacement", async () => {
    const eventHub = createSessionEventHub()
    const pendingRequests = new PendingServerRequests()
    const snapshotGate = deferred<void>()
    const notify = vi.fn()
    const sendRequest = vi.fn()
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    let reads = 0
    const snapshot = async () => {
      if (++reads === 2) {
        await snapshotGate.promise
        return makeSessionDetail(sessionId, { seq: 90, pendingPermissions: [] })
      }
      return makeSessionDetail(sessionId, {
        seq: reads === 1 ? 90 : 1,
        pendingPermissions: [permission],
      })
    }
    const subscriptions = createSessionSubscriptions({
      eventHub,
      pendingRequests,
      notify,
      sendRequest,
      handlers: createFakeHandlers({
        readSession: async () => okResult({ session: await snapshot() }),
        readSessionEvents: async () => okResult({ events: [] }),
      }),
    })
    const initial = await subscriptions.subscribe({
      connectionId: 1,
      sessionId,
    })
    if (!initial.ok) throw new Error("Expected initial subscription")
    await initial.startLiveDelivery()
    const oldRequest = pendingRequests.pendingForSession(sessionId)[0]
    expect(oldRequest).toBeDefined()
    const oldSnapshot = subscriptions.subscribe({
      connectionId: 2,
      sessionId,
    })
    expect(reads).toBe(2)
    eventHub.resetSession(sessionId)
    const replacement = await subscriptions.subscribe({
      connectionId: 2,
      sessionId,
    })
    if (!replacement.ok) throw new Error("Expected replacement subscription")
    await replacement.startLiveDelivery()
    const newRequest = pendingRequests.pendingForSession(sessionId)[0]
    expect(newRequest?.id).not.toBe(oldRequest?.id)
    snapshotGate.resolve()
    expect(await oldSnapshot).toMatchObject({
      ok: false,
      result: { ok: false, error: { code: "conflict" } },
    })
    await flush()
    expect(pendingRequests.pendingForSession(sessionId)).toEqual([newRequest])
    notify.mockClear()
    eventHub.publishDurable([makeTurnStarted(sessionId, 2, "turn_new")])
    expect(notify).toHaveBeenCalledWith(
      2,
      "session/event",
      expect.objectContaining({ seq: 2 }),
    )
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe("subscription fan-out", () => {
  it("delivers events to every subscribed connection and honors opt-outs", async () => {
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 0 },
    })
    const connectionA = openTestConnection(processor)
    const connectionB = openTestConnection(processor)
    await initializeConnection(connectionA)
    await initializeConnection(connectionB, {
      optOutNotificationMethods: ["session/event"],
    })
    await subscribe(connectionA)
    await subscribe(connectionB)
    await connectionA.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )

    eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "hel"))
    await connectionA.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/transient",
    )
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/transient",
    )

    expect(connectionA.notifications("session/event")).toHaveLength(1)
    expect(connectionA.notifications("session/transient")).toHaveLength(1)
    // Connection B opted out of session/event but still receives transients.
    expect(connectionB.notifications("session/event")).toHaveLength(0)
    expect(connectionB.notifications("session/transient")).toHaveLength(1)
  })

  it("stops delivery after unsubscribe", async () => {
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 0 },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )

    const unsubscribed = await connection.sendRequest("session/unsubscribe", {
      sessionId,
    })
    expect(unsubscribed).toMatchObject({ result: {} })

    eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "hel"))
    await flush()
    expect(connection.notifications("session/event")).toHaveLength(0)
    expect(connection.notifications("session/transient")).toHaveLength(0)
  })

  it("removes subscriptions on closeConnection without affecting other connections", async () => {
    const { processor, eventHub } = subscribeSetup({
      detail: { seq: 0 },
    })
    const connectionA = openTestConnection(processor)
    const connectionB = openTestConnection(processor)
    await initializeConnection(connectionA)
    await initializeConnection(connectionB)
    await subscribe(connectionA)
    await subscribe(connectionB)
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
    const framesBefore = connectionA.frames.length

    await expect(processor.closeConnection(connectionA.id)).resolves.toBe(
      "drained",
    )
    eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/event",
    )
    await flush()

    expect(connectionA.frames.length).toBe(framesBefore)
    expect(connectionB.notifications("session/event")).toHaveLength(1)
  })
})

describe("session/permission/request", () => {
  type ResolveCall = {
    sessionId: string
    turnId: string
    permissionRequestId: string
    behavior: "allow" | "deny"
    reason?: { kind: string; message?: string }
  }

  function permissionSetup(input: {
    pendingPermissions?: ApiPendingPermission[]
    detail?: Partial<ApiSessionDetail>
  }) {
    const resolveCalls: ResolveCall[] = []
    const handlers = createFakeHandlers({
      readSession: async () =>
        okResult({
          session: makeSessionDetail(sessionId, {
            seq: 0,
            activeTurnId: "turn_1",
            ...input.detail,
            pendingPermissions: input.pendingPermissions ?? [],
          }),
        }),
      resolvePermission: async (resolveInput) => {
        resolveCalls.push(resolveInput as ResolveCall)
        return okResult({
          sessionId,
          turnId: "turn_1",
          permissionRequestId: "perm_1",
          behavior: "allow" as const,
        })
      },
    })
    const { processor, eventHub } = createTestProcessor({ handlers })
    return { processor, eventHub, resolveCalls }
  }

  function permissionRequests(
    connection: TestConnection,
  ): { id: string | number; params: { permissionRequestId: string } }[] {
    return connection.frames
      .filter(
        (frame) =>
          "method" in frame &&
          "id" in frame &&
          frame.method === "session/permission/request",
      )
      .map((frame) => ({
        id: (frame as { id: string | number }).id,
        params: (frame as { params: { permissionRequestId: string } }).params,
      }))
  }

  async function subscribeAndDrain(connection: TestConnection): Promise<void> {
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
  }

  it("sends a server request for a live permission and resolves it from the answer", async () => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribeAndDrain(connection)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    )

    // The display transient still flows; the request only carries the answer
    // channel with the same tool detail.
    expect(connection.notifications("session/transient")).toHaveLength(1)
    const request = permissionRequests(connection)[0]
    expect(request?.params).toMatchObject({
      sessionId,
      turnId: "turn_1",
      permissionRequestId: "perm_1",
      toolCallId: "call_1",
      action: "exec",
    })

    connection.sendRaw(
      JSON.stringify({
        id: request?.id,
        result: { behavior: "allow", reason: { kind: "user_allowed" } },
      }),
    )
    await waitForCondition(() => resolveCalls.length === 1)
    expect(resolveCalls[0]).toEqual({
      sessionId,
      turnId: "turn_1",
      permissionRequestId: "perm_1",
      behavior: "allow",
      reason: { kind: "user_allowed" },
    })
  })

  it("fans one answer channel out to every subscribed connection and resolves once", async () => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connectionA = openTestConnection(processor)
    const connectionB = openTestConnection(processor)
    await initializeConnection(connectionA)
    await initializeConnection(connectionB)
    await subscribeAndDrain(connectionA)
    await subscribeAndDrain(connectionB)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    await connectionB.waitForFrame(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    )

    const [requestA] = permissionRequests(connectionA)
    const [requestB] = permissionRequests(connectionB)
    expect(requestA?.id).toBe(requestB?.id)

    // The first answer wins; a duplicate answer finds no pending entry.
    connectionB.sendRaw(
      JSON.stringify({ id: requestB?.id, result: { behavior: "deny" } }),
    )
    connectionA.sendRaw(
      JSON.stringify({ id: requestA?.id, result: { behavior: "allow" } }),
    )
    await waitForCondition(() => resolveCalls.length === 1)
    await flush()
    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0]?.behavior).toBe("deny")
  })

  it("fails closed when the client answers with an error", async () => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribeAndDrain(connection)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    )
    const [request] = permissionRequests(connection)

    connection.sendRaw(
      JSON.stringify({
        id: request?.id,
        error: { code: INTERNAL_ERROR, message: "client blew up" },
      }),
    )
    await waitForCondition(() => resolveCalls.length === 1)
    expect(resolveCalls[0]).toMatchObject({
      permissionRequestId: "perm_1",
      behavior: "deny",
      reason: { kind: "approval_request_failed" },
    })
  })

  it("fails closed when the answer payload is malformed", async () => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribeAndDrain(connection)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    )
    const [request] = permissionRequests(connection)

    connection.sendRaw(
      JSON.stringify({ id: request?.id, result: { behavior: "maybe" } }),
    )
    await waitForCondition(() => resolveCalls.length === 1)
    expect(resolveCalls[0]).toMatchObject({
      permissionRequestId: "perm_1",
      behavior: "deny",
      reason: { kind: "approval_request_failed" },
    })
  })

  it("re-sends the pending request on re-subscribe so a reconnected client can answer", async () => {
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    const { processor, resolveCalls } = permissionSetup({
      pendingPermissions: [permission],
      detail: { activeTurnId: "turn_1" },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await subscribeAndDrain(connection)
    const first = permissionRequests(connection)
    expect(first).toHaveLength(1)

    // A repeat subscribe replaces the previous one, mirroring a reconnect.
    await subscribeAndDrain(connection)
    const all = permissionRequests(connection)
    expect(all).toHaveLength(2)
    // Register-or-reuse: the re-sent request keeps the same server id.
    expect(all[1]?.id).toBe(first[0]?.id)

    connection.sendRaw(
      JSON.stringify({ id: all[1]?.id, result: { behavior: "allow" } }),
    )
    await waitForCondition(() => resolveCalls.length === 1)
    expect(resolveCalls[0]?.behavior).toBe("allow")
  })

  it.each([
    "allow",
    "deny",
  ] as const)("keeps a live permission answerable when a concurrent snapshot predates it (%s)", async (behavior) => {
    const snapshotRead = deferred<void>()
    const releaseSnapshot = deferred<void>()
    const resolveCalls: ResolveCall[] = []
    let reads = 0
    const handlers = createFakeHandlers({
      readSession: async () => {
        const response = okResult({
          session: makeSessionDetail(sessionId, {
            seq: 0,
            activeTurnId: "turn_1",
            pendingPermissions: [],
          }),
        })
        if (++reads === 2) {
          // The real handler samples permissions before awaiting project
          // and presentation reads; a live request can arrive meanwhile.
          snapshotRead.resolve()
          await releaseSnapshot.promise
        }
        return response
      },
      resolvePermission: async (input) => {
        resolveCalls.push(input as ResolveCall)
        return okResult({
          sessionId,
          turnId: "turn_1",
          permissionRequestId: "perm_1",
          behavior,
        })
      },
    })
    const { processor, eventHub } = createTestProcessor({ handlers })
    const watching = openTestConnection(processor)
    const reconnecting = openTestConnection(processor)
    await initializeConnection(watching)
    await initializeConnection(reconnecting)
    await subscribeAndDrain(watching)
    const subscribing = subscribeAndDrain(reconnecting)
    await snapshotRead.promise

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    const [originalRequest] = permissionRequests(watching)
    expect(originalRequest).toBeDefined()
    releaseSnapshot.resolve()
    await subscribing
    await flush()
    const [replayedRequest] = permissionRequests(reconnecting)
    watching.sendRaw(
      JSON.stringify({ id: originalRequest?.id, result: { behavior } }),
    )
    await flush()
    expect(resolveCalls).toEqual([
      { sessionId, turnId: "turn_1", permissionRequestId: "perm_1", behavior },
    ])
    expect(replayedRequest?.id).toBe(originalRequest?.id)
    reconnecting.sendRaw(
      JSON.stringify({
        id: replayedRequest?.id,
        result: { behavior: behavior === "allow" ? "deny" : "allow" },
      }),
    )
    await flush()
    expect(resolveCalls).toHaveLength(1)
    expect(processor.pendingServerRequests.size).toBe(0)
    await processor.closeConnection(watching.id)
    await processor.closeConnection(reconnecting.id)
  })

  it.each([
    "durable",
    "transient",
  ] as const)("retires unanswered permissions when their turn finishes via %s delivery", async (kind) => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/liveReady",
    )
    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    const request = permissionRequests(connection)[0]
    expect(request).toBeDefined()
    expect(processor.pendingServerRequests.size).toBe(1)
    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_2", "perm_2"),
    )
    expect(processor.pendingServerRequests.size).toBe(2)
    if (kind === "durable")
      eventHub.publishDurable([makeTurnCompleted(sessionId, 1, "turn_1")])
    else
      eventHub.publishTransient({
        type: "turn.finished",
        sessionId,
        turnId: "turn_1",
        outcome: { status: "interrupted" },
        createdAt: "2026-09-17T00:00:00.000Z",
      })
    await flush()
    expect(
      processor.pendingServerRequests.pendingForSession(sessionId),
    ).toMatchObject([
      { params: { turnId: "turn_2", permissionRequestId: "perm_2" } },
    ])
    connection.sendRaw(
      JSON.stringify({ id: request?.id, result: { behavior: "allow" } }),
    )
    await flush()
    expect(resolveCalls).toEqual([])
  })

  it("prunes pending requests the snapshot no longer lists, without resolving", async () => {
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    let snapshotPermissions = [permission]
    const resolveCalls: ResolveCall[] = []
    const handlers = createFakeHandlers({
      readSession: async () =>
        okResult({
          session: makeSessionDetail(sessionId, {
            seq: 0,
            activeTurnId: "turn_1",
            pendingPermissions: snapshotPermissions,
          }),
        }),
      resolvePermission: async (resolveInput) => {
        resolveCalls.push(resolveInput as ResolveCall)
        return okResult({
          sessionId,
          turnId: "turn_1",
          permissionRequestId: "perm_1",
          behavior: "allow" as const,
        })
      },
    })
    const { processor } = createTestProcessor({ handlers })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await subscribeAndDrain(connection)
    expect(permissionRequests(connection)).toHaveLength(1)
    expect(
      processor.pendingServerRequests.pendingForSession(sessionId),
    ).toHaveLength(1)

    // The Turn ended while nobody watched: the next subscribe prunes the
    // entry instead of re-sending it.
    snapshotPermissions = []
    await subscribeAndDrain(connection)
    await flush()

    expect(permissionRequests(connection)).toHaveLength(1)
    expect(
      processor.pendingServerRequests.pendingForSession(sessionId),
    ).toHaveLength(0)
    expect(resolveCalls).toHaveLength(0)
  })
})

describe("application event projection", () => {
  it("advances an opaque native record's cursor without sending its payload", async () => {
    const { processor, eventHub } = subscribeSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await flush()
    eventHub.publishDurable([
      {
        id: "native-record",
        sessionId,
        seq: 9,
        version: 7,
        createdAt: "2026-10-09T00:00:00.000Z",
        type: "rollout.item",
        data: {
          item: { type: "compacted", nativeContext: "private engine state" },
        },
      },
    ])
    await flush()
    const event = connection.frames.findLast(
      (frame) => "method" in frame && frame.method === "session/event",
    )
    expect(event).toEqual({
      method: "session/event",
      params: {
        sessionId,
        seq: 9,
        event: {
          id: "native-record",
          sessionId,
          seq: 9,
          version: 7,
          createdAt: "2026-10-09T00:00:00.000Z",
          type: "session.cursor",
          data: {},
        },
      },
    })
  })
})
