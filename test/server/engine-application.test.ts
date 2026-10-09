import { DatabaseSync } from "node:sqlite"
import { createRequestGate } from "../../src/server/request-gate.ts"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import type {
  EngineRpcParams,
  EngineRpcResponses,
  EngineSessionSnapshot,
} from "../../src/protocol/engine.ts"
import { readAcpEngineConfiguration } from "../../src/server/engine-configuration.ts"

let app: YakitoriApplication | undefined
let root: string | undefined
let stopServer: (() => Promise<void>) | undefined
let socket: WebSocket | undefined

afterEach(async () => {
  socket?.terminate()
  await stopServer?.()
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
  socket = undefined
  stopServer = undefined
  app = undefined
  root = undefined
  vi.unstubAllEnvs()
})

async function start(configured = true, sidecar = false) {
  root ??= await realpath(await mkdtemp(join(tmpdir(), "yakitori-engine-rpc-")))
  vi.stubEnv("CODEX_HOME", join(root, "no-codex"))
  const acpEngines = configured
    ? [
        {
          id: "fixture",
          label: "Fixture ACP",
          command: process.execPath,
          args: [resolve("test/fixtures/acp/agent.mjs")],
        },
      ]
    : []
  const requestGate = createRequestGate()
  let url: string
  if (sidecar) {
    const server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/desktop-entry.ts")],
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
        YAKITORI_PROVIDER: "faux",
        YAKITORI_STORE_DIR: root,
        YAKITORI_HOME: root,
        YAKITORI_WORKSPACE: root,
        YAKITORI_ACP_ENGINES: JSON.stringify(acpEngines),
        CODEX_HOME: join(root, "no-codex"),
        GROK_CREDENTIALS: join(root, "no-grok"),
      },
      onStderr: () => {},
    })
    stopServer = () => server.stop()
    url = server.url
  } else {
    app = await createYakitoriApplication({
      rootDir: root,
      workspace: root,
      provider: "faux",
      userConfigPath: join(root, "config.toml"),
      acpEngines,
    })
    const server = app.createHttpServer({ requestGate })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    stopServer = () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address")
    url = `http://127.0.0.1:${address.port}`
  }
  socket = new WebSocket(`${url.replace(/^http/, "ws")}/rpc`)
  await new Promise<void>((done, reject) => {
    socket?.once("open", done)
    socket?.once("error", reject)
  })
  const ws = socket
  let id = 0
  const notifications: unknown[] = []
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString())
    if (frame.method === "engineSession/changed")
      notifications.push(frame.params)
  })
  async function callRaw(method: string, params: unknown): Promise<unknown> {
    const requestId = ++id
    return new Promise((done, reject) => {
      const receive = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString()) as {
          id?: number
          result?: unknown
          error?: { message: string }
        }
        if (frame.id !== requestId) return
        ws.off("message", receive)
        if (frame.error) reject(new Error(frame.error.message))
        else done(frame.result)
      }
      ws.on("message", receive)
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  await callRaw("initialize", {
    clientInfo: { name: "engine-test", version: "1" },
  })
  return {
    requestGate,
    notifications,
    call: <M extends keyof EngineRpcParams>(
      method: M,
      params: EngineRpcParams[M],
    ) => callRaw(method, params) as Promise<EngineRpcResponses[M]>,
  }
}

it("runs configured ACP through production RPC, persists observed history, and retains it when unconfigured", async () => {
  let rpc = await start()
  const engines = await rpc.call("engine/list", {})
  expect(engines.engines.map((engine) => engine.id)).toEqual([
    "yakitori",
    "fixture",
  ])
  expect(engines.engines[1]?.capabilities.fork).toBe(false)
  const created = await rpc.call("engineSession/create", {
    engineId: "fixture",
    title: "External",
  })
  const sessionId = created.session.id
  expect(created.session.engineId).toBe("fixture")
  expect(JSON.stringify(created)).not.toContain("engineSessionId")
  const sent = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "request-1",
    text: "hello",
  })
  expect(sent.status).toBe("accepted")
  let snapshot: EngineSessionSnapshot = created
  await vi.waitFor(async () => {
    snapshot = await rpc.call("engineSession/read", { sessionId })
    expect(
      snapshot.events.some(
        ({ event }) =>
          event.type === "turn.status" && event.status === "completed",
      ),
    ).toBe(true)
  })
  expect(snapshot.history).toBe("observed")
  expect(
    snapshot.events.some(
      ({ event }) => event.type === "message.delta" && event.text === "first",
    ),
  ).toBe(true)
  expect(rpc.notifications).toContainEqual({ sessionId })
  expect(JSON.stringify(snapshot)).not.toContain("external-session")
  const count = snapshot.events.length
  const replay = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "request-1",
    text: "hello",
  })
  expect(replay.status).toBe("accepted")
  expect(
    (await rpc.call("engineSession/read", { sessionId })).events,
  ).toHaveLength(count)
  socket?.terminate()
  await stopServer?.()
  stopServer = undefined
  await app?.close()
  app = undefined
  rpc = await start(false)
  expect((await rpc.call("engineSession/list", {})).sessions[0]?.id).toBe(
    sessionId,
  )
  expect(
    (await rpc.call("engineSession/read", { sessionId })).events,
  ).toHaveLength(count)
  expect(
    (await rpc.call("engine/list", {})).engines.find(
      (engine) => engine.id === "fixture",
    )?.available,
  ).toBe(false)
  await expect(
    rpc.call("engineSession/send", {
      sessionId,
      requestId: "request-2",
      text: "new",
    }),
  ).rejects.toThrow("not configured")
  expect(
    (await rpc.call("engineSession/read", { sessionId })).requests.map(
      (request) => request.requestId,
    ),
  ).toEqual(["request-1"])
}, 20_000)

