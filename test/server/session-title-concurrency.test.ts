import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createSessionTitleGenerator } from "../../src/server/session-title.ts"

it("preserves a manual rename committed after the generated title's final read", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-title-race-"))
  const store = new JsonlThreadStore({ root })
  const sessionId = "session_title_race"
  try {
    await store.createThread({
      id: sessionId,
      conversationId: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await store.persistThread(sessionId, "turn_start")
    const write = store.updateSessionSidebar.bind(store)
    const competing = new JsonlThreadStore({ root })
    // Commit a genuine competing storage write after generation has finished
    // its last read, immediately before its write reaches the storage lock.
    vi.spyOn(store, "updateSessionSidebar").mockImplementation(
      async (...args) => {
        await competing.updateSessionSidebar({
          type: "session",
          sessionId,
          title: "Manual title",
        })
        return write(...args)
      },
    )
    const generator = createSessionTitleGenerator({
      store,
      availableProviders: ["kimi"],
      stream: async function* () {
        yield {
          type: "response",
          response: {
            stopReason: "end_turn",
            content: [{ type: "text", text: '{"title":"Automatic title"}' }],
          },
        }
      },
    })
    generator.openSession(sessionId)
    await generator.generate({ sessionId, text: "Fix login" })
    await generator.closeSession(sessionId)
    expect((await store.sessionPresentation(sessionId)).title).toBe(
      "Manual title",
    )
    await store.shutdownThread(sessionId)
    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.sessionPresentation(sessionId)).title).toBe(
      "Manual title",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
