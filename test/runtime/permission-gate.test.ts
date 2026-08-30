import { describe, expect, it } from "vitest"
import {
  createPermissionGate,
  type RuntimePermissionEvent,
} from "../../src/runtime/permission-gate.ts"

describe("permission gate", () => {
  it("accepts a decision delivered synchronously with the request event", async () => {
    let gate: ReturnType<typeof createPermissionGate>
    const events: RuntimePermissionEvent[] = []
    gate = createPermissionGate({
      publish: (event) => {
        events.push(event)
        if (event.type !== "permission.requested") return
        gate.resolve({
          sessionId: event.sessionId,
          turnId: event.turnId,
          permissionRequestId: event.permissionRequestId,
          behavior: "allow",
        })
      },
    })

    await expect(
      gate.request({
        sessionId: "session_sync",
        turnId: "turn_sync",
        toolCallId: "tool_sync",
        action: "command_execution",
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ kind: "allow" })
    expect(events.map((event) => event.type)).toEqual([
      "permission.requested",
      "permission.resolved",
    ])
    expect(gate.list("session_sync")).toEqual([])
  })

  it("lists a pending request until a matching decision resolves it", async () => {
    const gate = createPermissionGate()
    const outcome = gate.request({
      sessionId: "session_pending",
      turnId: "turn_pending",
      toolCallId: "tool_pending",
      action: "file_change",
      subject: "src/app.ts",
      timeoutMs: 1_000,
    })
    const pending = gate.list("session_pending")[0]
    if (pending === undefined) throw new Error("missing pending permission")

    expect(
      gate.resolve({
        sessionId: "session_wrong",
        turnId: pending.turnId,
        permissionRequestId: pending.permissionRequestId,
        behavior: "allow",
      }),
    ).toBe(false)
    expect(
      gate.resolve({
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        permissionRequestId: pending.permissionRequestId,
        behavior: "deny",
        reason: { kind: "user_denied" },
      }),
    ).toBe(true)
    await expect(outcome).resolves.toEqual({
      kind: "deny",
      reason: { kind: "user_denied" },
    })
    expect(gate.list("session_pending")).toEqual([])
  })

  it("removes a request when its wait times out", async () => {
    const gate = createPermissionGate()
    await expect(
      gate.request({
        sessionId: "session_timeout",
        turnId: "turn_timeout",
        toolCallId: "tool_timeout",
        action: "command_execution",
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      kind: "timeout",
      reason: { kind: "timeout" },
    })
    expect(gate.list("session_timeout")).toEqual([])
  })

  it("removes a request when its Turn aborts", async () => {
    const gate = createPermissionGate()
    const abort = new AbortController()
    const outcome = gate.request({
      sessionId: "session_abort",
      turnId: "turn_abort",
      toolCallId: "tool_abort",
      action: "command_execution",
      signal: abort.signal,
      timeoutMs: 1_000,
    })
    abort.abort()

    await expect(outcome).resolves.toMatchObject({
      kind: "aborted",
      reason: { kind: "turn_aborted" },
    })
    expect(gate.list("session_abort")).toEqual([])
  })
})
