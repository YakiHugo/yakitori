import { describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import type { EngineEvent } from "../../src/server/engines/engine.ts"
import { YakitoriEngineAdapter } from "../../src/server/engines/yakitori.ts"
import { AppSessionService } from "../../src/server/session-service.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

describe("native full-agent boundary", () => {
  it("keeps native rollout canonical and replays only the same admitted request", async () => {
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([
            { content: [{ type: "text", text: "done" }] },
          ]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const engine = new YakitoriEngineAdapter({
      manager,
      defaults: { mateId: "mate-one", mateRevisionId: "revision-one" },
    })
    const service = new AppSessionService(engine)
    const [binding, concurrentBinding] = await Promise.all([
      service.bind({ appSessionId: "app-one", cwd: "/tmp" }),
      service.bind({ appSessionId: "app-one", cwd: "/tmp" }),
    ])
    expect(concurrentBinding).toEqual(binding)
    const thread = manager.getThread(binding.engineSessionId)
    if (thread === undefined) throw new Error("Missing bound native thread")
    const events: EngineEvent[] = []
    service.subscribe("app-one", (event) => events.push(event))
    const pump = (async () => {
      for (;;) {
        const event = await thread.nextEvent()
        if (!event) break
        engine.observe(event)
      }
    })()
    try {
      const first = await service.send("app-one", {
        requestId: "request_one",
        text: "hello",
      })
      expect(first.status).toBe("accepted")
      await expect
        .poll(() =>
          events.some(
            (event) =>
              event.type === "turn.status" && event.status === "completed",
          ),
        )
        .toBe(true)
      const replay = await service.send("app-one", {
        requestId: "request_one",
        text: "hello",
      })
      expect(replay).toMatchObject({ status: "accepted", replayed: true })
      expect(
        await service.send("app-one", {
          requestId: "request_one",
          text: "different",
        }),
      ).toEqual({ status: "rejected", reason: "request_conflict" })
      const stored = await store.readThread(binding.engineSessionId)
      expect(
        stored?.rollout.filter(({ item }) => item.type === "turn_started"),
      ).toHaveLength(1)
      expect(
        events
          .filter((event) => event.type === "turn.status")
          .map((event) => event.status),
      ).toEqual(["running", "completed"])
      await expect(
        service.bind({ appSessionId: "app-one", cwd: "/elsewhere" }),
      ).rejects.toThrow("already bound")
      await expect(
        engine.send(
          { ...binding, engineId: "other" },
          { requestId: "request_two", text: "hello" },
        ),
      ).rejects.toThrow("another engine")
    } finally {
      await manager.shutdown()
      await pump
      await service.close()
    }
  })

  it("requires the native permission option and matching turn identity", async () => {
    const gate = createPermissionGate()
    const manager = new ThreadManager({
      store: new MemoryThreadStore(),
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const engine = new YakitoriEngineAdapter({
      manager,
      resolvePermission: gate.resolve,
    })
    const binding = await engine.bind({ appSessionId: "app-one", cwd: "/tmp" })
    const pending = gate.request({
      sessionId: binding.engineSessionId,
      turnId: "turn-one",
      toolCallId: "tool-one",
      action: "run",
      timeoutMs: 5000,
    })
    const requestId = gate.list(binding.engineSessionId)[0]?.permissionRequestId
    if (requestId === undefined) throw new Error("Missing native permission")
    try {
      expect(
        await engine.respondPermission(binding, {
          requestId,
          optionId: "allow_always",
          turnId: "turn-one",
        }),
      ).toBe(false)
      expect(
        await engine.respondPermission(binding, {
          requestId,
          optionId: "allow",
          turnId: "wrong",
        }),
      ).toBe(false)
      expect(
        await engine.respondPermission(binding, {
          requestId,
          optionId: "deny",
          turnId: "turn-one",
        }),
      ).toBe(true)
      expect(await pending).toEqual({ kind: "deny" })
    } finally {
      await manager.shutdown()
      await engine.close()
    }
  })
})
