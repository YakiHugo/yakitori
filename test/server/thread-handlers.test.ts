import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  createYakitoriError,
  YakitoriErrorCode,
} from "../../src/kernel/errors.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { isKernelEvent } from "../../src/kernel/events.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("thread server handlers", () => {
  it("sums billing usage across Turns while keeping the latest active context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-usage-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "first" }],
        usage: { inputTokens: 10, outputTokens: 2, activeContextTokens: 9 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { inputTokens: 4, outputTokens: 1, activeContextTokens: 3 },
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id

    for (const text of ["first", "second"]) {
      const admitted = await handlers.admitInput({
        sessionId,
        requestId: `request_${text}`,
        content: { kind: "text", text },
      })
      if (!admitted.ok) throw new Error(admitted.body.error.message)
      await waitForValue(() =>
        manager.getThread(sessionId)?.status === "idle" ? true : undefined,
      )
    }

    const read = await handlers.readSession({ sessionId })
    if (!read.ok) throw new Error(read.body.error.message)
    expect(read.body.session.usage).toEqual({
      inputTokens: 14,
      outputTokens: 3,
      activeContextTokens: 3,
    })
  })

  it("publishes each rollout event only through its append fence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-fence-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        snapshots: ["final answer"],
        content: [
          { type: "reasoning", text: "considering" },
          { type: "text", text: "final answer" },
        ],
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const deliveries: string[] = []
    const subscription = eventHub.subscribe(sessionId, (delivery) => {
      if (delivery.kind === "transient") {
        deliveries.push(delivery.event.type)
        return
      }
      deliveries.push(...delivery.events.map((event) => event.type))
    })
    cleanups.push(async () => subscription.close())

    const originalRead = store.readThread.bind(store)
    const readStarted = deferred<void>()
    const releaseReads = deferred<void>()
    let blockReads = true
    store.readThread = async (threadId) => {
      if (blockReads) {
        readStarted.resolve()
        await releaseReads.promise
      }
      return originalRead(threadId)
    }

    const admitted = handlers.admitInput({
      sessionId,
      requestId: "request_fenced_delivery",
      content: { kind: "text", text: "answer" },
    })
    await readStarted.promise
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )
    blockReads = false
    releaseReads.resolve()
    const result = await admitted
    if (!result.ok) throw new Error(result.body.error.message)
    await waitForValue(() =>
      deliveries.includes("turn.completed") ? true : undefined,
    )

    expect(deliveries.indexOf("turn.started")).toBeLessThan(
      deliveries.indexOf("assistant.delta"),
    )
    expect(deliveries.indexOf("assistant.delta")).toBeLessThan(
      deliveries.indexOf("item.completed"),
    )
    expect(deliveries.indexOf("item.completed")).toBeLessThan(
      deliveries.indexOf("turn.completed"),
    )

    const replay = await handlers.readSessionEvents({ sessionId })
    if (!replay.ok) throw new Error(replay.body.error.message)
    expect(
      replay.body.events.find(
        (event) =>
          isKernelEvent(event) &&
          event.type === "item.completed" &&
          event.data.item.type === "agent_message",
      ),
    ).toMatchObject({
      type: "item.completed",
      data: {
        item: {
          type: "agent_message",
          content: [{ type: "text", text: "final answer" }],
        },
      },
    })
    const restored = await handlers.readSession({ sessionId })
    if (!restored.ok) throw new Error(restored.body.error.message)
    expect(restored.body.session.counts).toMatchObject({ items: 2, tools: 0 })
  })

  it("promotes attachments into the physical rollout asset namespace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-assets-"))
    const store = new MemoryThreadStore()
    const threadId = "session_00000000-0000-4000-8000-000000000001"
    const rolloutId = "rollout_physical"
    const now = new Date().toISOString()
    await store.createThread({
      id: threadId,
      conversationId: threadId,
      createdAt: now,
      updatedAt: now,
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    await store.shutdownThread(threadId)
    store.reidentifyRollout(threadId, rolloutId)
    const rolloutDirectory = join(workspace, "rollouts", rolloutId)
    await mkdir(rolloutDirectory, { recursive: true })
    await writeFile(join(rolloutDirectory, "rollout.jsonl"), "fixture\n")
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(candidate, mutate) {
        const owned = (await store.readThread(threadId))?.metadata.rolloutId
        if (owned !== candidate) {
          throw new Error(`Physical rollout ${candidate} is not owned.`)
        }
        return mutate()
      },
    })
    const attachments = await rolloutAssets.importImageBytes(
      rolloutId,
      "draft_physical",
      [{ name: "screen.png", data: pngBytes() }],
    )
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([
            { content: [{ type: "text", text: "done" }] },
          ]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const invalid = await handlers.admitInput({
      sessionId: threadId,
      requestId: "request_invalid_rollout_asset",
      content: {
        kind: "text",
        text: "inspect",
        attachments: [
          {
            name: "screen.png",
            mediaType: "image/png",
            sizeBytes: 24,
            file: {
              rolloutId: "../escape",
              path: "attachments/staging/draft/1.png",
            },
          },
        ],
      },
    })
    expect(invalid).toMatchObject({
      ok: false,
      status: 400,
      body: { error: { code: "invalid_input" } },
    })

    const admitted = await handlers.admitInput({
      sessionId: threadId,
      requestId: "request_physical_assets",
      content: { kind: "text", text: "inspect", attachments },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    const stored = await store.readThread(threadId)
    const image = stored?.rollout.flatMap((record) =>
      record.item.type === "response_item" &&
      record.item.item.item.role === "user"
        ? (record.item.item.item.images ?? [])
        : [],
    )[0]

    expect(image).toMatchObject({ file: { rolloutId } })
  })

  it("maps attachment ownership lost to concurrent deletion as not found", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-race-"))
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(rolloutId) {
        throw createYakitoriError({
          code: YakitoriErrorCode.NotFound,
          message: `Physical rollout ${rolloutId} is not owned by a Thread.`,
          details: { rolloutId },
        })
      },
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const rolloutId = created.body.session.id

    const admitted = await handlers.admitInput({
      sessionId: rolloutId,
      requestId: "request_deleted_during_promotion",
      content: {
        kind: "text",
        text: "inspect",
        attachments: [
          {
            name: "screen.png",
            mediaType: "image/png",
            sizeBytes: 24,
            file: {
              rolloutId,
              path: "attachments/staging/draft_deleted/1.png",
            },
          },
        ],
      },
    })

    expect(admitted).toMatchObject({
      ok: false,
      status: 404,
      body: { error: { code: "not_found" } },
    })
  })
})

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function waitForValue<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for a value.")
}