it("routes permission replies and cancellation without claiming an immediate stop", async () => {
  const rpc = await start()
  const { session } = await rpc.call("engineSession/create", {
    engineId: "fixture",
  })
  const sessionId = session.id
  await rpc.call("engineSession/send", {
    sessionId,
    requestId: "permission-1",
    text: "permission",
  })
  let snapshot: EngineSessionSnapshot | undefined
  await vi.waitFor(async () => {
    snapshot = await rpc.call("engineSession/read", { sessionId })
    expect(
      snapshot.events.some(
        ({ event }) => event.type === "permission.requested",
      ),
    ).toBe(true)
  })
  const permission = snapshot?.events.find(
    ({ event }) => event.type === "permission.requested",
  )?.event
  if (permission?.type !== "permission.requested")
    throw new Error("Expected permission")
  expect(
    await rpc.call("engineSession/respondPermission", {
      sessionId,
      turnId: permission.turnId,
      requestId: permission.requestId,
      optionId: "opaque:allow/once",
    }),
  ).toBe(true)
  await vi.waitFor(async () => {
    const read = await rpc.call("engineSession/read", { sessionId })
    expect(
      read.events.some(
        ({ event }) =>
          event.type === "turn.status" && event.status === "completed",
      ),
    ).toBe(true)
  })
  const sent = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "cancel-1",
    text: "cancel",
  })
  if (sent.status !== "accepted") throw new Error("Expected accepted input")
  expect(
    await rpc.call("engineSession/cancel", { sessionId, turnId: sent.turnId }),
  ).toEqual({ status: "requested" })
  await vi.waitFor(async () => {
    const read = await rpc.call("engineSession/read", { sessionId })
    expect(
      read.events.some(
        ({ event }) =>
          event.type === "turn.status" &&
          event.turnId === sent.turnId &&
          event.status === "cancelled",
      ),
    ).toBe(true)
  })
}, 20_000)

it("rejects executable configuration mistakes instead of silently changing engines", () => {
  expect(() =>
    readAcpEngineConfiguration(
      '[{"id":"yakitori","label":"Other","command":"node"}]',
    ),
  ).toThrow("reserved")
  expect(() =>
    readAcpEngineConfiguration([
      { id: "x", label: "X", command: "node", args: [1] },
    ]),
  ).toThrow("args")
  expect(() =>
    readAcpEngineConfiguration([
      { id: "x", label: "X", command: "node", autoInstall: true },
    ]),
  ).toThrow("Unknown")
})

it("keeps disconnected outcomes unknown and only reconnects for a new explicit input", async () => {
  const rpc = await start()
  const { session } = await rpc.call("engineSession/create", {
    engineId: "fixture",
  })
  const sessionId = session.id
  const sent = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "lost-1",
    text: "die",
  })
  expect(sent.status).toBe("accepted")
  await vi.waitFor(async () => {
    const snapshot = await rpc.call("engineSession/read", { sessionId })
    expect(
      snapshot.requests.find((request) => request.requestId === "lost-1")
        ?.status,
    ).toBe("unknown")
    expect(
      snapshot.events.some(
        ({ event }) =>
          event.type === "turn.status" && event.status === "disconnected",
      ),
    ).toBe(true)
    expect(
      snapshot.events.some(
        ({ event }) =>
          event.type === "turn.status" && event.status === "completed",
      ),
    ).toBe(false)
  })
  expect(
    await rpc.call("engineSession/send", {
      sessionId,
      requestId: "lost-1",
      text: "die",
    }),
  ).toEqual({ status: "rejected", reason: "outcome_unknown" })
  const next = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "new-1",
    text: "hello",
  })
  if (next.status !== "accepted")
    throw new Error("Expected new input admission")
  await vi.waitFor(async () => {
    const snapshot = await rpc.call("engineSession/read", { sessionId })
    expect(
      snapshot.events.some(
        ({ event }) =>
          event.type === "turn.status" &&
          event.turnId === next.turnId &&
          event.status === "completed",
      ),
    ).toBe(true)
    expect(
      snapshot.events.filter(
        ({ event }) =>
          event.type === "input.submitted" && event.requestId === "lost-1",
      ),
    ).toHaveLength(1)
  })
}, 20_000)

