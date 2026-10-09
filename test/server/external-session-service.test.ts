import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAcpEngine } from "../../src/server/engines/acp/adapter.ts"
import { afterEach, describe, expect, it } from "vitest"
import type {
  EngineAdapter,
  EngineBinding,
  EngineEvent,
  EngineInput,
} from "../../src/server/engines/engine.ts"
import {
  createExternalSessionService,
  listStoredExternalEngineIds,
} from "../../src/server/external-session-service.ts"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-engine-store-"))
  directories.push(directory)
  return join(directory, "sessions.sqlite")
}
function testEngine(id = "test-external") {
  let listener: ((event: EngineEvent) => void) | undefined
  const sends: EngineInput[] = []
  const bindings: {
    appSessionId: string
    engineSessionId?: string
    cwd: string
  }[] = []
  let fail = false
  const engine: EngineAdapter = {
    id,
    capabilities: {
      resume: true,
      load: true,
      list: false,
      fork: false,
      steer: false,
      queue: false,
      subagents: false,
    },
    async connect() {},
    async bind(input) {
      bindings.push(input)
      return {
        ...input,
        engineId: id,
        engineSessionId: input.engineSessionId ?? "opaque-external-session",
      }
    },
    async send(_binding: EngineBinding, input: EngineInput) {
      sends.push(input)
      if (fail) throw new Error("Connection lost after write")
      return { status: "accepted", turnId: `turn-${input.requestId}` }
    },
    async cancel() {
      return { status: "requested" }
    },
    async respondPermission() {
      return true
    },
    subscribe(_binding, handler) {
      listener = handler
      return () => {
        listener = undefined
      }
    },
    async close() {},
  }
  return {
    engine,
    sends,
    bindings,
    emit(event: EngineEvent) {
      listener?.(event)
    },
    failNext() {
      fail = true
    },
  }
}

