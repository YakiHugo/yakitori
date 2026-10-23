import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { ContextManager } from "../../src/core/context-manager.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { ModelMessage } from "../../src/kernel/index.ts"

export async function persistModelMessages(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-citations-"))
  const store = new JsonlThreadStore({ root })
  let writerOpen = false
  try {
    await store.createThread({
      id: "thread_content",
      conversationId: "conversation",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    })
    writerOpen = true
    await store.appendItems(
      "thread_content",
      messages.map((item, index) => ({
        type: "response_item",
        item: {
          id: `item_${index}`,
          turnId: "turn_one",
          createdAt: "2026-10-05T00:00:00.000Z",
          item,
        },
      })),
    )
    await store.persistThread("thread_content", "turn_start")
    await store.shutdownThread("thread_content")
    writerOpen = false
    const stored = await new JsonlThreadStore({ root }).readThread(
      "thread_content",
    )
    if (stored === undefined) throw new Error("Missing persisted content")
    const history = ContextManager.fromStoredThread(stored)
      .snapshot()
      .history.map((entry) => entry.item)
    expect(history).toEqual(messages)
    return history
  } finally {
    if (writerOpen) await store.shutdownThread("thread_content")
    await rm(root, { recursive: true, force: true })
  }
}
