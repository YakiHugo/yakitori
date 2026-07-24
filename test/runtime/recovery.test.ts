import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  acquireRuntimeLock,
  createMateKernel,
  createSessionKernel,
  createSqliteEventStore,
  createSqliteMateStore,
  discoverRecoveryState,
  EventType,
  reconcileSessionHistory,
  recoverSessions,
  scheduleRecoveryExecution,
} from "../../src/index.ts"

describe("runtime recovery", () => {
  it("records an honest interrupted Turn and is idempotent", async () => {
    await withStore(async (runtime) => {
      const session = await createAttributedSession(runtime)
      const admitted = await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "in flight" },
      })
      await runtime.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
        executionContext: {
          mateId: session.mateId,
          mateRevisionId: session.mateRevisionId,
          provider: "faux",
          model: "scripted",
          workingDirectory: runtime.workspace,
          enabledTools: [],
          approvalPolicy: "auto_file_tools",
          limits: {
            modelCallsPerTurn: 16,
            toolCallsPerTurn: 32,
            modelVisibleMessageBlocks: 200,
            modelVisibleContextBytes: 256_000,
            modelVisibleToolResultBytes: 50_000,
            modelVisibleToolResultLines: 2_000,
            assistantResponseBytes: 256_000,
          },
        },
      })

      const first = await recoverSessions({ kernel: runtime.kernel })
      expect(first.recoveredSessionIds).toEqual([session.sessionId])
      expect(
        first.events.some((event) => event.type === EventType.TurnInterrupted),
      ).toBe(true)

      const second = await recoverSessions({ kernel: runtime.kernel })
      expect(second.recoveredSessionIds).toEqual([])
      expect(second.events).toEqual([])

      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.activeTurn).toBeUndefined()
      expect(read.session?.interruptedTurns[0]).toMatchObject({
        interruptedReason:
          "Runtime stopped before the Turn reached a recorded boundary.",
      })
    })
  })

  it("wakes sessions that only have admitted Inputs", async () => {
    await withStore(async (runtime) => {
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "pending" },
      })
      const woken: string[] = []
      const result = await recoverSessions({
        kernel: runtime.kernel,
        wake: async (sessionId) => {
          woken.push(sessionId)
        },
      })
      expect(result.wokenSessionIds).toEqual([session.sessionId])
      expect(woken).toEqual([session.sessionId])
    })
  })

  it("keeps history reconciliation, state discovery, and execution scheduling separate", async () => {
    await withStore(async (runtime) => {
      const session = await createAttributedSession(runtime)
      await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "pending" },
      })

      expect(await reconcileSessionHistory({ kernel: runtime.kernel })).toEqual(
        { recoveredSessionIds: [], events: [] },
      )
      const state = await discoverRecoveryState({ kernel: runtime.kernel })
      expect(state.pendingInputSessionIds).toEqual([session.sessionId])

      let release: (() => void) | undefined
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const woken = scheduleRecoveryExecution({
        sessionIds: state.pendingInputSessionIds,
        wake: () => blocked,
      })
      expect(woken).toEqual([session.sessionId])
      release?.()
    })
  })

  it("treats a concurrent terminal Turn as a valid recovery outcome", async () => {
    await withStore(async (runtime) => {
      const session = await createAttributedSession(runtime)
      const admitted = await runtime.kernel.admitInput({
        sessionId: session.sessionId,
        content: { kind: "text", text: "racing" },
      })
      const turn = await runtime.kernel.startTurn({
        sessionId: session.sessionId,
        inputId: admitted.inputId,
      })
      const kernel = {
        ...runtime.kernel,
        interruptTurn: async (
          input: Parameters<typeof runtime.kernel.interruptTurn>[0],
        ) => {
          await runtime.kernel.completeTurn({
            sessionId: input.sessionId,
            turnId: input.turnId,
          })
          return runtime.kernel.interruptTurn(input)
        },
      }

      await expect(reconcileSessionHistory({ kernel })).resolves.toEqual({
        recoveredSessionIds: [],
        events: [],
      })
      const read = await runtime.kernel.readSession({
        sessionId: session.sessionId,
      })
      expect(read.session?.completedTurns[0]?.turnId).toBe(turn.turnId)
    })
  })

  it("uses immutable pagination while reconciliation writes interruption facts", async () => {
    await withStore(async (runtime) => {
      const sessionIds: string[] = []
      for (let index = 0; index < 101; index += 1) {
        const session = await createAttributedSession(runtime)
        sessionIds.push(session.sessionId)
        const admitted = await runtime.kernel.admitInput({
          sessionId: session.sessionId,
          content: { kind: "text", text: `active ${index}` },
        })
        await runtime.kernel.startTurn({
          sessionId: session.sessionId,
          inputId: admitted.inputId,
        })
      }

      const recovered = await reconcileSessionHistory({
        kernel: runtime.kernel,
      })
      expect(new Set(recovered.recoveredSessionIds)).toEqual(
        new Set(sessionIds),
      )
      expect(recovered.events).toHaveLength(101)
    })
  })

  it("acquires an exclusive runtime lock and reclaims a stale one", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-lock-"))
    try {
      const first = await acquireRuntimeLock(rootDir, { pid: 1111 })
      await expect(
        acquireRuntimeLock(rootDir, {
          pid: 2222,
          isProcessAlive: () => true,
        }),
      ).rejects.toThrow("Runtime lock is held by live process 1111")

      const reclaimed = await acquireRuntimeLock(rootDir, {
        pid: 3333,
        isProcessAlive: (pid) => pid !== 1111,
      })
      expect(reclaimed.ownerPid).toBe(3333)
      await reclaimed.release()
      await first.release()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("never reclaims an incomplete lock that may still be initializing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-lock-incomplete-"))
    try {
      await writeFile(join(rootDir, "runtime.lock"), "")
      await expect(
        acquireRuntimeLock(rootDir, {
          pid: 2222,
          isProcessAlive: () => false,
        }),
      ).rejects.toThrow("incomplete or invalid")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

type StoreRuntime = {
  readonly kernel: ReturnType<typeof createSessionKernel>
  readonly mateKernel: ReturnType<typeof createMateKernel>
  readonly workspace: string
}

async function createAttributedSession(runtime: StoreRuntime) {
  const mate = await runtime.mateKernel.createMate({
    instructions: "recover",
    name: "RecoverMate",
    role: "Assistant",
  })
  const session = await runtime.kernel.createSession({
    workingDirectory: runtime.workspace,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  })
  return {
    sessionId: session.sessionId,
    mateId: mate.mate.id,
    mateRevisionId: mate.mate.currentRevision.id,
  }
}

async function withStore(run: (runtime: StoreRuntime) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-recovery-"))
  const workspace = await mkdtemp(join(tmpdir(), "yakitori-recovery-ws-"))
  const eventStore = createSqliteEventStore({ rootDir })
  const mateStore = createSqliteMateStore({
    databasePath: join(rootDir, "events.sqlite"),
  })
  try {
    await run({
      kernel: createSessionKernel(eventStore),
      mateKernel: createMateKernel(mateStore),
      workspace,
    })
  } finally {
    mateStore.close()
    eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}
