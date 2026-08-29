import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { createLiveTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("thread server handlers", () => {
  it("publishes each rollout event only through its append fence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-fence-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        snapshots: ["final answer"],
        content: [{ type: "text", text: "final answer" }],
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createLiveTurnProcessor({
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
      deliveries.indexOf("turn.completed"),
    )
  })
})

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
