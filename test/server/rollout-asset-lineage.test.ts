import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import type { Server as HttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import type { ApiHandlerResult } from "../../src/server/protocol.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("rollout asset lineage", () => {
  it("keeps physical rollout ownership distinct from the logical Thread id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-physical-rollout-"))
    const workspace = await mkdtemp(
      join(tmpdir(), "yakitori-physical-rollout-work-"),
    )
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    })
    const options = {
      rootDir,
      workspace,
      userConfigPath: join(rootDir, "config.toml"),
    }
    const initial = await createYakitoriApplication({
      ...options,
      stream: createFauxProvider([]).stream,
    })
    const created = await initial.handlers.createSession()
    expectOk(created)
    const threadId = created.body.session.id
    const sessionStoreRoot = initial.sessionStoreRoot
    await initial.close()

    const rolloutId = "rollout_physical_integration"
    await reidentifyPhysicalRollout(sessionStoreRoot, threadId, rolloutId)
    const assetStore = new JsonlThreadStore({ root: sessionStoreRoot })
    await assetStore.initialize()
    const assets = createRolloutAssets(sessionStoreRoot, {
      withMutationLease: (candidate, mutate) =>
        assetStore.withRolloutAssetMutation(candidate, mutate),
    })
    const retainedCommand = await assets.prepareCommandFiles(
      rolloutId,
      "call_retained",
    )
    await writeFile(retainedCommand.stdout.path, "physical output")
    const orphanDirectory = join(sessionStoreRoot, "rollouts", "rollout_orphan")
    await mkdir(join(orphanDirectory, "files"), { recursive: true })
    await writeFile(join(orphanDirectory, "files", "orphan.tmp"), "orphan")

    const application = await createYakitoriApplication({
      ...options,
      stream: createFauxProvider([
        { content: [{ type: "text", text: "done" }] },
      ]).stream,
    })
    try {
      expect(
        (await application.threadStore.readThread(threadId))?.metadata
          .rolloutId,
      ).toBe(rolloutId)
      await expect(
        application.rolloutAssets.read(retainedCommand.stdout.reference),
      ).resolves.toEqual(Buffer.from("physical output"))
      await expect(
        stat(join(sessionStoreRoot, "rollouts", "rollout_orphan")),
      ).rejects.toMatchObject({ code: "ENOENT" })

      const imageBytes = pngBuffer(128)
      const attachments = await application.rolloutAssets.importImageBytes(
        rolloutId,
        "draft_physical_integration",
        [{ name: "screen.png", data: imageBytes }],
      )
      const admitted = await application.handlers.admitInput({
        sessionId: threadId,
        requestId: "request_physical_integration",
        content: { kind: "text", text: "inspect", attachments },
      })
      expectOk(admitted)
      await waitForThreadIdle(application, threadId)
      const storedImage = await durableImageFile(application, threadId)
      expect(storedImage.rolloutId).toBe(rolloutId)

      const server = application.createHttpServer()
      const baseUrl = await listen(server)
      try {
        const physical = await fetch(
          `${baseUrl}/rollouts/${rolloutId}/assets/${storedImage.path}`,
        )
        expect(physical.status).toBe(200)
        expect(Buffer.from(await physical.arrayBuffer())).toEqual(imageBytes)
        expect(
          await fetch(
            `${baseUrl}/rollouts/${threadId}/assets/${storedImage.path}`,
          ),
        ).toMatchObject({ status: 404 })
        expect(
          await fetch(
            `${baseUrl}/rollouts/${rolloutId}/assets/tools/call_retained/stdout.log`,
          ),
        ).toMatchObject({ status: 404 })
      } finally {
        await closeServer(server)
      }
    } finally {
      await application.close()
    }
  })

  it("retains inherited fork images until the last descendant is deleted", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-lineage-"))
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-lineage-work-"))
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    })
    const imageBytes = pngBuffer(128)
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "source image" }] },
      { content: [{ type: "text", text: "source text" }] },
      { content: [{ type: "text", text: "child" }] },
      { content: [{ type: "text", text: "grandchild" }] },
      {
        assertRequest(request) {
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                images: [
                  expect.objectContaining({
                    data: imageBytes.toString("base64"),
                  }),
                ],
              }),
            ]),
          )
        },
        content: [{ type: "text", text: "image survived" }],
      },
    ])
    const options = {
      rootDir,
      workspace,
      stream: provider.stream,
      userConfigPath: join(rootDir, "config.toml"),
    }
    const application = await createYakitoriApplication(options)

    const created = await application.handlers.createSession()
    expectOk(created)
    const sourceId = created.body.session.id
    const attachments = await application.rolloutAssets.importImageBytes(
      sourceId,
      "lineage_draft",
      [{ name: "source.png", data: imageBytes }],
    )
    const first = await application.handlers.admitInput({
      sessionId: sourceId,
      requestId: "request_lineage_image",
      content: { kind: "text", text: "remember", attachments },
    })
    expectOk(first)
    await waitForThreadIdle(application, sourceId)
    const sourceFile = await durableImageFile(application, sourceId)
    const second = await application.handlers.admitInput({
      sessionId: sourceId,
      requestId: "request_lineage_second",
      content: { kind: "text", text: "fork here" },
    })
    expectOk(second)
    await waitForThreadIdle(application, sourceId)

    const child = await application.handlers.forkSession({
      sessionId: sourceId,
      atInputId: second.body.inputId,
      reason: "edit",
      content: { kind: "text", text: "child input" },
    })
    expectOk(child)
    const childId = child.body.session.id
    await waitForThreadIdle(application, childId)
    const childInputId = await localInputId(application, childId)

    const grandchild = await application.handlers.forkSession({
      sessionId: childId,
      atInputId: childInputId,
      reason: "edit",
      content: { kind: "text", text: "grandchild input" },
    })
    expectOk(grandchild)
    const grandchildId = grandchild.body.session.id
    await waitForThreadIdle(application, grandchildId)

    expectOk(await application.handlers.deleteSession({ sessionId: sourceId }))
    expectOk(await application.handlers.deleteSession({ sessionId: childId }))
    await expect(application.rolloutAssets.read(sourceFile)).resolves.toEqual(
      imageBytes,
    )

    const continued = await application.handlers.admitInput({
      sessionId: grandchildId,
      requestId: "request_lineage_continue",
      content: { kind: "text", text: "use inherited image" },
    })
    expectOk(continued)
    await waitForThreadIdle(application, grandchildId)
    expect(provider.callCount).toBe(5)

    expectOk(
      await application.handlers.deleteSession({ sessionId: grandchildId }),
    )
    await application.close()

    const restarted = await createYakitoriApplication({
      ...options,
      stream: createFauxProvider([]).stream,
    })
    try {
      await expect(
        stat(join(restarted.sessionStoreRoot, "rollouts", sourceId)),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await restarted.close()
    }
  })

  it("retains a physical rollout's command files while a fork inherits it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-command-lineage-"))
    const workspace = await mkdtemp(
      join(tmpdir(), "yakitori-command-lineage-work-"),
    )
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    })
    const options = {
      rootDir,
      workspace,
      userConfigPath: join(rootDir, "config.toml"),
    }
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
      { content: [{ type: "text", text: "child" }] },
    ])
    const application = await createYakitoriApplication({
      ...options,
      stream: provider.stream,
    })
    const created = await application.handlers.createSession()
    expectOk(created)
    const sourceId = created.body.session.id
    expectOk(
      await application.handlers.admitInput({
        sessionId: sourceId,
        requestId: "request_command_first",
        content: { kind: "text", text: "first" },
      }),
    )
    await waitForThreadIdle(application, sourceId)
    const commandFiles = await application.rolloutAssets.prepareCommandFiles(
      sourceId,
      "call_lineage_output",
    )
    await writeFile(commandFiles.stdout.path, "durable command output")
    const second = await application.handlers.admitInput({
      sessionId: sourceId,
      requestId: "request_command_second",
      content: { kind: "text", text: "fork here" },
    })
    expectOk(second)
    await waitForThreadIdle(application, sourceId)
    const child = await application.handlers.forkSession({
      sessionId: sourceId,
      atInputId: second.body.inputId,
      reason: "edit",
      content: { kind: "text", text: "child" },
    })
    expectOk(child)
    const childId = child.body.session.id
    await waitForThreadIdle(application, childId)
    expectOk(await application.handlers.deleteSession({ sessionId: sourceId }))
    await application.close()

    const retained = await createYakitoriApplication({
      ...options,
      stream: createFauxProvider([]).stream,
    })
    await expect(
      retained.rolloutAssets.read(commandFiles.stdout.reference),
    ).resolves.toEqual(Buffer.from("durable command output"))
    expectOk(await retained.handlers.deleteSession({ sessionId: childId }))
    await retained.close()

    const collected = await createYakitoriApplication({
      ...options,
      stream: createFauxProvider([]).stream,
    })
    try {
      await expect(
        stat(join(collected.sessionStoreRoot, "rollouts", sourceId)),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await collected.close()
    }
  })
})

