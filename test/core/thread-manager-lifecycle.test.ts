import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"

it("releases a physical child writer when seeding fails and permits retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-manager-cleanup-"))
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => {
      throw new Error("Processor installation must not be reached.")
    },
  })
  const id = "thread_failed_seed"
  const originalAppend = store.appendItems.bind(store)
  store.appendItems = () => Promise.reject(new Error("Seed write failed."))
  try {
    await expect(
      manager.createThread({
        threadId: id,
        parentThreadId: "thread_parent",
        initialContext: { sourceThreadId: "thread_parent", messages: [] },
      }),
    ).rejects.toThrow("Seed write failed.")
    expect(await store.readThread(id)).toBeUndefined()
    store.appendItems = originalAppend
    const now = new Date().toISOString()
    await expect(
      store.createThread({
        id,
        conversationId: id,
        parentThreadId: "thread_parent",
        createdAt: now,
        updatedAt: now,
      }),
    ).resolves.toMatchObject({ metadata: { id } })
  } finally {
    await manager.shutdown()
    await store.discardThread(id)
    await rm(root, { recursive: true, force: true })
  }
})

it("removes a physical child created across the shutdown boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-manager-shutdown-"))
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => {
      throw new Error("Processor installation must not be reached.")
    },
  })
  const originalCreate = store.createThread.bind(store)
  store.createThread = async (metadata) => {
    const stored = await originalCreate(metadata)
    manager.beginShutdown()
    return stored
  }
  const id = "thread_shutdown_child"
  try {
    await expect(
      manager.createThread({ threadId: id, parentThreadId: "thread_parent" }),
    ).rejects.toThrow("ThreadManager shut down while creating a Thread.")
    expect(await store.readThread(id)).toBeUndefined()
    expect(await store.listThreadIds()).not.toContain(id)
  } finally {
    await manager.shutdown()
    await store.discardThread(id)
    await rm(root, { recursive: true, force: true })
  }
})

it("releases and removes a fork created across the shutdown boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-manager-fork-"))
  const store = new JsonlThreadStore({ root })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => ({
      async prepare() {
        throw new Error("Turn execution must not be reached.")
      },
      start() {
        throw new Error("Turn execution must not be reached.")
      },
    }),
  })
  let forkId: string | undefined
  try {
    const source = await manager.createThread({
      threadId: "thread_fork_source",
      parentThreadId: "thread_parent",
    })
    await store.appendItems(source.id, [
      { type: "turn_started", turnId: "turn_boundary", inputItemId: "input" },
    ])
    const originalFork = store.createFork.bind(store)
    store.createFork = async (input) => {
      const result = await originalFork(input)
      forkId = result.thread.metadata.id
      manager.beginShutdown()
      return result
    }
    await expect(
      manager.forkThread({
        sourceThreadId: source.id,
        beforeTurnId: "turn_boundary",
      }),
    ).rejects.toThrow("ThreadManager shut down while forking a Thread.")
    if (forkId === undefined) throw new Error("Fork was not created.")
    expect(await store.readThread(forkId)).toBeUndefined()
    expect(await store.listThreadIds()).toEqual([source.id])
    await manager.shutdown()
    await expect(store.deleteThread(source.id)).resolves.toBeUndefined()
  } finally {
    await manager.shutdown()
    if (forkId !== undefined) await store.discardThread(forkId)
    await rm(root, { recursive: true, force: true })
  }
})
