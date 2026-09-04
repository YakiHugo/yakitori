import { describe, expect, it } from "vitest"
import type { UserConfigStore } from "../../../src/server/user-config.ts"
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  SERVER_OVERLOADED,
} from "../../../src/server/rpc/messages.ts"
import { ServerRequestRejectedError } from "../../../src/server/rpc/pending-requests.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  deferred,
  errorResult,
  flush,
  initializeConnection,
  makeSessionDetail,
  okResult,
  openTestConnection,
  waitForCondition,
} from "./testkit.ts"

describe("initialize handshake", () => {
  it("rejects any request before initialize", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)

    const response = await connection.sendRequest("session/list")

    expect(response).toMatchObject({
      error: { code: INVALID_REQUEST, message: "Not initialized" },
    })
  })

  it("returns the server identity and records capabilities", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)

    const response = await initializeConnection(connection, {
      experimentalApi: true,
      optOutNotificationMethods: ["session/event"],
    })

    expect(response).toMatchObject({
      result: {
        userAgent: "yakitori",
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
      },
    })
    // The connection is usable afterwards.
    const list = await connection.sendRequest("session/list")
    expect(list).toMatchObject({ result: { sessions: [] } })
  })

  it("rejects a second initialize", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await initializeConnection(connection)

    expect(response).toMatchObject({
      error: { code: INVALID_REQUEST, message: "Already initialized" },
    })
  })

  it("rejects invalid initialize params without marking the connection initialized", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)

    const missingClientInfo = await connection.sendRequest("initialize", {
      capabilities: {},
    })
    expect(missingClientInfo).toMatchObject({
      error: { code: INVALID_PARAMS },
    })
    const badCapabilities = await connection.sendRequest("initialize", {
      clientInfo: { name: "test-client", version: "0.0.0" },
      capabilities: { optOutNotificationMethods: "session/event" },
    })
    expect(badCapabilities).toMatchObject({ error: { code: INVALID_PARAMS } })

    const retry = await initializeConnection(connection)
    expect(retry).toHaveProperty("result")
  })

  it("ignores client notifications", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const framesBefore = connection.frames.length

    connection.sendNotification("initialized")
    connection.sendNotification("unknown/notification", { value: 1 })
    await flush()

    expect(connection.frames.length).toBe(framesBefore)
  })
})

describe("method dispatch", () => {
  it("dispatches a handler-backed method and returns its body", async () => {
    const seen: unknown[] = []
    const session = makeSessionDetail("session_1", { seq: 7 })
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async (input) => {
          seen.push(input)
          return okResult({ session })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("session/read", {
      sessionId: "session_1",
    })

    expect(response).toMatchObject({ result: { session: { id: "session_1" } } })
    expect(seen).toEqual([{ sessionId: "session_1" }])
  })

  it("maps handler validation failures to INVALID_PARAMS keeping the api code", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () =>
          errorResult("invalid_input", "sessionId must be a session id."),
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("session/read", {
      sessionId: "nope",
    })

    expect(response).toMatchObject({
      error: {
        code: INVALID_PARAMS,
        message: "sessionId must be a session id.",
        data: { code: "invalid_input" },
      },
    })
  })

  it("maps other handler failures to INTERNAL_ERROR keeping the api code", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () =>
          errorResult("not_found", "Session session_1 was not found."),
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("session/read", {
      sessionId: "session_1",
    })

    expect(response).toMatchObject({
      error: {
        code: INTERNAL_ERROR,
        data: { code: "not_found" },
      },
    })
  })

  it("rejects unknown methods with METHOD_NOT_FOUND", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("session/explode")

    expect(response).toMatchObject({
      error: {
        code: METHOD_NOT_FOUND,
        message: "Unknown method: session/explode",
      },
    })
  })

  it("answers malformed JSON with a null-id parse error", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)

    connection.sendRaw("{ not json")
    const frame = await connection.waitForFrame(
      (candidate) => "error" in candidate,
    )

    expect(frame).toMatchObject({ id: null, error: { code: PARSE_ERROR } })
  })

  it("serves project and provider methods from the injected dependencies", async () => {
    const projects: string[] = []
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      projectRegistry: {
        list: async () => projects,
        add: async (path) => {
          projects.push(path)
          return projects
        },
      },
      providers: async () => ({
        providers: [{ name: "fake", models: [] }],
        defaultProvider: "fake",
        defaultModel: "fake-model",
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    await expect(connection.sendRequest("project/list")).resolves.toMatchObject(
      { result: { projects: [] } },
    )
    await expect(
      connection.sendRequest("project/add", { path: "/workspace/a" }),
    ).resolves.toMatchObject({ result: { projects: ["/workspace/a"] } })
    await expect(
      connection.sendRequest("provider/list"),
    ).resolves.toMatchObject({
      result: { defaultProvider: "fake" },
    })
  })

  it("reports methods whose dependency is not configured as not found", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("project/list")

    expect(response).toMatchObject({ error: { code: METHOD_NOT_FOUND } })
  })

  it("writes the user preference through the config store", async () => {
    const written: unknown[] = []
    const userConfig: UserConfigStore = {
      read: async () => undefined,
      readConfiguration: async () => ({}),
      write: async (preference) => {
        written.push(preference)
        return preference
      },
    }
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      userConfig,
      availableProviders: ["fake"],
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("userPreference/write", {
      provider: "fake",
      model: "fake-model",
    })

    expect(response).toMatchObject({
      result: { userPreference: { provider: "fake", model: "fake-model" } },
    })
    expect(written).toEqual([{ provider: "fake", model: "fake-model" }])
  })

  it("rejects a user preference naming an unregistered provider", async () => {
    const userConfig: UserConfigStore = {
      read: async () => undefined,
      readConfiguration: async () => ({}),
      write: async (preference) => preference,
    }
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      userConfig,
      availableProviders: ["fake"],
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = await connection.sendRequest("userPreference/write", {
      provider: "other",
      model: "fake-model",
    })

    expect(response).toMatchObject({
      error: { code: INVALID_PARAMS, data: { code: "invalid_input" } },
    })
  })
})

