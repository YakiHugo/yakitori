import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ApiErrorCode,
  createFauxProvider,
  createMateKernel,
  createSqliteMateStore,
  createYakitoriApplication,
  MateLifecycle,
  resolveWorkspaceDirectory,
  type ApiHandlerResult,
} from "../../src/index.ts"

function testApplicationOptions(input: {
  readonly rootDir: string
  readonly workspace: string
  readonly activeMateId?: string
}) {
  return {
    ...input,
    acquireLock: false,
    recoverOnStart: false,
    stream: createFauxProvider([]).stream,
  }
}

describe("application composition", () => {
  it("creates one default Mate only once across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const firstMateId = first.activeMate.mateId
      const firstRevisionId = first.activeMate.mateRevisionId
      await first.close()

      const second = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(second.activeMate.mateId).toBe(firstMateId)
        expect(second.activeMate.mateRevisionId).toBe(firstRevisionId)

        const listed = await second.mateKernel.listMates()
        expect(listed.mates).toHaveLength(1)
        expect(listed.mates[0]?.id).toBe(firstMateId)
      } finally {
        await second.close()
      }
    })
  })

  it("selects an explicitly configured active Mate and pins its revision", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "events.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      const created = await mateKernel.createMate({
        instructions: "Prefer explicit tests.",
        name: "Configured",
        role: "Builder",
      })
      mateStore.close()

      const application = await createYakitoriApplication(
        testApplicationOptions({
          activeMateId: created.mate.id,
          rootDir,
          workspace,
        }),
      )
      try {
        expect(application.activeMate).toEqual({
          mateId: created.mate.id,
          mateRevisionId: created.mate.currentRevision.id,
          name: "Configured",
          revision: 1,
        })

        const createdSession = await application.handlers.createSession({
          title: "Pinned",
        })
        expectOk(createdSession)
        expect(createdSession.body.session).toMatchObject({
          title: "Pinned",
          workingDirectory: application.workspace,
          mateId: created.mate.id,
          mateRevisionId: created.mate.currentRevision.id,
        })
      } finally {
        await application.close()
      }
    })
  })

  it("fails startup when the configured Mate is missing or inactive", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        createYakitoriApplication(
          testApplicationOptions({
            activeMateId: "mate_00000000-0000-4000-8000-000000000000",
            rootDir,
            workspace,
          }),
        ),
      ).rejects.toThrow("Configured Mate was not found")

      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "events.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      const created = await mateKernel.createMate({
        instructions: "inactive later",
        name: "SoonInactive",
        role: "Builder",
      })
      await mateKernel.setMateLifecycle({
        mateId: created.mate.id,
        lifecycle: MateLifecycle.Inactive,
      })
      mateStore.close()

      await expect(
        createYakitoriApplication(
          testApplicationOptions({
            activeMateId: created.mate.id,
            rootDir,
            workspace,
          }),
        ),
      ).rejects.toThrow("Configured Mate is inactive")
    })
  })

  it("fails startup when multiple active Mates exist without an explicit selection", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "events.sqlite"),
      })
      const mateKernel = createMateKernel(mateStore)
      await mateKernel.createMate({
        instructions: "one",
        name: "One",
        role: "Builder",
      })
      await mateKernel.createMate({
        instructions: "two",
        name: "Two",
        role: "Reviewer",
      })
      mateStore.close()

      await expect(
        createYakitoriApplication(
          testApplicationOptions({ rootDir, workspace }),
        ),
      ).rejects.toThrow("Multiple active Mates found")
    })
  })

  it("rejects a missing path, a file, and a conflicting per-request workspace", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        resolveWorkspaceDirectory(join(rootDir, "missing-workspace")),
      ).rejects.toThrow("Workspace path does not exist")

      const filePath = join(rootDir, "not-a-directory.txt")
      await writeFile(filePath, "nope")
      await expect(resolveWorkspaceDirectory(filePath)).rejects.toThrow(
        "Workspace path is not a directory",
      )

      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        const rejected = await application.handlers.createSession({
          workingDirectory: rootDir,
        })
        expectError(rejected, 400, ApiErrorCode.InvalidInput)
        expect(rejected.body.error.message).toContain(
          "workingDirectory must match the configured workspace",
        )

        const accepted = await application.handlers.createSession({
          workingDirectory: workspace,
          title: "Same workspace",
        })
        expectOk(accepted)
        expect(accepted.body.session.workingDirectory).toBe(
          application.workspace,
        )
        expect(accepted.body.session.mateId).toBe(application.activeMate.mateId)
        expect(accepted.body.session.mateRevisionId).toBe(
          application.activeMate.mateRevisionId,
        )
      } finally {
        await application.close()
      }
    })
  })

  it("pins an injected provider and model into the Turn execution context", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "configured" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        acquireLock: false,
        recoverOnStart: false,
        stream: provider.stream,
        provider: "openai",
        model: "gpt-test",
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_provider_config",
          content: { kind: "text", text: "hello" },
        })
        expectOk(admitted)
        await application.runner.wake(created.body.session.id)

        const read = await application.sessionKernel.readSession({
          sessionId: created.body.session.id,
        })
        expect(read.session?.completedTurns[0]?.executionContext).toMatchObject(
          {
            provider: "openai",
            model: "gpt-test",
          },
        )
      } finally {
        await application.close()
      }
    })
  })

  it("reuses the default faux scenario across sequential Inputs", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        acquireLock: false,
        recoverOnStart: false,
        provider: "faux",
        fauxScenario: "text",
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        for (const [requestId, text] of [
          ["request_first", "first"],
          ["request_second", "second"],
        ] as const) {
          const admitted = await application.handlers.admitInput({
            sessionId: created.body.session.id,
            requestId,
            content: { kind: "text", text },
          })
          expectOk(admitted)
          await application.runner.wake(created.body.session.id)
        }

        const read = await application.sessionKernel.readSession({
          sessionId: created.body.session.id,
        })
        expect(read.session?.completedTurns).toHaveLength(2)
        expect(read.session?.failedTurns).toEqual([])
      } finally {
        await application.close()
      }
    })
  })

  it("returns from startup after scheduling recovered pending work", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const created = await first.handlers.createSession()
      expectOk(created)
      await first.sessionKernel.admitInput({
        sessionId: created.body.session.id,
        content: { kind: "text", text: "resume after restart" },
      })
      await first.close()

      const provider = createFauxProvider([{ waitForAbort: true }])
      const started = await Promise.race([
        createYakitoriApplication({
          rootDir,
          workspace,
          acquireLock: false,
          stream: provider.stream,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("startup waited for execution")),
            250,
          )
        }),
      ])
      try {
        expect(started).toBeDefined()
      } finally {
        await started.close()
      }
    })
  })
})

async function withApplicationRoot(
  run: (rootDir: string, workspace: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-app-"))
  const workspace = await mkdtemp(join(tmpdir(), "yakitori-workspace-"))
  try {
    await run(rootDir, workspace)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}

function expectOk<T>(
  result: ApiHandlerResult<T>,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: true }> {
  if (!result.ok) throw new Error(`Expected success: ${result.body.error.code}`)
}

function expectError<T>(
  result: ApiHandlerResult<T>,
  status: number,
  code: ApiErrorCode,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: false }> {
  if (result.ok) throw new Error("Expected error response.")
  expect(result.status).toBe(status)
  expect(result.body.error.code).toBe(code)
}
