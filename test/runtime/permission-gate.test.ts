import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PermissionBehavior } from "../../src/kernel/events.ts"
import { createJsonlEventStore } from "../../src/kernel/jsonl-event-store.ts"
import { createSessionKernel } from "../../src/kernel/session-kernel.ts"
import { createMateKernel } from "../../src/mates/mate-kernel.ts"
import { createSqliteMateStore } from "../../src/mates/sqlite-mate-store.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { createRunnerTimingPolicy } from "../../src/runtime/limits.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"
import { createSessionRunner } from "../../src/runtime/session-runner.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import {
  type CommandLaunchResult,
  createRunCommandTool,
} from "../../src/runtime/tools/run-command.ts"

describe("permission gate", () => {
  it("does not start a process before durable allow", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const launch = async (): Promise<CommandLaunchResult> => {
        launches += 1
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          truncated: false,
          timedOut: false,
        }
      }
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
      const gate = createPermissionGate()
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        permissionGate: gate,
        toolRegistry: createToolRegistry([permissionCommandTool({ launch })]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "run" },
      })

      const wake = runner.wake(session.sessionId)
      const permissionRequestId = await waitForPermission(
        runtime.kernel,
        session.sessionId,
      )
      expect(launches).toBe(0)

      const activeTurnId = (
        await runtime.kernel.readSession({ sessionId: session.sessionId })
      ).session?.activeTurn?.turnId
      if (activeTurnId === undefined) throw new Error("missing active turn")
      await runtime.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId: activeTurnId,
        permissionRequestId,
        behavior: PermissionBehavior.Allow,
      })
      gate.notify({
        sessionId: session.sessionId,
        turnId: activeTurnId,
        permissionRequestId,
      })
      await wake

      expect(launches).toBe(1)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.tools[0]?.state).toBe("completed")
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })

  it("denial starts no process and continues the model loop", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const launch = async (): Promise<CommandLaunchResult> => {
        launches += 1
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
        }
      }
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_cmd",
              name: "run_command",
              input: { command: "echo denied" },
            },
          ],
        },
        {
          assertRequest: (request) => {
            const tool = request.messages.find(
              (message) => message.role === "tool",
            )
            expect(tool).toMatchObject({
              role: "tool",
              isError: true,
            })
          },
          content: [{ type: "text", text: "understood" }],
        },
      ])
      const gate = createPermissionGate()
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        permissionGate: gate,
        toolRegistry: createToolRegistry([permissionCommandTool({ launch })]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "run" },
      })
      const wake = runner.wake(session.sessionId)
      const permissionRequestId = await waitForPermission(
        runtime.kernel,
        session.sessionId,
      )
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      const turnId = read.session?.activeTurn?.turnId
      if (!turnId) throw new Error("missing turn")
      await runtime.kernel.resolvePermission({
        sessionId: session.sessionId,
        turnId,
        permissionRequestId,
        behavior: PermissionBehavior.Deny,
        reason: { kind: "user_denied", message: "nope" },
      })
      gate.notify({
        sessionId: session.sessionId,
        turnId,
        permissionRequestId,
      })
      await wake
      expect(launches).toBe(0)
      const final = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(final.session?.tools[0]?.state).toBe("failed")
      expect(final.session?.completedTurns).toHaveLength(1)
      expect(final.session?.permissions[0]?.behavior).toBe(
        PermissionBehavior.Deny,
      )
    })
  })

  it("durably expires a permission after the bounded wait", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_timeout",
              name: "run_command",
              input: { command: "echo too-late" },
            },
          ],
        },
        { content: [{ type: "text", text: "timed out" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        permissionGate: createPermissionGate(),
        runtimeTiming: createRunnerTimingPolicy({
          permissionWaitTimeoutMs: 20,
        }),
        toolRegistry: createToolRegistry([
          permissionCommandTool({
            launch: async () => {
              launches += 1
              return {
                exitCode: 0,
                signal: null,
                stdout: "",
                stderr: "",
                truncated: false,
                timedOut: false,
              }
            },
          }),
        ]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "run" },
      })

      await runner.wake(session.sessionId)

      expect(launches).toBe(0)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.permissions[0]).toMatchObject({
        behavior: PermissionBehavior.Expire,
        decisionReason: {
          kind: "timeout",
          message: "Permission wait timed out.",
        },
      })
      expect(read.session?.tools[0]?.state).toBe("failed")
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })

  it("honors an allow that wins the permission timeout race", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_race",
              name: "run_command",
              input: { command: "echo allowed" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ])
      const kernel = {
        ...runtime.kernel,
        resolvePermission: async (
          input: Parameters<typeof runtime.kernel.resolvePermission>[0],
        ) => {
          if (input.behavior !== PermissionBehavior.Expire) {
            return runtime.kernel.resolvePermission(input)
          }
          await runtime.kernel.resolvePermission({
            ...input,
            behavior: PermissionBehavior.Allow,
            reason: { kind: "user_allowed" },
          })
          return runtime.kernel.resolvePermission(input)
        },
      }
      const runner = createSessionRunner({
        kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        permissionGate: {
          notify() {},
          async wait() {
            return "timeout"
          },
        },
        toolRegistry: createToolRegistry([
          permissionCommandTool({
            launch: async () => {
              launches += 1
              return {
                exitCode: 0,
                signal: null,
                stdout: "allowed",
                stderr: "",
                truncated: false,
                timedOut: false,
              }
            },
          }),
        ]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "run" },
      })

      await runner.wake(session.sessionId)

      expect(launches).toBe(1)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.permissions[0]?.behavior).toBe(
        PermissionBehavior.Allow,
      )
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })

  it("never consults the permission gate for production run_command", async () => {
    await withPermissionRuntime(async (runtime) => {
      let waits = 0
      let launches = 0
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_yolo",
              name: "run_command",
              input: { command: "git status" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        permissionGate: {
          notify() {},
          async wait() {
            waits += 1
            return "timeout"
          },
        },
        toolRegistry: createToolRegistry([
          createRunCommandTool({
            launch: async () => {
              launches += 1
              return {
                exitCode: 0,
                signal: null,
                stdout: "clean",
                stderr: "",
                truncated: false,
                timedOut: false,
              }
            },
          }),
        ]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "status" },
      })

      await runner.wake(session.sessionId)

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(launches).toBe(1)
      expect(waits).toBe(0)
      expect(read.session?.permissions).toEqual([])
      expect(read.session?.tools[0]?.state).toBe("completed")
    })
  })

  it("skips the permission request when the approval policy is never", async () => {
    await withPermissionRuntime(async (runtime) => {
      let launches = 0
      const provider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_never",
              name: "run_command",
              input: { command: "echo never" },
            },
          ],
        },
        { content: [{ type: "text", text: "done" }] },
      ])
      const runner = createSessionRunner({
        kernel: runtime.kernel,
        mateKernel: runtime.mateKernel,
        stream: provider.stream,
        approvalPolicy: "never",
        toolRegistry: createToolRegistry([
          permissionCommandTool({
            launch: async () => {
              launches += 1
              return {
                exitCode: 0,
                signal: null,
                stdout: "never",
                stderr: "",
                truncated: false,
                timedOut: false,
              }
            },
          }),
        ]),
      })
      const session = await createSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "run" },
      })

      await runner.wake(session.sessionId)

      expect(launches).toBe(1)
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.permissions).toEqual([])
      expect(read.session?.tools[0]?.state).toBe("completed")
      expect(read.session?.completedTurns).toHaveLength(1)
    })
  })
})

function permissionCommandTool(
  input: Parameters<typeof createRunCommandTool>[0],
) {
  return { ...createRunCommandTool(input), autoAllow: false }
}

async function waitForPermission(
  kernel: ReturnType<typeof createSessionKernel>,
  sessionId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = await kernel.readSession({ sessionId })
    const permission = read.session?.permissions.find(
      (candidate) => candidate.state === "pending",
    )
    if (permission) return permission.permissionRequestId
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Permission was not requested.")
}

type Runtime = {
  readonly kernel: ReturnType<typeof createSessionKernel>
  readonly mateKernel: ReturnType<typeof createMateKernel>
  readonly workspace: string
}

async function createSession(runtime: Runtime) {
  const mate = await runtime.mateKernel.createMate({
    instructions: "Ask before shell.",
    name: "PermMate",
    role: "Assistant",
  })
  return runtime.kernel.createSession({
    workingDirectory: runtime.workspace,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
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
    mateStore.close()
    await eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}
