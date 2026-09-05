import { describe, expect, it } from "vitest"
import type { StoredEventEnvelope } from "../../../src/kernel/index.ts"
import {
  createSessionEventHub,
  type SessionEventHub,
} from "../../../src/server/event-hub.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import {
  INTERNAL_ERROR,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "../../../src/server/rpc/messages.ts"
import type {
  ApiPendingPermission,
  ApiSessionDetail,
} from "../../../src/server/protocol.ts"
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
  pagedEventsHandler,
  type TestConnection,
  waitForCondition,
} from "./testkit.ts"

const sessionId = "session_1"

function subscribeSetup(options: {
  events: readonly StoredEventEnvelope[]
  detail?: Partial<ApiSessionDetail>
  blockFirstPage?: {
    gate: ReturnType<typeof deferred<void>>
    calls: { count: number }
  }
}) {
  const handlers = createFakeHandlers({
    readSession: async () =>
      okResult({ session: makeSessionDetail(sessionId, options.detail) }),
    readSessionEvents: async (input) => {
      if (options.blockFirstPage !== undefined) {
        options.blockFirstPage.calls.count += 1
        if (options.blockFirstPage.calls.count === 1) {
          await options.blockFirstPage.gate.promise
        }
      }
      return pagedEventsHandler(options.events)(input)
    },
  })
  const { processor, eventHub } = createTestProcessor({ handlers })
  return { processor, eventHub }
}

async function subscribe(
  connection: TestConnection,
  after?: number,
): Promise<JsonRpcResponse> {
  const response = await connection.sendRequest("session/subscribe", {
    sessionId,
    ...(after === undefined ? {} : { after }),
  })
  expect(response).toHaveProperty("result")
  return response as JsonRpcResponse
}

function frameIndex(connection: TestConnection, method: string): number {
  return connection.frames.findIndex(
    (frame) => "method" in frame && frame.method === method,
  )
}