describe("serialization scopes", () => {
  it("serializes requests for the same session one at a time", async () => {
    const gate = deferred<void>()
    let active = 0
    let maxActive = 0
    const startOrder: number[] = []
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async (input) => {
          const sessionId = (input as { sessionId: string }).sessionId
          startOrder.push(Number(sessionId.at(-1)))
          active += 1
          maxActive = Math.max(maxActive, active)
          if (startOrder.length === 1) await gate.promise
          active -= 1
          return okResult({ session: makeSessionDetail(sessionId) })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const first = connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    await waitForCondition(() => startOrder.length === 1)
    const second = connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    await flush()
    expect(startOrder.length).toBe(1)

    gate.resolve()
    await Promise.all([first, second])
    expect(startOrder).toEqual([1, 1])
    expect(maxActive).toBe(1)
  })

  it("runs requests for different sessions concurrently", async () => {
    const gate = deferred<void>()
    const started: string[] = []
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async (input) => {
          const sessionId = (input as { sessionId: string }).sessionId
          started.push(sessionId)
          if (sessionId === "session_blocked") await gate.promise
          return okResult({ session: makeSessionDetail(sessionId) })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const blocked = connection.sendRequest("session/read", {
      sessionId: "session_blocked",
    })
    await waitForCondition(() => started.length === 1)

    const other = await connection.sendRequest("session/read", {
      sessionId: "session_other",
    })
    expect(other).toHaveProperty("result")

    gate.resolve()
    await blocked
  })

  it("excludes a concurrent catalog read while the user preference writes", async () => {
    const writeGate = deferred<void>()
    let providersCalled = false
    const userConfig: UserConfigStore = {
      read: async () => undefined,
      readConfiguration: async () => ({}),
      write: async (preference) => {
        await writeGate.promise
        return preference
      },
    }
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      userConfig,
      availableProviders: ["fake"],
      providers: async () => {
        providersCalled = true
        return {
          providers: [{ name: "fake", models: [] }],
          defaultProvider: "fake",
          defaultModel: "fake-model",
        }
      },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const write = connection.sendRequest("userPreference/write", {
      provider: "fake",
      model: "fake-model",
    })
    const read = connection.sendRequest("provider/list")
    await flush()
    // The catalog read shares the config queue key with the write, so it must
    // not start until the write completes.
    expect(providersCalled).toBe(false)

    writeGate.resolve()
    await write
    await read
    expect(providersCalled).toBe(true)
  })

  it("runs session/list without waiting on a project write", async () => {
    const addGate = deferred<void>()
    let addCalled = false
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      projectRegistry: {
        list: async () => [],
        add: async (path) => {
          addCalled = true
          await addGate.promise
          return [path]
        },
      },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const add = connection.sendRequest("project/add", { path: "/workspace/a" })
    await waitForCondition(() => addCalled)

    // session/list is unserialized: it does not queue behind the project add.
    const list = await connection.sendRequest("session/list")
    expect(list).toMatchObject({ result: { sessions: [] } })

    addGate.resolve()
    await add
  })

  it("runs two session/create requests concurrently", async () => {
    const base = createFakeHandlers()
    let started = 0
    const bothStarted = deferred<void>()
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        createSession: async (input) => {
          started += 1
          if (started === 2) bothStarted.resolve()
          // Deadlocks if the two requests serialize on a shared scope.
          await bothStarted.promise
          return base.createSession(input)
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const [first, second] = await Promise.all([
      connection.sendRequest("session/create", {}),
      connection.sendRequest("session/create", {}),
    ])
    expect(first).toHaveProperty("result")
    expect(second).toHaveProperty("result")
    expect(started).toBe(2)
  })

  it("excludes a project list while a project add is in flight", async () => {
    const addGate = deferred<void>()
    let addCalled = false
    let listCalled = false
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
      projectRegistry: {
        list: async () => {
          listCalled = true
          return []
        },
        add: async (path) => {
          addCalled = true
          await addGate.promise
          return [path]
        },
      },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const add = connection.sendRequest("project/add", { path: "/workspace/a" })
    await waitForCondition(() => addCalled)
    const list = connection.sendRequest("project/list")
    await flush()
    // Both methods share the projects queue key: the read waits for the write.
    expect(listCalled).toBe(false)

    addGate.resolve()
    await add
    await list
    expect(listCalled).toBe(true)
  })
})

describe("closeConnection", () => {
  it("drains an admitted request before removing the connection", async () => {
    const gate = deferred<void>()
    let calls = 0
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          calls += 1
          await gate.promise
          return okResult({ session: makeSessionDetail("session_1") })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const response = connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    // The request must be admitted to the gate before close; queued-but-not
    // yet admitted work is dropped by design.
    await waitForCondition(() => calls === 1)
    const closing = processor.closeConnection(connection.id)
    gate.resolve()

    await expect(closing).resolves.toBe("drained")
    await expect(response).resolves.toHaveProperty("result")

    // Sends after close are dropped.
    const framesBefore = connection.frames.length
    connection.sendRaw(JSON.stringify({ id: 99, method: "session/list" }))
    await flush()
    expect(connection.frames.length).toBe(framesBefore)
  })

  it("drops a queued request that was never admitted to the gate", async () => {
    const gate = deferred<void>()
    let calls = 0
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          calls += 1
          if (calls === 1) await gate.promise
          return okResult({ session: makeSessionDetail("session_1") })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const first = connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    await waitForCondition(() => calls === 1)
    void connection.sendRequest("session/read", { sessionId: "session_1" })
    await flush()

    const closing = processor.closeConnection(connection.id)
    gate.resolve()
    await expect(closing).resolves.toBe("drained")
    await first
    await flush()
    // The queued second request was skipped when the queue polled it after the
    // gate closed; only the admitted first request ran.
    expect(calls).toBe(1)
  })

  it("resolves immediately for an unknown connection", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    await expect(processor.closeConnection(9999)).resolves.toBe("drained")
  })
})

describe("pending server requests", () => {
  it("resolves a server request from a response over another connection", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connectionA = openTestConnection(processor)
    const connectionB = openTestConnection(processor)
    await initializeConnection(connectionA)

    const registered = processor.pendingServerRequests.register({
      sessionId: "session_1",
      method: "session/permission/request",
      params: { permissionRequestId: "perm_1" },
    })
    connectionB.sendRaw(
      JSON.stringify({ id: registered.id, result: { behavior: "allow" } }),
    )

    await expect(registered.response).resolves.toEqual({ behavior: "allow" })
  })

  it("rejects a server request when the client answers with an error", async () => {
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers(),
    })
    const connection = openTestConnection(processor)

    const registered = processor.pendingServerRequests.register({
      sessionId: "session_1",
      method: "session/permission/request",
    })
    connection.sendRaw(
      JSON.stringify({
        id: registered.id,
        error: { code: INTERNAL_ERROR, message: "denied" },
      }),
    )

    const rejection = await registered.response.catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(ServerRequestRejectedError)
    expect((rejection as ServerRequestRejectedError).message).toBe("denied")
  })
})

