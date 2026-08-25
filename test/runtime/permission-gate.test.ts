import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createJsonlEventStore } from "../../src/kernel/jsonl-event-store.ts"
import { createSessionKernel } from "../../src/kernel/session-kernel.ts"
import { createMateKernel } from "../../src/mates/mate-kernel.ts"
import { createSqliteMateStore } from "../../src/mates/sqlite-mate-store.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { createRunnerTimingPolicy } from "../../src/runtime/limits.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import {
  createPermissionGate,
  type RuntimePermissionEvent,
} from "../../src/runtime/permission-gate.ts"
import { createSessionRunner } from "../../src/runtime/session-runner.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import {
  type CommandLaunchResult,
  createRunCommandTool,
} from "../../src/runtime/tools/run-command.ts"

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
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ kind: "allow" })
    expect(gate.list("session_sync")).toEqual([])
    expect(events.map((event) => event.type)).toEqual([
      "permission.requested",
      "permission.resolved",
    ])
  })

  it("keeps pending approval in active runtime and launches only after allow", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const events: RuntimePermissionEvent[] = []
      const gate = createPermissionGate({
        publish: (event) => events.push(event),
      })
      const runner = createCommandRunner(runtime, gate, async () => {
        launches += 1
        return successfulLaunch()
      })
      const session = await admitCommand(runtime)

      const wake = runner.wake(session.sessionId)
      const pending = await waitForPending(gate, session.sessionId)
      expect(launches).toBe(0)
      expect(events[0]).toMatchObject({
        type: "permission.requested",
        permissionRequestId: pending.permissionRequestId,
        action: "command_execution",
        subject: "echo hi",
      })

      expect(
        gate.resolve({
          sessionId: session.sessionId,
          turnId: pending.turnId,
          permissionRequestId: pending.permissionRequestId,
          behavior: "allow",
        }),
      ).toBe(true)
      await wake

      expect(launches).toBe(1)
      expect(gate.list(session.sessionId)).toEqual([])
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]?.state).toBe("completed")
      const history = await runtime.kernel.readEvents({
        sessionId: session.sessionId,
      })
      expect(history.events.map((event) => event.type)).not.toContain(
        "permission.requested",
      )
    })
  })

  it("records denial as the tool result without persisting an approval fact", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const gate = createPermissionGate()
      const runner = createCommandRunner(runtime, gate, async () => {
        launches += 1
        return successfulLaunch()
      })
      const session = await admitCommand(runtime)

      const wake = runner.wake(session.sessionId)
      const pending = await waitForPending(gate, session.sessionId)
      gate.resolve({
        sessionId: session.sessionId,
        turnId: pending.turnId,
        permissionRequestId: pending.permissionRequestId,
        behavior: "deny",
        reason: { kind: "user_denied", message: "nope" },
      })
      await wake

      expect(launches).toBe(0)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]).toMatchObject({
        state: "failed",
        error: { code: "permission_denied", message: "nope" },
      })
      const history = await runtime.kernel.readEvents({
        sessionId: session.sessionId,
      })
      expect(history.events.map((event) => event.type)).not.toContain(
        "permission.resolved",
      )
    })
  })

  it("removes the waiter on timeout and records the failed tool result", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const gate = createPermissionGate()
      const runner = createCommandRunner(
        runtime,
        gate,
        async () => {
          launches += 1
          return successfulLaunch()
        },
        10,
      )
      const session = await admitCommand(runtime)

      await runner.wake(session.sessionId)

      expect(launches).toBe(0)
      expect(gate.list(session.sessionId)).toEqual([])
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]).toMatchObject({
        state: "failed",
        error: { code: "permission_timeout" },
      })
    })
  })

  it("drops the waiter when its active Turn is interrupted", async () => {
    await withPermissionRuntime(async (runtime) => {
      const gate = createPermissionGate()
      const runner = createCommandRunner(runtime, gate, async () =>
        successfulLaunch(),
      )
      const session = await admitCommand(runtime)
      const wake = runner.wake(session.sessionId)
      const pending = await waitForPending(gate, session.sessionId)

      await runner.interrupt({
        sessionId: session.sessionId,
        turnId: pending.turnId,
        reason: "test interrupt",
      })
      await wake

      expect(gate.list(session.sessionId)).toEqual([])
      expect(
        gate.resolve({
          sessionId: session.sessionId,
          turnId: pending.turnId,
          permissionRequestId: pending.permissionRequestId,
          behavior: "allow",
        }),
      ).toBe(false)
    })
  })
})

function createCommandRunner(
  runtime: Runtime,
  permissionGate: ReturnType<typeof createPermissionGate>,
  launch: () => Promise<CommandLaunchResult>,
  permissionWaitTimeoutMs = 60_000,
) {
  const provider = createFauxProvider([
    {
      stopReason: ModelStopReason.ToolUse,
      content: [
        {
          type: "tool_call",
          id: "tool_cmd",
          name: "run_command",
          input: { command: "echo hi" },
        },
      ],
    },
    { content: [{ type: "text", text: "done" }] },
  ])
  return createSessionRunner({
    approvalPolicy: "auto_file_tools",
    kernel: runtime.kernel,
    mateKernel: runtime.mateKernel,
    stream: provider.stream,
    permissionGate,
    runtimeTiming: createRunnerTimingPolicy({ permissionWaitTimeoutMs }),
    toolRegistry: createToolRegistry([createRunCommandTool({ launch })]),
  })
}

async function admitCommand(runtime: Runtime) {
  const mate = await runtime.mateKernel.createMate({
    instructions: "Ask before shell.",
    name: "PermMate",
    role: "Assistant",
  })
  const session = await runtime.kernel.createSession({
    workingDirectory: runtime.workspace,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
  await runtime.kernel.admitInput({
    sessionId: session.sessionId,
    content: { kind: "text", text: "run" },
  })
  return session
}

async function waitForPending(
  gate: ReturnType<typeof createPermissionGate>,
  sessionId: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = gate.list(sessionId)[0]
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Permission was not requested.")
}

function successfulLaunch(): CommandLaunchResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    truncated: false,
    timedOut: false,
  }
}

type Runtime = {
  readonly kernel: ReturnType<typeof createSessionKernel>
  readonly mateKernel: ReturnType<typeof createMateKernel>
  readonly workspace: string
}

async function withPermissionRuntime(run: (runtime: Runtime) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-perm-"))
  const workspace = await mkdtemp(join(tmpdir(), "yakitori-perm-ws-"))
  const eventStore = createJsonlEventStore({
    sessionsDir: join(rootDir, "sessions"),
  })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "mates.sqlite"),
  })
  try {
    await run({
      kernel: createSessionKernel(eventStore),
      mateKernel: createMateKernel(mateStore),
      workspace,
    })
  } finally {
    await mateStore.close()
    await eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}