describe("session/subscribe", () => {
  it("sends the snapshot response, replays durable events to the watermark, then marks replay complete", async () => {
    const events = [
      makeTurnStarted(sessionId, 1, "turn_1"),
      makeTurnCompleted(sessionId, 2, "turn_1"),
      makeTurnStarted(sessionId, 3, "turn_2"),
      makeTurnStarted(sessionId, 4, "turn_3"),
      makeTurnStarted(sessionId, 5, "turn_4"),
    ]
    const { processor } = subscribeSetup({ events, detail: { seq: 3 } })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const framesBeforeSubscribe = connection.frames.length

    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    const [first, ...rest] = connection.frames.slice(framesBeforeSubscribe)
    expect(first).toMatchObject({
      result: { session: { id: sessionId, seq: 3 } },
    })
    const eventFrames = rest.filter(
      (frame): frame is JsonRpcNotification =>
        "method" in frame && frame.method === "session/event",
    )
    // Replay stops at the snapshot watermark: events 4 and 5 stay unread.
    expect(eventFrames.map((frame) => frame.params)).toEqual([
      { sessionId, seq: 1, event: events[0] },
      { sessionId, seq: 2, event: events[1] },
      { sessionId, seq: 3, event: events[2] },
    ])
    const replayComplete = connection.notifications("session/replayComplete")
    expect(replayComplete.map((frame) => frame.params)).toEqual([
      { sessionId, seq: 3 },
    ])
  })

  it("replays only events after the client cursor", async () => {
    const events = [
      makeTurnStarted(sessionId, 1, "turn_1"),
      makeTurnStarted(sessionId, 2, "turn_2"),
      makeTurnStarted(sessionId, 3, "turn_3"),
    ]
    const { processor } = subscribeSetup({ events, detail: { seq: 3 } })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await subscribe(connection, 2)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    expect(
      connection
        .notifications("session/event")
        .map((frame) => (frame.params as { seq: number }).seq),
    ).toEqual([3])
  })

  it("pages the durable replay", async () => {
    const events = Array.from({ length: 600 }, (_, index) =>
      makeTurnStarted(sessionId, index + 1, `turn_${index + 1}`),
    )
    const { processor } = subscribeSetup({ events, detail: { seq: 600 } })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    expect(connection.notifications("session/event")).toHaveLength(600)
  })

  it("delivers live durable and transient events after replay-complete; transient carries no cursor", async () => {
    const { processor, eventHub } = subscribeSetup({
      events: [],
      detail: { seq: 0, activeTurnId: "turn_1" },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
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
    const blockFirstPage = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const events = [makeTurnStarted(sessionId, 1, "turn_1")]
    const { processor, eventHub } = subscribeSetup({
      events,
      detail: { seq: 1, activeTurnId: "turn_1" },
      blockFirstPage,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await waitForCondition(() => blockFirstPage.calls.count === 1)

    // The delta precedes the durable terminal in arrival order, as the
    // runtime flushes pending deltas before terminal Turn events.
    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "hel"))
    const bufferedEvent = makeTurnCompleted(sessionId, 2, "turn_1")
    eventHub.publishDurable([bufferedEvent])
    blockFirstPage.gate.resolve()
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/event" &&
        (frame.params as { seq: number }).seq === 2,
    )

    const methods = connection.frames.map((frame) =>
      "method" in frame ? frame.method : "response",
    )
    const replayCompleteAt = methods.indexOf("session/replayComplete")
    expect(replayCompleteAt).toBeGreaterThan(0)
    // The buffered transient and durable event follow replay-complete in
    // their original publish order.
    expect(methods.slice(replayCompleteAt)).toEqual([
      "session/replayComplete",
      "session/transient",
      "session/event",
    ])
    expect(
      connection
        .notifications("session/event")
        .map((frame) => (frame.params as { seq: number }).seq),
    ).toEqual([1, 2])
  })

  it("drops a stale buffered delta when the snapshot already shows the turn as terminal", async () => {
    const blockFirstPage = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const { processor, eventHub } = subscribeSetup({
      events: [makeTurnStarted(sessionId, 1, "turn_1")],
      // The snapshot is already terminal: no active turn.
      detail: { seq: 1 },
      blockFirstPage,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await waitForCondition(() => blockFirstPage.calls.count === 1)

    eventHub.publishTransient(makeAssistantDelta(sessionId, "turn_1", "stale"))
    eventHub.publishDurable([makeTurnCompleted(sessionId, 2, "turn_1")])
    blockFirstPage.gate.resolve()
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
      events: [],
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
    ).toBeGreaterThan(frameIndex(connection, "session/replayComplete"))
  })

  it("does not replay a pending permission that already arrived live during replay", async () => {
    const blockFirstPage = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const permission = makePendingPermission({ permissionRequestId: "perm_1" })
    const { processor, eventHub } = subscribeSetup({
      events: [],
      detail: { seq: 0, pendingPermissions: [permission] },
      blockFirstPage,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await waitForCondition(() => blockFirstPage.calls.count === 1)

    eventHub.publishTransient(
      makePermissionRequested(sessionId, "turn_1", "perm_1"),
    )
    blockFirstPage.gate.resolve()
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/transient",
    )
    await flush()

    expect(
      connection.notifications("session/permissionRequested"),
    ).toHaveLength(0)
    expect(connection.notifications("session/transient")).toHaveLength(1)
  })

  it("answers a snapshot failure with an error and keeps no subscription", async () => {
    const handlers = createFakeHandlers({
      readSession: async () =>
        errorResult("not_found", `Session ${sessionId} was not found.`),
    })
    const { processor, eventHub } = createTestProcessor({ handlers })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("session/subscribe", {
      sessionId,
    })
    expect(response).toMatchObject({
      error: { code: INTERNAL_ERROR, data: { code: "not_found" } },
    })

    eventHub.publishDurable([makeTurnStarted(sessionId, 1, "turn_1")])
    await flush()
    expect(connection.notifications("session/event")).toHaveLength(0)
  })

  it("does not block same-session methods behind a slow replay", async () => {
    const blockFirstPage = {
      gate: deferred<void>(),
      calls: { count: 0 },
    }
    const events = [makeTurnStarted(sessionId, 1, "turn_1")]
    const { processor } = subscribeSetup({
      events,
      detail: { seq: 1 },
      blockFirstPage,
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await waitForCondition(() => blockFirstPage.calls.count === 1)

    // The replay is still blocked on its first page, but it no longer holds
    // the session queue: a Turn-critical method completes now.
    const resolved = await connection.sendRequest("session/turn/cancel", {
      sessionId,
      turnId: "turn_1",
    })
    expect(resolved).toHaveProperty("result")

    blockFirstPage.gate.resolve()
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
  })

  it("removes a subscription registered during the closeConnection drain window", async () => {
    const baseHub = createSessionEventHub()
    let liveSubscriptions = 0
    const countingHub: SessionEventHub = {
      publishDurable: (events) => baseHub.publishDurable(events),
      publishTransient: (event) => baseHub.publishTransient(event),
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

describe("subscription fan-out", () => {
  it("delivers events to every subscribed connection and honors opt-outs", async () => {
    const { processor, eventHub } = subscribeSetup({
      events: [],
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
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
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
      events: [],
      detail: { seq: 0 },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribe(connection)
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
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
      events: [],
      detail: { seq: 0 },
    })
    const connectionA = openTestConnection(processor)
    const connectionB = openTestConnection(processor)
    await initializeConnection(connectionA)
    await initializeConnection(connectionB)
    await subscribe(connectionA)
    await subscribe(connectionB)
    await connectionB.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
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
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )
  }

  it("sends a server request for a live permission and resolves it from the answer", async () => {
    const { processor, eventHub, resolveCalls } = permissionSetup({})
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    await subscribeAndDrain(connection)

    eventHub.publishTransient(makePermissionRequested(sessionId, "turn_1", "perm_1"))
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

    eventHub.publishTransient(makePermissionRequested(sessionId, "turn_1", "perm_1"))
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

    eventHub.publishTransient(makePermissionRequested(sessionId, "turn_1", "perm_1"))
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

    eventHub.publishTransient(makePermissionRequested(sessionId, "turn_1", "perm_1"))
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
