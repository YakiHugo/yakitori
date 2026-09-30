import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { InputQueue } from "../../src/server/input-queue.ts"
import { QueuedItemService } from "../../src/server/queued-item-service.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { waitForValue } from "../support/wait-for-value.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("queued item service", () => {
  it("notices an external SQLite writer and dispatches a loaded idle thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-queue-external-"))
    const path = join(root, "queue.sqlite")
    const queue = new InputQueue(path)
    const external = new InputQueue(path)
    const seen: string[] = []
    const manager = new ThreadManager({
      store: new MemoryThreadStore(),
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* (request) {
            const text = request.messages
              .flatMap((message) =>
                message.role === "user" ? message.content : [],
              )
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .find((value) => value === "external input")
            if (text !== undefined) seen.push(text)
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "done" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const changed: string[] = []
    const service = new QueuedItemService({
      queue,
      manager,
      notifyChanged: (sessionId) => changed.push(sessionId),
      reporter: () => undefined,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await service.close()
      external.close()
      queue.close()
      await rm(root, { recursive: true, force: true })
    })
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    service.install(thread)
    service.pollExternalChanges()
    const version = queue.changeVersion()
    external.enqueue(thread.id, {
      submissionId: "request_external",
      content: { kind: "text", text: "external input" },
    })
    expect(queue.changeVersion()).toBeGreaterThan(version)
    expect(queue.changesSince(0, [thread.id])).toEqual([
      expect.objectContaining({ sessionId: thread.id }),
    ])

    service.pollExternalChanges()
    expect(changed).toContain(thread.id)
    await waitForValue(() => (seen.length === 1 ? true : undefined))
    expect(seen).toEqual(["external input"])
    expect(queue.list(thread.id)).toEqual([])
  })
})
