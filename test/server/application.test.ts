import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import type { Server as HttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EventType } from "../../src/kernel/events.ts"
import { InputState } from "../../src/kernel/session-states.ts"
import { MateLifecycle } from "../../src/mates/events.ts"
import { createMateKernel } from "../../src/mates/mate-kernel.ts"
import { createSqliteMateStore } from "../../src/mates/sqlite-mate-store.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { type ModelRequest, ModelStopReason } from "../../src/runtime/model.ts"
import { listCatalogModels } from "../../src/runtime/model-catalog.ts"
import {
  createYakitoriApplication,
  resolveWorkspaceDirectory,
} from "../../src/server/application.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  type ApiListProvidersResponse,
} from "../../src/server/protocol.ts"
import { testTurnExecutionContext } from "../kernel/turn-context.ts"

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on a TCP address.")
  }
  return `http://${address.address}:${address.port}`
}

function testApplicationOptions(input: {
  readonly rootDir: string
  readonly workspace: string
  readonly activeMateId?: string
}) {
  return {
    ...input,
    recoverOnStart: false,
    stream: createFauxProvider([]).stream,
    userConfigPath: join(input.rootDir, "config.toml"),
    modelDirectory: {
      listModels: async (provider: string) =>
        listCatalogModels(provider).map((model) => ({
          id: model.model,
          displayName: model.displayName ?? model.model,
          instructionProfileId: model.instructionProfileId,
          ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
          ...(model.speeds === undefined ? {} : { speeds: model.speeds }),
        })),
    },
  }
}