describe("external app session persistence", () => {
  it("retains only observed display history and opaque binding across restart without replaying unfinished sends", async () => {
    const path = await databasePath()
    const first = testEngine()
    let service = createExternalSessionService({
      engine: first.engine,
      databasePath: path,
    })
    const session = await service.create({
      cwd: "/project",
      title: "Review",
      projectId: "project-one",
    })
    await service.send(session.id, { requestId: "one", text: "hello" })
    first.emit({
      type: "message.delta",
      turnId: "turn-one",
      channel: "assistant",
      text: "partial",
    })
    expect(await service.cancel(session.id, "turn-one")).toEqual({
      status: "requested",
    })
    expect(service.read(session.id)?.requests[0]?.status).toBe("accepted")
    await service.close()
    const second = testEngine()
    service = createExternalSessionService({
      engine: second.engine,
      databasePath: path,
    })
    try {
      expect(service.read(session.id)).toMatchObject({
        history: "observed",
        session: {
          title: "Review",
          projectId: "project-one",
          binding: { engineSessionId: "opaque-external-session" },
        },
        requests: [{ status: "unknown" }],
      })
      expect(service.read(session.id)?.events.at(-1)?.event).toMatchObject({
        type: "turn.status",
        status: "disconnected",
      })
      expect(
        await service.send(session.id, { requestId: "one", text: "hello" }),
      ).toEqual({ status: "rejected", reason: "outcome_unknown" })
      expect(second.sends).toHaveLength(0)
      await service.send(session.id, {
        requestId: "two",
        text: "continue explicitly",
      })
      expect(second.bindings).toEqual([
        {
          appSessionId: session.id,
          cwd: "/project",
          engineSessionId: "opaque-external-session",
        },
      ])
      expect(
        service.read(session.id)?.events.map((event) => event.seq),
      ).toEqual([1, 2, 3, 4])
      expect(listStoredExternalEngineIds(path)).toEqual(["test-external"])
    } finally {
      await service.close()
    }
  })

  it("persists send uncertainty and rejects changed or duplicate requests without a second side effect", async () => {
    const external = testEngine()
    const service = createExternalSessionService({
      engine: external.engine,
      databasePath: ":memory:",
    })
    try {
      const session = await service.create({ cwd: "/project" })
      external.failNext()
      await expect(
        service.send(session.id, { requestId: "one", text: "hello" }),
      ).rejects.toThrow("Connection lost")
      expect(service.read(session.id)?.requests[0]?.status).toBe("unknown")
      expect(
        await service.send(session.id, { requestId: "one", text: "hello" }),
      ).toEqual({ status: "rejected", reason: "outcome_unknown" })
      expect(
        await service.send(session.id, { requestId: "one", text: "changed" }),
      ).toEqual({ status: "rejected", reason: "request_conflict" })
      expect(external.sends).toHaveLength(1)
    } finally {
      await service.close()
    }
  })

  it("records real terminal and permission resolution events and deduplicates concurrent admission", async () => {
    const external = testEngine()
    const notifications: string[] = []
    const service = createExternalSessionService({
      engine: external.engine,
      databasePath: ":memory:",
      changed: (id) => notifications.push(id),
    })
    try {
      const session = await service.create({ cwd: "/project" })
      const terminalSnapshots: string[] = []
      service.subscribe(session.id, ({ event }) => {
        if (event.type === "turn.status" && event.status === "completed")
          terminalSnapshots.push(
            service.read(session.id)?.requests[0]?.status ?? "missing",
          )
      })
      const input = { requestId: "one", text: "hello" }
      const [a, b] = await Promise.all([
        service.send(session.id, input),
        service.send(session.id, input),
      ])
      expect(a).toEqual(b)
      expect(external.sends).toHaveLength(1)
      external.emit({
        type: "permission.requested",
        turnId: "turn-one",
        requestId: "permission-one",
        description: "command",
        options: [{ id: "deny-once", label: "Deny" }],
      })
      await service.respondPermission(session.id, {
        requestId: "permission-one",
        turnId: "turn-one",
        optionId: "deny-once",
      })
      external.emit({
        type: "turn.status",
        turnId: "turn-one",
        status: "completed",
        stopReason: "end_turn",
      })
      expect(service.read(session.id)?.requests[0]?.status).toBe("terminal")
      expect(
        service.read(session.id)?.events.map(({ event }) => event.type),
      ).toEqual([
        "input.submitted",
        "permission.requested",
        "permission.resolved",
        "turn.status",
      ])
      expect(notifications).toHaveLength(5)
      expect(terminalSnapshots).toEqual(["terminal"])
      expect(
        await service.send(session.id, { text: "hello", requestId: "one" }),
      ).toEqual({
        status: "accepted",
        turnId: "turn-one",
        replayed: true,
      })
    } finally {
      await service.close()
    }
  })

  it("keeps engine ownership isolated in a shared database", async () => {
    const path = await databasePath()
    const first = createExternalSessionService({
      engine: testEngine("one").engine,
      databasePath: path,
    })
    const second = createExternalSessionService({
      engine: testEngine("two").engine,
      databasePath: path,
    })
    try {
      const session = await first.create({ cwd: "/project" })
      expect(second.list()).toEqual([])
      expect(second.read(session.id)).toBeUndefined()
      await expect(
        second.send(session.id, { requestId: "x", text: "wrong engine" }),
      ).rejects.toThrow("not found")
      expect(listStoredExternalEngineIds(path)).toEqual(["one"])
    } finally {
      await first.close()
      await second.close()
    }
  })
  it("releases its journal even when the external process reports a shutdown error", async () => {
    const external = testEngine()
    external.engine.close = async () => {
      throw new Error("Shutdown failed")
    }
    const service = createExternalSessionService({
      engine: external.engine,
      databasePath: await databasePath(),
    })
    await service.create({ cwd: "/project" })
    await expect(service.close()).rejects.toThrow("Shutdown failed")
    expect(() => service.list()).toThrow("closed")
    await service.close()
  })

  it("does not reconnect or admit a pending send once service shutdown starts", async () => {
    const pids: number[] = []
    const fixture = fileURLToPath(
      new URL("../fixtures/acp/agent.mjs", import.meta.url),
    )
    const engine = createAcpEngine({
      id: "fixture",
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `process.stderr.write(String(process.pid) + "\\n"); await import(${JSON.stringify(fixture)});`,
      ],
      onStderr: (text) => {
        for (const value of text.trim().split("\n")) {
          if (/^\d+$/.test(value)) pids.push(Number(value))
        }
      },
    })
    const service = createExternalSessionService({
      engine,
      databasePath: ":memory:",
    })
    try {
      const session = await service.create({ cwd: "/tmp" })
      const sending = service.send(session.id, {
        requestId: "shutdown",
        text: "cancel",
      })
      const rejected = expect(sending).rejects.toThrow("closed")
      const closing = service.close()
      await expect(service.create({ cwd: "/tmp" })).rejects.toThrow("closed")
      await expect(
        service.send(session.id, { requestId: "late", text: "hello" }),
      ).rejects.toThrow("closed")
      await expect(service.cancel(session.id, "turn")).rejects.toThrow("closed")
      await expect(
        service.respondPermission(session.id, {
          requestId: "permission",
          optionId: "allow",
        }),
      ).rejects.toThrow("closed")
      await closing
      await rejected
      expect(pids).toHaveLength(1)
      const pid = pids[0]
      if (pid === undefined) throw new Error("Missing fixture process ID")
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      )
    } finally {
      await service.close()
      await engine.close()
    }
  })

  it("settles an in-flight creation before closing its journal", async () => {
    const external = testEngine()
    const originalBind = external.engine.bind
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    external.engine.bind = async (input) => {
      entered()
      await barrier
      return originalBind(input)
    }
    const service = createExternalSessionService({
      engine: external.engine,
      databasePath: ":memory:",
    })
    const creating = service.create({ cwd: "/project" })
    const rejected = expect(creating).rejects.toThrow("closed")
    await started
    let closed = false
    const closing = service.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await closing
    await rejected
    expect(() => service.list()).toThrow("closed")
  })
})
