import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ApiErrorCode,
  createFauxProvider,
  createMateKernel,
  createSqliteMateStore,
  createYakitoriApplication,
  listen,
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
    recoverOnStart: false,
    stream: createFauxProvider([]).stream,
  }
}

describe("application composition", () => {
  it("binds the runtime lock to the canonical Session store", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const secondRoot = await mkdtemp(join(tmpdir(), "yakitori-app-second-"))
      const sessionStoreRoot = join(rootDir, "shared-sessions")
      const first = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        sessionStoreRoot,
      })
      try {
        await expect(
          createYakitoriApplication({
            ...testApplicationOptions({
              rootDir: secondRoot,
              workspace,
            }),
            sessionStoreRoot,
          }),
        ).rejects.toThrow("Runtime lock is held by live process")
      } finally {
        await first.close()
        await rm(secondRoot, { recursive: true, force: true })
      }
    })
  })

  it("releases the Session lock when Mate storage construction fails", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const invalidDatabasePath = join(rootDir, "mate-database-directory")
      await mkdir(invalidDatabasePath)
      await expect(
        createYakitoriApplication({
          ...testApplicationOptions({ rootDir, workspace }),
          mateDatabasePath: invalidDatabasePath,
        }),
      ).rejects.toThrow()
      await rm(invalidDatabasePath, { recursive: true })

      const retried = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      await retried.close()
    })
  })

  it("creates one default Mate only once across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const firstMateId = first.activeMate.mateId
      const firstRevisionId = first.activeMate.mateRevisionId
      expect(first.sessionStoreRoot).toBe(
        await realpath(join(rootDir, "sessions")),
      )
      expect(first.mateDatabasePath).toBe(join(rootDir, "mates.sqlite"))
      await Promise.all([first.close(), first.close()])

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

  it("keeps legacy Mate identity in events.sqlite when no Mate DB exists", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const legacyPath = join(rootDir, "events.sqlite")
      const mateStore = createSqliteMateStore({ databasePath: legacyPath })
      const created = await createMateKernel(mateStore).createMate({
        instructions: "Preserve this identity.",
        name: "Legacy",
        role: "Builder",
      })
      mateStore.close()

      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(application.mateDatabasePath).toBe(legacyPath)
        expect(application.activeMate.mateId).toBe(created.mate.id)
        expect((await application.mateKernel.listMates()).mates).toHaveLength(1)
      } finally {
        await application.close()
      }
    })
  })

  it("selects an explicitly configured active Mate and pins its revision", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const mateStore = createSqliteMateStore({
        databasePath: join(rootDir, "mates.sqlite"),
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
        databasePath: join(rootDir, "mates.sqlite"),
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
        databasePath: join(rootDir, "mates.sqlite"),
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

  it("serves the built GUI when guiStaticDir is configured", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const guiStaticDir = join(rootDir, "gui")
      await mkdir(guiStaticDir)
      await writeFile(
        join(guiStaticDir, "index.html"),
        "<!doctype html><html><body>yakitori gui</body></html>",
      )
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        guiStaticDir,
      })
      const server = application.createHttpServer()

      try {
        const baseUrl = await listen(server)

        const index = await fetch(`${baseUrl}/`)
        expect(index.status).toBe(200)
        expect(index.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        )
        expect(await index.text()).toContain("yakitori gui")

        const fallback = await fetch(`${baseUrl}/client-side-route`)
        expect(fallback.status).toBe(200)
        expect(await fallback.text()).toContain("yakitori gui")

        const apiNotFound = await fetch(`${baseUrl}/sessions/unknown/extra`)
        expect(apiNotFound.status).toBe(404)
        expect(apiNotFound.headers.get("content-type")).toContain(
          "application/json",
        )
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
          server.closeAllConnections()
        })
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