describe("application composition", () => {
  it("stores admitted images beside the Session and hydrates model requests", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      let captured: ModelRequest | undefined
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: async function* (request) {
          captured = request
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.EndTurn,
              content: [{ type: "text", text: "seen" }],
            },
          }
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const created = await application.handlers.createSession({})
        expectOk(created)
        const sessionId = created.body.session.id
        const admitted = await application.handlers.admitInput({
          sessionId,
          requestId: "request_image",
          content: {
            kind: "text",
            text: "inspect",
            attachments: [
              {
                name: "screen.png",
                mediaType: "image/png",
                data: Buffer.from("image-bytes").toString("base64"),
                sizeBytes: 11,
              },
            ],
          },
        })
        expectOk(admitted)
        await application.runner.wake(sessionId)

        expect(admitted.body.event).toMatchObject({
          data: {
            content: {
              attachments: [
                {
                  detail: "high",
                  file: {
                    sessionId,
                    path: "attachments/request_image/1.png",
                  },
                },
              ],
            },
          },
        })
        expect(JSON.stringify(admitted.body.event)).not.toContain(
          Buffer.from("image-bytes").toString("base64"),
        )
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              sessionId,
              "files",
              "attachments",
              "request_image",
              "1.png",
            ),
            "utf8",
          ),
        ).toBe("image-bytes")
        expect(captured?.messages).toContainEqual({
          role: "user",
          content: [{ type: "text", text: "inspect" }],
          images: [
            {
              type: "image",
              mediaType: "image/png",
              detail: "high",
              data: Buffer.from("image-bytes").toString("base64"),
            },
          ],
        })

        const image = await fetch(
          `${baseUrl}/sessions/${sessionId}/files/attachments/request_image/1.png`,
        )
        expect(image.status).toBe(200)
        expect(image.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await image.arrayBuffer()).toString()).toBe(
          "image-bytes",
        )
        const logRoute = await fetch(
          `${baseUrl}/sessions/${sessionId}/files/tools/call_1/stdout.log`,
        )
        expect(logRoute.status).toBe(404)

        const rejectedFork = await application.handlers.forkSession({
          sessionId,
          atInputId: admitted.body.inputId,
          reason: "edit",
          content: {
            kind: "text",
            text: "changed",
            attachments: [
              {
                name: "screen.png",
                mediaType: "image/png",
                data: Buffer.from("image-bytes").toString("base64"),
                sizeBytes: 11,
              },
            ],
          },
        })
        expect(rejectedFork).toMatchObject({
          status: 400,
          body: { error: { code: ApiErrorCode.InvalidInput } },
        })
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  })

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

  it("rejects a missing path, a file, and a nonexistent per-request working directory", async () => {
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
          workingDirectory: join(rootDir, "missing-dir"),
        })
        expectError(rejected, 400, ApiErrorCode.InvalidInput)
        expect(rejected.body.error.message).toContain(
          "workingDirectory must be an existing directory",
        )

        const other = join(rootDir, "other-project")
        await mkdir(other)
        const accepted = await application.handlers.createSession({
          workingDirectory: other,
          title: "Other project",
        })
        expectOk(accepted)
        expect(accepted.body.session.workingDirectory).toBe(
          await realpath(other),
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
        userConfigPath: join(rootDir, "config.toml"),
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

  it("does not let an optional provider stream bypass primary credentials", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await withApplicationRoot(async (rootDir, workspace) => {
        const injected = createFauxProvider([])
        await expect(
          createYakitoriApplication({
            rootDir,
            workspace,
            recoverOnStart: false,
            provider: "anthropic",
            model: "claude-test",
            providerStreams: { anthropic: injected.stream },
          }),
        ).rejects.toThrow(
          "ANTHROPIC_API_KEY is required when YAKITORI_PROVIDER=anthropic.",
        )
      })
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

  it("rejects object prototype keys as unknown providers", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      await expect(
        createYakitoriApplication({
          rootDir,
          workspace,
          recoverOnStart: false,
          provider: "constructor",
          model: "unexpected",
        }),
      ).rejects.toThrow('Provider "constructor" is not configured.')
    })
  })

  it("routes an admitted next-Turn selection through another registered provider", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const primary = createFauxProvider([
        { content: [{ type: "text", text: "unused" }] },
      ])
      const selected = createFauxProvider([
        { content: [{ type: "text", text: "selected provider" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        recoverOnStart: false,
        stream: primary.stream,
        provider: "faux",
        model: "scripted",
        providerStreams: { openai: selected.stream },
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_switch_provider",
          content: { kind: "text", text: "switch" },
          modelSelection: { provider: "openai", model: "gpt-5.6-sol" },
        })
        expectOk(admitted)
        await application.runner.wake(created.body.session.id)

        expect(primary.callCount).toBe(0)
        expect(selected.callCount).toBe(1)
        expect(selected.requests[0]?.target).toEqual({
          provider: "openai",
          model: "gpt-5.6-sol",
          instructionProfileId: "default",
        })
      } finally {
        await application.close()
      }
    })
  })

  it("registers the lazy Grok CLI provider when another provider is primary", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const previousApiKey = process.env.XAI_API_KEY
      const previousCredentials = process.env.GROK_CREDENTIALS
      delete process.env.XAI_API_KEY
      process.env.GROK_CREDENTIALS = join(rootDir, "missing-grok-auth.json")
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
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_switch_grok_oidc",
          content: { kind: "text", text: "use grok" },
          modelSelection: { provider: "grok", model: "grok-4.5" },
        })
        expectOk(admitted)
        await application.runner.wake(created.body.session.id)

        const read = await application.sessionKernel.readSession({
          sessionId: created.body.session.id,
        })
        expect(read.session?.failedTurns[0]?.executionContext).toMatchObject({
          provider: "grok",
          model: "grok-4.5",
        })
        expect(read.session?.failedTurns[0]?.error?.message).toContain(
          "Grok credentials not found",
        )
      } finally {
        await application.close()
        if (previousApiKey === undefined) delete process.env.XAI_API_KEY
        else process.env.XAI_API_KEY = previousApiKey
        if (previousCredentials === undefined)
          delete process.env.GROK_CREDENTIALS
        else process.env.GROK_CREDENTIALS = previousCredentials
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

  it("forks, edits, and drives a Turn without touching the source Session", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "first reply" }] },
        { content: [{ type: "text", text: "abandoned reply" }] },
        { content: [{ type: "text", text: "replacement reply" }] },
      ])
      const forkModelSelection = {
        provider: process.env.YAKITORI_PROVIDER ?? "faux",
        model: "fork-model",
      }
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        recoverOnStart: false,
        stream: provider.stream,
      })
      try {
        const created = await application.handlers.createSession({
          title: "Fork source",
        })
        expectOk(created)
        const first = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_fork_first",
          content: { kind: "text", text: "first" },
        })
        expectOk(first)
        await application.runner.wake(created.body.session.id)
        const second = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_fork_second",
          content: { kind: "text", text: "replace this" },
        })
        expectOk(second)
        await application.runner.wake(created.body.session.id)

        const forked = await application.handlers.forkSession({
          sessionId: created.body.session.id,
          atInputId: second.body.inputId,
          reason: "edit",
          content: { kind: "text", text: "replacement" },
          modelSelection: forkModelSelection,
        })
        expectOk(forked)
        await application.runner.wake(forked.body.session.id)

        const source = await application.sessionKernel.readSession({
          sessionId: created.body.session.id,
        })
        const target = await application.sessionKernel.readSession({
          sessionId: forked.body.session.id,
        })
        expect(source.session?.completedTurns).toHaveLength(2)
        expect(
          source.session?.inputs.map((input) => input.content.text),
        ).toEqual(["first", "replace this"])
        expect(target.session?.completedTurns).toHaveLength(2)
        expect(
          target.session?.inputs.map((input) => input.content.text),
        ).toEqual(["first", "replacement"])
        expect(target.session?.inputs.at(-1)?.parentInputId).toBe(
          second.body.inputId,
        )
        expect(target.session?.inputs.at(-1)?.modelSelection).toEqual(
          forkModelSelection,
        )
        expect(target.session).toMatchObject({
          parentSessionId: created.body.session.id,
          forkedFromInputId: second.body.inputId,
          forkReason: "edit",
          workingDirectory: application.workspace,
        })
        expect(forked.body.events.at(-1)).toMatchObject({
          sessionId: forked.body.session.id,
          type: EventType.InputAdmitted,
          data: { content: { kind: "text", text: "replacement" } },
        })
        expect(provider.callCount).toBe(3)
      } finally {
        await application.close()
      }
    })
  })

  it("cancels queued Inputs inherited by a fork", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        stream: createFauxProvider([]).stream,
      })
      try {
        const created = await application.handlers.createSession({
          title: "Fork source",
        })
        expectOk(created)
        const kernel = application.sessionKernel
        const first = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_inherited_first",
          content: { kind: "text", text: "first" },
        })
        expectOk(first)
        const turn = await kernel.startTurn({
          sessionId: created.body.session.id,
          inputId: first.body.inputId,
          executionContext: testTurnExecutionContext(),
        })
        // Admitted mid-Turn, so their admissions sit inside the Turn span.
        const earlier = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_inherited_earlier",
          content: { kind: "text", text: "earlier queued" },
        })
        expectOk(earlier)
        const later = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_inherited_later",
          content: { kind: "text", text: "later queued" },
        })
        expectOk(later)
        await kernel.completeTurn({
          sessionId: created.body.session.id,
          turnId: turn.turnId,
        })
        // The user discards both queued Inputs on the source before undoing;
        // those cancellations land after the fork boundary.
        await kernel.cancelInput({
          sessionId: created.body.session.id,
          inputId: earlier.body.inputId,
        })
        await kernel.cancelInput({
          sessionId: created.body.session.id,
          inputId: later.body.inputId,
        })

        const forked = await application.handlers.forkSession({
          sessionId: created.body.session.id,
          atInputId: later.body.inputId,
          reason: "undo",
        })
        expectOk(forked)

        const target = await kernel.readSession({
          sessionId: forked.body.session.id,
        })
        expect(target.session?.pendingInputs).toEqual([])
        const inherited = target.session?.inputs.find(
          (input) => input.content.text === "earlier queued",
        )
        expect(inherited).toMatchObject({ state: InputState.Cancelled })
        const events = await kernel.readEvents({
          sessionId: forked.body.session.id,
        })
        expect(events.events.at(-1)).toMatchObject({
          type: EventType.InputCancelled,
          data: {
            inputId: earlier.body.inputId,
            reason: "conversation_fork",
          },
        })
        expect(forked.body.events.map((event) => event.type)).toEqual([
          EventType.SessionCreated,
          EventType.TurnInterrupted,
          EventType.InputCancelled,
        ])
      } finally {
        await application.close()
      }
    })
  })

  it("serves catalog models per provider and prepends a configured default outside the catalog", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        userConfigPath: join(rootDir, "config.toml"),
        recoverOnStart: false,
        stream: createFauxProvider([]).stream,
        provider: "openai",
        model: "gpt-custom-9",
        modelDirectory: {
          async listModels(provider) {
            if (provider === "openai") {
              return [
                {
                  id: "gpt-5.1-codex",
                  displayName: "GPT-5.1 Codex",
                  instructionProfileId: "codex",
                  efforts: ["low", "medium", "high"],
                  inputModalities: ["text", "image"],
                  imageDetailModes: ["high", "original"],
                },
                {
                  id: "gpt-5",
                  displayName: "GPT-5",
                  instructionProfileId: "codex",
                },
              ]
            }
            if (provider === "grok") {
              return [
                {
                  id: "grok-code-fast-1",
                  displayName: "Grok Code Fast 1",
                  instructionProfileId: "grok",
                  efforts: ["low", "medium", "high"],
                },
              ]
            }
            return []
          },
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const response = await fetch(`${baseUrl}/providers`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as ApiListProvidersResponse

        expect(body.defaultProvider).toBe("openai")
        expect(body.defaultModel).toBe("gpt-custom-9")
        expect(body.userPreference).toBeUndefined()
        expect(
          body.providers.find((provider) => provider.name === "openai"),
        ).toEqual({
          name: "openai",
          defaultModel: "gpt-custom-9",
          models: [
            {
              id: "gpt-custom-9",
              displayName: "gpt-custom-9",
              instructionProfileId: "default",
            },
            {
              id: "gpt-5.1-codex",
              displayName: "GPT-5.1 Codex",
              instructionProfileId: "codex",
              efforts: ["low", "medium", "high"],
              inputModalities: ["text", "image"],
              imageDetailModes: ["high", "original"],
            },
            {
              id: "gpt-5",
              displayName: "GPT-5",
              instructionProfileId: "codex",
            },
          ],
        })
        expect(
          body.providers.find((provider) => provider.name === "grok"),
        ).toEqual({
          name: "grok",
          models: [
            {
              id: "grok-code-fast-1",
              displayName: "Grok Code Fast 1",
              instructionProfileId: "grok",
              efforts: ["low", "medium", "high"],
            },
          ],
        })
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

  it("persists the user preference outside Session storage across restarts", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const userConfigPath = join(rootDir, "user-home", "config.toml")
      const options = {
        ...testApplicationOptions({ rootDir, workspace }),
        userConfigPath,
        modelDirectory: {
          async listModels() {
            return []
          },
        },
      }
      const first = await createYakitoriApplication(options)
      const firstServer = first.createHttpServer()
      try {
        const baseUrl = await listen(firstServer)
        const updated = await fetch(`${baseUrl}/user-preference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "faux",
            model: "arbitrary-model-slug",
            speed: "priority",
          }),
        })
        expect(updated.status).toBe(200)
      } finally {
        await closeServer(firstServer)
        await first.close()
      }

      const second = await createYakitoriApplication(options)
      const secondServer = second.createHttpServer()
      try {
        const baseUrl = await listen(secondServer)
        const response = await fetch(`${baseUrl}/providers`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as ApiListProvidersResponse
        expect(body.userPreference).toEqual({
          provider: "faux",
          model: "arbitrary-model-slug",
          speed: "priority",
        })
      } finally {
        await closeServer(secondServer)
        await second.close()
      }
    })
  })

  it("does not duplicate a configured default that is already in the catalog", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        modelDirectory: {
          async listModels(provider) {
            if (provider === "faux") {
              return [
                {
                  id: "scripted",
                  displayName: "Scripted",
                  instructionProfileId: "default",
                },
              ]
            }
            return []
          },
        },
      })
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const response = await fetch(`${baseUrl}/providers`)
        const body = (await response.json()) as ApiListProvidersResponse

        expect(
          body.providers.find((provider) => provider.name === "faux"),
        ).toEqual({
          name: "faux",
          defaultModel: "scripted",
          models: [
            {
              id: "scripted",
              displayName: "Scripted",
              instructionProfileId: "default",
            },
          ],
        })
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

describe("codex login registration", () => {
  const touchedEnv = ["CODEX_HOME", "OPENAI_API_KEY"] as const
  let savedEnv: Record<(typeof touchedEnv)[number], string | undefined>

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      touchedEnv.map((key) => [key, process.env[key]]),
    ) as typeof savedEnv
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    for (const key of touchedEnv) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function providersWithLogin(
    rootDir: string,
    workspace: string,
    login: unknown | undefined,
  ): Promise<ApiListProvidersResponse> {
    const codexHome = join(rootDir, "codex-home")
    await mkdir(codexHome, { recursive: true })
    if (login !== undefined) {
      await writeFile(join(codexHome, "auth.json"), JSON.stringify(login))
    }
    process.env.CODEX_HOME = codexHome
    const application = await createYakitoriApplication(
      testApplicationOptions({ rootDir, workspace }),
    )
    const server = application.createHttpServer()
    try {
      const baseUrl = await listen(server)
      const response = await fetch(`${baseUrl}/providers`)
      return (await response.json()) as ApiListProvidersResponse
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
  }

  it("registers the codex provider with the curated catalog for ChatGPT logins", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "id",
          access_token: "access",
          refresh_token: "refresh",
          account_id: "account-1",
        },
        last_refresh: "2026-08-10T00:00:00.000Z",
      })

      const codex = body.providers.find((provider) => provider.name === "codex")
      expect(codex?.models.map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
      ])
      expect(codex?.models[0]).toMatchObject({
        displayName: "GPT-5.6-Sol",
        instructionProfileId: "codex",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      })
    })
  })

  it("registers plain openai for API-key logins when no env key claims it", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-from-auth-json",
        tokens: null,
      })

      expect(
        body.providers.some((provider) => provider.name === "openai"),
      ).toBe(true)
      expect(body.providers.some((provider) => provider.name === "codex")).toBe(
        false,
      )
    })
  })

  it("prefers the environment key over the auth.json API key", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env"
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, {
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-from-auth-json",
        tokens: null,
      })

      expect(
        body.providers.filter((provider) => provider.name === "openai"),
      ).toHaveLength(1)
      expect(body.providers.some((provider) => provider.name === "codex")).toBe(
        false,
      )
    })
  })

  it("registers neither codex nor openai without a login or env key", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const body = await providersWithLogin(rootDir, workspace, undefined)

      expect(
        body.providers.some(
          (provider) => provider.name === "codex" || provider.name === "openai",
        ),
      ).toBe(false)
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

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
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