it("loads environment-configured ACP through the directly managed desktop Node sidecar", async () => {
  const rpc = await start(true, true)
  expect(
    (await rpc.call("engine/list", {})).engines.map((engine) => engine.id),
  ).toEqual(["yakitori", "fixture"])
  const { session } = await rpc.call("engineSession/create", {
    engineId: "fixture",
  })
  const sent = await rpc.call("engineSession/send", {
    sessionId: session.id,
    requestId: "sidecar-1",
    text: "hello",
  })
  if (sent.status !== "accepted") throw new Error("Expected accepted input")
  await vi.waitFor(async () => {
    const snapshot = await rpc.call("engineSession/read", {
      sessionId: session.id,
    })
    expect(
      snapshot.events.some(
        ({ event }) =>
          event.type === "turn.status" &&
          event.turnId === sent.turnId &&
          event.status === "completed",
      ),
    ).toBe(true)
  })
}, 20_000)

it.each([
  "permission",
  "cancel",
] as const)("allows existing ACP %s control while process admission drains", async (control) => {
  const rpc = await start()
  const { session } = await rpc.call("engineSession/create", {
    engineId: "fixture",
  })
  const sessionId = session.id
  const accepted = await rpc.call("engineSession/send", {
    sessionId,
    requestId: "existing",
    text: control,
  })
  if (accepted.status !== "accepted") throw new Error("Expected accepted input")
  let permission:
    | Extract<
        EngineSessionSnapshot["events"][number]["event"],
        { type: "permission.requested" }
      >
    | undefined
  await vi.waitFor(async () => {
    const snapshot = await rpc.call("engineSession/read", { sessionId })
    if (control === "permission") {
      const observed = snapshot.events.find(
        ({ event }) => event.type === "permission.requested",
      )?.event
      if (observed?.type === "permission.requested") permission = observed
      expect(permission).toBeDefined()
    } else {
      expect(
        snapshot.events.some(
          ({ event }) =>
            event.type === "message.delta" &&
            event.turnId === accepted.turnId &&
            event.text === "first",
        ),
      ).toBe(true)
    }
  })
  // Process admission closes first; the external service remains alive until
  // existing work has received its control responses and finished draining.
  rpc.requestGate.close()
  await expect(
    rpc.call("engineSession/send", {
      sessionId,
      requestId: "blocked-new-input",
      text: "hello",
    }),
  ).rejects.toThrow("Server is shutting down")
  await expect(
    rpc.call("engineSession/create", { engineId: "fixture" }),
  ).rejects.toThrow("Server is shutting down")
  if (control === "permission") {
    if (!permission) throw new Error("Expected pending permission")
    expect(
      await rpc.call("engineSession/respondPermission", {
        sessionId,
        turnId: permission.turnId,
        requestId: permission.requestId,
        optionId: "opaque:allow/once",
      }),
    ).toBe(true)
  } else {
    expect(
      await rpc.call("engineSession/cancel", {
        sessionId,
        turnId: accepted.turnId,
      }),
    ).toEqual({ status: "requested" })
  }
  // Read the persisted observations rather than reopening the admission gate
  // or mocking a handler. Closing the service here could mask a failed cancel.
  const database = new DatabaseSync(
    join(root as string, "external-sessions.sqlite"),
    { readOnly: true },
  )
  try {
    await vi.waitFor(() => {
      const events = database
        .prepare(
          "SELECT data FROM external_events WHERE session_id = ? ORDER BY seq",
        )
        .all(sessionId)
        .map(
          (row) =>
            JSON.parse(
              String(row.data),
            ) as EngineSessionSnapshot["events"][number],
        )
      expect(
        events.some(
          ({ event }) =>
            event.type === "turn.status" &&
            event.turnId === accepted.turnId &&
            event.status ===
              (control === "permission" ? "completed" : "cancelled"),
        ),
      ).toBe(true)
      expect(
        events.some(
          ({ event }) =>
            event.type === "message.delta" &&
            event.text ===
              (control === "permission"
                ? "opaque:allow/once"
                : "cancellation tail"),
        ),
      ).toBe(true)
    })
    expect(
      database
        .prepare(
          "SELECT request_id FROM external_requests WHERE session_id = ?",
        )
        .all(sessionId)
        .map((row) => row.request_id),
    ).toEqual(["existing"])
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM external_sessions").get()
        ?.count,
    ).toBe(1)
  } finally {
    database.close()
  }
}, 20_000)