describe("inbound overload bound", () => {
  it("rejects requests past the bound with SERVER_OVERLOADED while earlier requests complete", async () => {
    const gate = deferred<void>()
    let started = 0
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          started += 1
          await gate.promise
          return okResult({ session: makeSessionDetail("session_1") })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    // 128 admitted-or-queued requests fill the safety bound: the first runs
    // (blocked) and the rest queue behind it on the session key.
    const admitted = Array.from({ length: 128 }, () =>
      connection.sendRequest("session/read", { sessionId: "session_1" }),
    )
    await waitForCondition(() => started === 1)

    const overflow = await connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    expect(overflow).toMatchObject({
      error: {
        code: SERVER_OVERLOADED,
        message: "Server overloaded; retry later.",
      },
    })

    gate.resolve()
    for (const response of await Promise.all(admitted)) {
      expect(response).toHaveProperty("result")
    }
    // Settled requests release their slots.
    const after = await connection.sendRequest("session/read", {
      sessionId: "session_1",
    })
    expect(after).toHaveProperty("result")
  })

  it("still processes a response message while at the bound", async () => {
    const gate = deferred<void>()
    const { processor } = createTestProcessor({
      handlers: createFakeHandlers({
        readSession: async () => {
          await gate.promise
          return okResult({ session: makeSessionDetail("session_1") })
        },
      }),
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)

    const admitted = Array.from({ length: 128 }, () =>
      connection.sendRequest("session/read", { sessionId: "session_1" }),
    )
    // Responses resolve server→client requests and are never rejected.
    const registered = processor.pendingServerRequests.register({
      sessionId: "session_1",
      method: "session/permission/request",
    })
    connection.sendRaw(
      JSON.stringify({ id: registered.id, result: { behavior: "allow" } }),
    )
    await expect(registered.response).resolves.toEqual({ behavior: "allow" })

    gate.resolve()
    await Promise.all(admitted)
  })
})
