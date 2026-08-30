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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MateLifecycle } from "../../src/mates/events.ts"
import { createMateKernel } from "../../src/mates/mate-kernel.ts"
import { createSqliteMateStore } from "../../src/mates/sqlite-mate-store.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { type ModelRequest, ModelStopReason } from "../../src/runtime/model.ts"
import { listCatalogModels } from "../../src/runtime/model-catalog.ts"
import {
  createYakitoriApplication,
  resolveWorkspaceDirectory,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  type ApiListProvidersResponse,
} from "../../src/server/protocol.ts"

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
        const imageBytes = pngBuffer(128)
        const attachments = await application.rolloutAssets.importImageBytes(
          sessionId,
          "draft_application_test",
          [{ name: "screen.png", data: imageBytes }],
        )
        const admitted = await application.handlers.admitInput({
          sessionId,
          requestId: "request_image",
          content: {
            kind: "text",
            text: "inspect",
            attachments,
          },
        })
        expectOk(admitted)
        await waitForThreadIdle(application, sessionId)

        expect(admitted.body.event).toMatchObject({
          data: {
            content: {
              attachments: [
                {
                  detail: "high",
                  file: {
                    rolloutId: sessionId,
                    path: "attachments/requests/request_image/1.png",
                  },
                },
              ],
            },
          },
        })
        expect(JSON.stringify(admitted.body.event)).not.toContain(
          imageBytes.toString("base64"),
        )
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "assets",
              sessionId,
              "files",
              "attachments",
              "requests",
              "request_image",
              "1.png",
            ),
          ),
        ).toEqual(imageBytes)
        expect(captured?.messages).toContainEqual({
          role: "user",
          content: [{ type: "text", text: "inspect" }],
          images: [
            {
              type: "image",
              mediaType: "image/png",
              detail: "high",
              data: imageBytes.toString("base64"),
            },
          ],
        })

        const image = await fetch(
          `${baseUrl}/rollouts/${sessionId}/assets/attachments/requests/request_image/1.png`,
        )
        expect(image.status).toBe(200)
        expect(image.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await image.arrayBuffer())).toEqual(imageBytes)
        const logRoute = await fetch(
          `${baseUrl}/rollouts/${sessionId}/assets/tools/call_1/stdout.log`,
        )
        expect(logRoute.status).toBe(404)

        const replacementBytes = Buffer.from(imageBytes)
        replacementBytes[12] = 1
        const replacementDraft =
          await application.rolloutAssets.importImageBytes(
            sessionId,
            "draft_application_conflict",
            [{ name: "screen.png", data: replacementBytes }],
          )
        const conflictingImage = await application.handlers.admitInput({
          sessionId,
          requestId: "request_image",
          content: {
            kind: "text",
            text: "inspect",
            attachments: replacementDraft,
          },
        })
        expectError(conflictingImage, 409, ApiErrorCode.Conflict)
        expect(conflictingImage.body.error.details).toMatchObject({
          reason: "request_conflict",
        })
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "assets",
              sessionId,
              "files",
              "attachments",
              "requests",
              "request_image",
              "1.png",
            ),
          ),
        ).toEqual(imageBytes)

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

        const forked = await application.handlers.forkSession({
          sessionId,
          atInputId: admitted.body.inputId,
          reason: "edit",
          content: {
            kind: "text",
            text: "inspect more closely",
          },
        })
        expectOk(forked)
        expect(forked.body.historyEndSeqExclusive).toBe(2)
        await waitForThreadIdle(application, forked.body.session.id)

        const child = await application.threadStore.readThread(
          forked.body.session.id,
        )
        expect(child?.metadata).toMatchObject({
          parentThreadId: sessionId,
          forkedFromInputId: admitted.body.inputId,
          forkReason: "edit",
        })
        const childInput = child?.rollout.find(
          ({ item }) =>
            item.type === "response_item" && item.item.id.startsWith("input_"),
        )?.item
        expect(childInput).toMatchObject({
          item: {
            item: {
              images: [
                {
                  file: {
                    rolloutId: forked.body.session.id,
                    path: expect.stringMatching(
                      /^attachments\/requests\/request_.+\/1\.png$/,
                    ),
                  },
                },
              ],
            },
          },
        })
        const childImagePath =
          childInput?.type === "response_item" &&
          childInput.item.item.role === "user"
            ? childInput.item.item.images?.[0]?.file?.path
            : undefined
        if (childImagePath === undefined) {
          throw new Error("Expected the forked input to retain its image.")
        }
        expect(
          await readFile(
            join(
              application.sessionStoreRoot,
              "assets",
              forked.body.session.id,
              "files",
              childImagePath,
            ),
          ),
        ).toEqual(imageBytes)

        const concurrentSession = await application.handlers.createSession()
        expectOk(concurrentSession)
        const [draftA, draftB] = await Promise.all([
          application.rolloutAssets.importImageBytes(
            concurrentSession.body.session.id,
            "draft_concurrent_a",
            [{ name: "screen.png", data: imageBytes }],
          ),
          application.rolloutAssets.importImageBytes(
            concurrentSession.body.session.id,
            "draft_concurrent_b",
            [{ name: "screen.png", data: imageBytes }],
          ),
        ])
        const concurrent = await Promise.all([
          application.handlers.admitInput({
            sessionId: concurrentSession.body.session.id,
            requestId: "request_concurrent_image",
            content: { kind: "text", text: "A", attachments: draftA },
          }),
          application.handlers.admitInput({
            sessionId: concurrentSession.body.session.id,
            requestId: "request_concurrent_image",
            content: { kind: "text", text: "B", attachments: draftB },
          }),
        ])
        expect(concurrent.map((result) => result.status).sort()).toEqual([
          201, 409,
        ])
        await expect(
          application.rolloutAssets.read({
            rolloutId: concurrentSession.body.session.id,
            path: "attachments/requests/request_concurrent_image/1.png",
          }),
        ).resolves.toEqual(imageBytes)
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  })

  it("drains live event listeners while closing an active Turn", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([{ waitForAbort: true }])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: provider.stream,
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const admitted = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_close_active",
          content: { kind: "text", text: "wait" },
        })
        expectOk(admitted)
        expect(
          application.threadManager.getThread(created.body.session.id)?.status,
        ).toBe("active")

        await application.close()

        expect(
          application.threadManager.getThread(created.body.session.id)?.status,
        ).toBeUndefined()
      } finally {
        await application.close()
      }
    })
  })

  it("does not materialize stored images for text-only models", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      let captured: ModelRequest | undefined
      const application = await createYakitoriApplication({
        ...testApplicationOptions({ rootDir, workspace }),
        model: "text-only",
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
      try {
        const created = await application.handlers.createSession({})
        expectOk(created)
        const sessionId = created.body.session.id
        const attachments = await application.rolloutAssets.importImageBytes(
          sessionId,
          "text_only_draft",
          [{ name: "screen.png", data: pngBuffer(128) }],
        )
        const read = vi.spyOn(application.rolloutAssets, "read")
        const admitted = await application.handlers.admitInput({
          sessionId,
          requestId: "text_only_request",
          content: {
            kind: "text",
            text: "inspect",
            attachments,
          },
        })
        expectOk(admitted)

        await waitForThreadIdle(application, sessionId)

        expect(read).not.toHaveBeenCalled()
        expect(captured?.messages).toContainEqual({
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "text",
              text: expect.stringContaining("does not support image input"),
            },
          ],
        })
      } finally {
        await application.close()
      }
    })
  })

  it("streams native images from rollout asset storage", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const server = application.createHttpServer()
      try {
        const baseUrl = await listen(server)
        const created = await application.handlers.createSession({})
        expectOk(created)
        const imageBytes = pngBuffer(128 * 1024 + 17)
        const sourcePath = join(rootDir, "large.png")
        await writeFile(sourcePath, imageBytes)
        const [attachment] = await application.rolloutAssets.importImagePaths(
          created.body.session.id,
          "draft_large_http",
          [sourcePath],
        )
        if (attachment === undefined) throw new Error("missing imported image")

        const response = await fetch(
          `${baseUrl}/rollouts/${attachment.file.rolloutId}/assets/${attachment.file.path}`,
        )

        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes)
      } finally {
        await closeServer(server)
        await application.close()
      }
    })
  }, 15_000)

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

  it("does not treat events.sqlite as the Mate database", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const legacyPath = join(rootDir, "events.sqlite")
      const mateStore = createSqliteMateStore({ databasePath: legacyPath })
      const legacyMate = await createMateKernel(mateStore).createMate({
        instructions: "Old development data.",
        name: "Legacy",
        role: "Builder",
      })
      mateStore.close()

      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(application.mateDatabasePath).toBe(join(rootDir, "mates.sqlite"))
        expect(application.activeMate.mateId).not.toBe(legacyMate.mate.id)
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
        await waitForThreadIdle(application, created.body.session.id)

        const stored = await application.threadStore.readThread(
          created.body.session.id,
        )
        expect(
          stored?.rollout.find((entry) => entry.item.type === "turn_context")
            ?.item,
        ).toMatchObject({
          context: { selection: { provider: "openai", model: "gpt-test" } },
        })
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
        await waitForThreadIdle(application, created.body.session.id)

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
        await waitForThreadIdle(application, created.body.session.id)

        const stored = await application.threadStore.readThread(
          created.body.session.id,
        )
        expect(
          stored?.rollout.find((entry) => entry.item.type === "turn_context")
            ?.item,
        ).toMatchObject({
          context: { selection: { provider: "grok", model: "grok-4.5" } },
        })
        expect(
          stored?.rollout.find(
            (entry) =>
              entry.item.type === "turn_completed" &&
              entry.item.outcome === "failed",
          )?.item,
        ).toMatchObject({
          error: {
            message: expect.stringContaining("Grok credentials not found"),
          },
        })
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
          await waitForThreadIdle(application, created.body.session.id)
        }

        const stored = await application.threadStore.readThread(
          created.body.session.id,
        )
        const terminals = stored?.rollout.filter(
          (entry) => entry.item.type === "turn_completed",
        )
        expect(terminals).toHaveLength(2)
        expect(
          terminals?.filter(
            (entry) =>
              entry.item.type === "turn_completed" &&
              entry.item.outcome === "failed",
          ),
        ).toEqual([])
      } finally {
        await application.close()
      }
    })
  })

  it("replays idempotent admission with its durable host attributes", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const provider = createFauxProvider([
        { content: [{ type: "text", text: "once" }] },
      ])
      const application = await createYakitoriApplication({
        rootDir,
        workspace,
        stream: provider.stream,
        userConfigPath: join(rootDir, "config.toml"),
      })
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const input = {
          sessionId: created.body.session.id,
          requestId: "request_idempotent_host",
          content: { kind: "text", text: "only once" },
          modelSelection: { provider: "faux", model: "scripted" },
          parentInputId: "input_parent",
          metadata: { source: "test" },
        }
        const admitted = await application.handlers.admitInput(input)
        expectOk(admitted)
        await waitForThreadIdle(application, created.body.session.id)
        const replayed = await application.handlers.admitInput(input)
        expectOk(replayed)
        expect(replayed.status).toBe(200)
        expect(replayed.body).toEqual(admitted.body)

        const conflicting = await application.handlers.admitInput({
          ...input,
          content: { kind: "text", text: "different" },
        })
        expectError(conflicting, 409, ApiErrorCode.Conflict)
        const read = await application.handlers.readSession({
          sessionId: created.body.session.id,
        })
        expectOk(read)
        expect(read.body.session.counts.inputs).toBe(1)
        const events = await application.handlers.readSessionEvents({
          sessionId: created.body.session.id,
        })
        expectOk(events)
        expect(
          events.body.events.filter((event) => event.type === "input.admitted"),
        ).toHaveLength(1)
        expect(admitted.body.event).toMatchObject({
          data: {
            modelSelection: input.modelSelection,
            parentInputId: input.parentInputId,
            metadata: input.metadata,
          },
        })
        expect(provider.callCount).toBe(1)
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
        await waitForThreadIdle(application, created.body.session.id)
        const second = await application.handlers.admitInput({
          sessionId: created.body.session.id,
          requestId: "request_fork_second",
          content: { kind: "text", text: "replace this" },
        })
        expectOk(second)
        await waitForThreadIdle(application, created.body.session.id)

        const forked = await application.handlers.forkSession({
          sessionId: created.body.session.id,
          atInputId: second.body.inputId,
          reason: "edit",
          content: { kind: "text", text: "replacement" },
          modelSelection: forkModelSelection,
        })
        expectOk(forked)
        await waitForThreadIdle(application, forked.body.session.id)

        const source = await application.threadStore.readThread(
          created.body.session.id,
        )
        const target = await application.threadStore.readThread(
          forked.body.session.id,
        )
        expect(completedTurnCount(source)).toBe(2)
        expect(userTexts(source)).toEqual(["first", "replace this"])
        expect(completedTurnCount(target)).toBe(2)
        expect(userTexts(target)).toEqual(["first", "replacement"])
        expect(target?.metadata).toMatchObject({
          parentThreadId: created.body.session.id,
          forkedFromTurnId: "request_fork_second",
          workingDirectory: application.workspace,
        })
        expect(
          target?.rollout.find(
            (entry) =>
              entry.item.type === "turn_context" &&
              entry.item.context.turnId !== "request_fork_first",
          )?.item,
        ).toMatchObject({ context: { selection: forkModelSelection } })
        expect(provider.callCount).toBe(3)
      } finally {
        await application.close()
      }
    })
  })

  it("does not expose the removed durable pending-input queue", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const application = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        const created = await application.handlers.createSession()
        expectOk(created)
        const cancelled = await application.handlers.cancelInput({
          sessionId: created.body.session.id,
          inputId: "input_00000000-0000-4000-8000-000000000000",
        })
        expectError(cancelled, 409, ApiErrorCode.Conflict)
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

  it("resumes stored Threads on demand without startup reconciliation", async () => {
    await withApplicationRoot(async (rootDir, workspace) => {
      const first = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      const created = await first.handlers.createSession()
      expectOk(created)
      const admitted = await first.handlers.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_before_restart",
        content: { kind: "text", text: "resume after restart" },
      })
      expectOk(admitted)
      await waitForThreadIdle(first, created.body.session.id)
      await first.close()

      const started = await createYakitoriApplication(
        testApplicationOptions({ rootDir, workspace }),
      )
      try {
        expect(started.threadManager.getThread(created.body.session.id)).toBe(
          undefined,
        )
        const read = await started.handlers.readSession({
          sessionId: created.body.session.id,
        })
        expectOk(read)
        expect(read.body.session.counts.turns).toBe(1)
        expect(started.threadManager.getThread(created.body.session.id)).toBe(
          undefined,
        )
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

async function waitForThreadIdle(
  application: YakitoriApplication,
  threadId: string,
): Promise<void> {
  const thread = application.threadManager.getThread(threadId)
  if (thread === undefined || thread.status === "idle") return
  await new Promise<void>((resolve) => {
    const unsubscribe = thread.subscribeStatus((status) => {
      if (status !== "idle") return
      unsubscribe()
      resolve()
    })
  })
}

function completedTurnCount(
  stored: Awaited<ReturnType<YakitoriApplication["threadStore"]["readThread"]>>,
): number {
  return (
    stored?.rollout.filter(
      (entry) =>
        entry.item.type === "turn_completed" &&
        entry.item.outcome === "completed",
    ).length ?? 0
  )
}

function userTexts(
  stored: Awaited<ReturnType<YakitoriApplication["threadStore"]["readThread"]>>,
): string[] {
  return (
    stored?.rollout.flatMap((entry) => {
      if (
        entry.item.type !== "response_item" ||
        entry.item.item.item.role !== "user" ||
        entry.item.item.item.context !== undefined
      ) {
        return []
      }
      return [
        entry.item.item.item.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      ]
    }) ?? []
  )
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

function pngBuffer(size: number): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 24))
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function expectOk<T>(
  result: ApiHandlerResult<T>,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(
      `Expected success: ${result.body.error.code}: ${result.body.error.message}`,
    )
  }
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
