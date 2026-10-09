import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createAcpEngine } from "../../src/server/engines/acp/adapter.ts"
import type {
  EngineAdapter,
  EngineEvent,
} from "../../src/server/engines/engine.ts"

const engines: EngineAdapter[] = []
const fixture = fileURLToPath(
  new URL("../fixtures/acp/agent.mjs", import.meta.url),
)
function engine(mode = "resume") {
  const adapter = createAcpEngine({
    id: "fixture",
    command: process.execPath,
    args: [fixture, mode],
  })
  engines.push(adapter)
  return adapter
}
async function setup(mode?: string) {
  const adapter = engine(mode)
  const binding = await adapter.bind({ appSessionId: "app", cwd: "/tmp" })
  const events: EngineEvent[] = []
  adapter.subscribe(binding, (event) => events.push(event))
  return { adapter, binding, events }
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((adapter) => adapter.close()))
})

describe("external ACP v1 process boundary", () => {
  it("negotiates capabilities, streams rich updates, and completes only on terminal response", async () => {
    const { adapter, binding, events } = await setup()
    expect(binding.engineSessionId).toBe("external-session")
    expect(
      events.find((event) => event.type === "session.update")?.update,
    ).not.toHaveProperty("sessionId")
    expect(adapter.capabilities).toEqual({
      resume: true,
      load: false,
      list: true,
      fork: false,
      steer: false,
      queue: false,
      subagents: false,
    })
    const accepted = await adapter.send(binding, {
      requestId: "r1",
      text: "hello",
    })
    expect(accepted.status).toBe("accepted")
    expect(
      await adapter.send(binding, { requestId: "r1", text: "hello" }),
    ).toEqual({ ...accepted, replayed: true })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "completed",
        ),
      )
      .toBe(true)
    expect(
      events
        .filter((event) => event.type === "turn.status")
        .map((event) => event.status),
    ).toEqual(["accepted", "running", "completed"])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        text: "first",
        channel: "assistant",
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.update",
        update: expect.objectContaining({ sessionUpdate: "tool_call" }),
      }),
    )
  })

  it("preserves opaque permission choices and sends the selected option back", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "permission" })
    await expect
      .poll(() => events.some((event) => event.type === "permission.requested"))
      .toBe(true)
    const permission = events.find(
      (event) => event.type === "permission.requested",
    )
    expect(permission?.type).toBe("permission.requested")
    if (permission?.type !== "permission.requested")
      throw new Error("Missing permission")
    expect(permission.toolCall).toMatchObject({
      rawInput: { command: "echo fixture" },
    })
    expect(permission.options[0]).toEqual({
      id: "opaque:allow/once",
      label: "Allow this",
      kind: "allow_once",
    })
    expect(
      await adapter.respondPermission(binding, {
        requestId: permission.requestId,
        optionId: "allow",
      }),
    ).toBe(false)
    expect(
      await adapter.respondPermission(binding, {
        requestId: permission.requestId,
        optionId: "opaque:allow/once",
      }),
    ).toBe(true)
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "completed",
        ),
      )
      .toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        text: "opaque:allow/once",
      }),
    )
  })

  it.each([
    "cancel",
    "cancel-permission",
  ])("keeps %s active through tail updates and cancels pending permissions", async (text) => {
    const { adapter, binding, events } = await setup()
    const accepted = await adapter.send(binding, { requestId: "r1", text })
    if (accepted.status !== "accepted") throw new Error("Not accepted")
    await expect
      .poll(() => events.some((event) => event.type === "message.delta"))
      .toBe(true)
    expect(await adapter.cancel(binding, accepted.turnId)).toEqual({
      status: "requested",
    })
    expect(
      await adapter.send(binding, { requestId: "r2", text: "too early" }),
    ).toMatchObject({ status: "rejected" })
    expect(
      events.some(
        (event) => event.type === "turn.status" && event.status === "cancelled",
      ),
    ).toBe(false)
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "cancelled",
        ),
      )
      .toBe(true)
    const tail = events.findIndex(
      (event) =>
        event.type === "message.delta" && event.text === "cancellation tail",
    )
    const terminal = events.findIndex(
      (event) => event.type === "turn.status" && event.status === "cancelled",
    )
    expect(tail).toBeGreaterThan(-1)
    expect(terminal).toBeGreaterThan(tail)
    expect(await adapter.cancel(binding, accepted.turnId)).toEqual({
      status: "not_running",
    })
  })

  it.each([
    "resume",
    "load",
  ])("reconnects using only negotiated %s capability without resending unknown prompts", async (mode) => {
    const { adapter, binding, events } = await setup(mode)
    const accepted = await adapter.send(binding, {
      requestId: "r1",
      text: "die",
    })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "disconnected",
        ),
      )
      .toBe(true)
    expect(
      await adapter.bind({
        appSessionId: "app",
        engineSessionId: binding.engineSessionId,
        cwd: "/tmp",
      }),
    ).toEqual(binding)
    expect(
      await adapter.send(binding, { requestId: "r1", text: "die" }),
    ).toEqual({ ...accepted, replayed: true })
    if (mode === "load")
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.update",
          update: expect.objectContaining({
            content: { type: "text", text: "replayed history" },
          }),
        }),
      )
    expect(
      await adapter.send(binding, { requestId: "r2", text: "new turn" }),
    ).toMatchObject({ status: "accepted" })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "completed",
        ),
      )
      .toBe(true)
  })

  it("rejects unsupported reconnection and incompatible protocol versions", async () => {
    const adapter = engine("none")
    await expect(
      adapter.bind({
        appSessionId: "app",
        engineSessionId: "previous",
        cwd: "/tmp",
      }),
    ).rejects.toThrow("no session resume/load")
    await expect(engine("v2").connect()).rejects.toThrow(
      "does not support ACP v1",
    )
  })

  it("rejects callbacks it did not advertise", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "callbacks" })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "completed",
        ),
      )
      .toBe(true)
  })

  it("malformed agent output fails the transport and ends the active turn as disconnected", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "malformed" })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "disconnected",
        ),
      )
      .toBe(true)
    expect(
      events.some(
        (event) => event.type === "turn.status" && event.status === "completed",
      ),
    ).toBe(false)
  })
  it("retains metadata delivered before session/new returns and exposes negotiated session/list", async () => {
    const adapter = engine()
    const bindings = await Promise.all([
      adapter.bind({ appSessionId: "app", cwd: "/tmp" }),
      adapter.bind({ appSessionId: "app", cwd: "/tmp" }),
    ])
    expect(bindings[0]).toEqual(bindings[1])
    const events: EngineEvent[] = []
    if (!bindings[0]) throw new Error("Missing binding")
    adapter.subscribe(bindings[0], (event) => events.push(event))
    expect(events).toContainEqual({
      type: "session.update",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    })
    expect(await adapter.listSessions()).toEqual({
      sessions: [
        { sessionId: "external-session", cwd: "/tmp", title: "Fixture" },
      ],
    })
    await expect(engine("none").listSessions()).rejects.toThrow(
      "does not support session/list",
    )
  })

  it("shuts down an active child without declaring cancellation or success", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "cancel" })
    await adapter.close()
    expect(
      events
        .filter((event) => event.type === "turn.status")
        .map((event) => event.status),
    ).toEqual(["accepted", "running", "disconnected"])
    expect(
      await adapter.send(binding, { requestId: "r2", text: "hello" }),
    ).toMatchObject({ status: "rejected" })
  })

  it("does not treat an empty prompt response as a completed turn", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "invalid-stop" })
    await expect
      .poll(() =>
        events.some(
          (event) => event.type === "turn.status" && event.status === "failed",
        ),
      )
      .toBe(true)
    expect(
      events.some(
        (event) => event.type === "turn.status" && event.status === "completed",
      ),
    ).toBe(false)
  })

  it("surfaces a missing executable at initialization", async () => {
    const adapter = createAcpEngine({
      id: "missing",
      command: "/nonexistent/yakitori-acp-agent",
    })
    engines.push(adapter)
    await expect(adapter.connect()).rejects.toThrow("ENOENT")
  })
  it("reassembles partial UTF-8 frames before interpreting notifications", async () => {
    const { adapter, binding, events } = await setup()
    await adapter.send(binding, { requestId: "r1", text: "partial" })
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "turn.status" && event.status === "completed",
        ),
      )
      .toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        text: "partial: 焼き鳥",
      }),
    )
  })
  it("loads through Node's production strip-only TypeScript runtime", async () => {
    const source = fileURLToPath(
      new URL("../../src/server/engines/acp/adapter.ts", import.meta.url),
    )
    await expect(
      promisify(execFile)(process.execPath, [
        "-e",
        `import(${JSON.stringify(source)})`,
      ]),
    ).resolves.toMatchObject({ stderr: "" })
  })

  it("rejects duplicate external session ownership including concurrent binds", async () => {
    const adapter = engine()
    const settled = await Promise.allSettled([
      adapter.bind({
        appSessionId: "a",
        engineSessionId: "shared",
        cwd: "/tmp",
      }),
      adapter.bind({
        appSessionId: "b",
        engineSessionId: "shared",
        cwd: "/tmp",
      }),
    ])
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    const existing = await adapter.bind({
      appSessionId: "a",
      engineSessionId: "shared",
      cwd: "/tmp",
    })
    expect(existing.appSessionId).toBe("a")
    await expect(
      adapter.bind({
        appSessionId: "c",
        engineSessionId: "shared",
        cwd: "/tmp",
      }),
    ).rejects.toThrow("already bound")
  })

  it.skipIf(process.platform === "win32").each(["inherit", "ignore"])(
    "disconnects on leader exit and kills TERM-resistant descendants with %s pipes",
    async (pipes) => {
      const directory = await mkdtemp(
        join(tmpdir(), "yakitori-acp-descendant-"),
      )
      const heartbeat = join(directory, "heartbeat")
      const { adapter, binding, events } = await setup()
      try {
        await adapter.send(binding, {
          requestId: "r1",
          text: `descendant:${pipes}:${heartbeat}`,
        })
        await expect
          .poll(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.status" &&
                  event.status === "disconnected",
              ),
            { timeout: 800 },
          )
          .toBe(true)
        await Promise.race([
          adapter.close(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Owned group cleanup stalled")),
              2500,
            ),
          ),
        ])
        const stopped = await readFile(heartbeat, "utf8")
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(await readFile(heartbeat, "utf8")).toBe(stopped)
      } finally {
        await adapter.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
  it("fences in-flight binding and never reopens after explicit shutdown", async () => {
    const adapter = engine()
    const binding = adapter.bind({ appSessionId: "app", cwd: "/tmp" })
    const rejected = expect(binding).rejects.toThrow(/closed/)
    await adapter.close()
    await rejected
    await expect(adapter.connect()).rejects.toThrow("closed")
    await expect(
      adapter.bind({ appSessionId: "new", cwd: "/tmp" }),
    ).rejects.toThrow("closed")
  })
})