async function reidentifyPhysicalRollout(
  sessionStoreRoot: string,
  threadId: string,
  rolloutId: string,
): Promise<void> {
  const metadataPath = join(sessionStoreRoot, "threads", `${threadId}.json`)
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
    string,
    unknown
  >
  metadata.rolloutId = rolloutId
  await writeFile(metadataPath, JSON.stringify(metadata))

  const sourceDirectory = join(sessionStoreRoot, "rollouts", threadId)
  const targetDirectory = join(sessionStoreRoot, "rollouts", rolloutId)
  await rename(sourceDirectory, targetDirectory)
  const rolloutPath = join(targetDirectory, "rollout.jsonl")
  const records = (await readFile(rolloutPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  for (const record of records) {
    record.rolloutId = rolloutId
    const item = record.item
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "session_meta" &&
      "metadata" in item &&
      typeof item.metadata === "object" &&
      item.metadata !== null
    ) {
      ;(item.metadata as Record<string, unknown>).rolloutId = rolloutId
    }
  }
  await writeFile(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  )
}

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

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

async function localInputId(
  application: YakitoriApplication,
  threadId: string,
): Promise<string> {
  const stored = await application.threadStore.readThread(threadId)
  const input = stored?.rollout.find(
    (record) =>
      record.rolloutId === threadId &&
      record.item.type === "response_item" &&
      record.item.item.item.role === "user" &&
      record.item.item.item.context === undefined,
  )
  if (input?.item.type !== "response_item") {
    throw new Error("Local fork input was not found.")
  }
  return input.item.item.id
}

async function durableImageFile(
  application: YakitoriApplication,
  threadId: string,
) {
  const stored = await application.threadStore.readThread(threadId)
  const image = stored?.rollout.flatMap((record) => {
    if (
      record.item.type !== "response_item" ||
      record.item.item.item.role !== "user"
    ) {
      return []
    }
    return record.item.item.item.images ?? []
  })[0]
  if (image === undefined || !("file" in image)) {
    throw new Error("Durable source image was not found.")
  }
  return image.file
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
