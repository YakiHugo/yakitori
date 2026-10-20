import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import type { ModelContentBlock, StreamFn } from "../../src/runtime/model.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnLoop } from "../../src/runtime/turn-loop.ts"

it("preserves output order and identities through live delivery, persistence, and final-answer recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-output-"))
  const content: ModelContentBlock[] = [
    {
      type: "reasoning",
      representation: "summary",
      text: "**Inspecting output**",
    },
    {
      type: "text",
      purpose: "commentary",
      text: "Checking the implementation.",
    },
    {
      type: "reasoning",
      representation: "summary",
      text: "**Checking persistence**",
    },
    { type: "text", purpose: "final_answer", text: "The final conclusion." },
  ]
  const stream: StreamFn = async function* () {
    yield {
      type: "reasoning_delta",
      itemId: "response",
      text: "**Inspecting output**",
      partIndex: 0,
    }
    yield {
      type: "delta",
      itemId: "response",
      text: "Checking the implementation.",
      partIndex: 0,
      purpose: "commentary",
    }
    yield {
      type: "reasoning_delta",
      itemId: "response",
      text: "**Checking persistence**",
      partIndex: 1,
    }
    yield {
      type: "delta",
      itemId: "response",
      text: "The final conclusion.",
      partIndex: 1,
      purpose: "final_answer",
    }
    yield { type: "output_item", itemId: "response", content }
    yield { type: "response", response: { stopReason: "end_turn", content } }
  }
  const store = new JsonlThreadStore({ root: join(root, "store") })
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnLoop({ stream, toolRegistry: createToolRegistry([]) }),
  })
  let restarted: ThreadManager | undefined
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      submissionId: "turn",
      content: createUserInput("Check output"),
    })
    const liveIds: string[] = []
    for (;;) {
      const event = await thread.nextEvent()
      if (event?.type === "model.stream") liveIds.push(event.itemId)
      if (event?.type === "turn.failed") throw new Error(event.error.message)
      if (event?.type === "turn.completed") break
    }
    expect(thread.agentStatus).toEqual({ completed: "The final conclusion." })
    const stored = await store.readThread(thread.id)
    if (stored === undefined) throw new Error("Missing persisted thread")
    const completed = stored.rollout.flatMap(({ item }) =>
      item.type === "item_completed" &&
      (item.item.type === "reasoning" || item.item.type === "agent_message")
        ? [item.item]
        : [],
    )
    expect(completed.map((item) => item.type)).toEqual([
      "reasoning",
      "agent_message",
      "reasoning",
      "agent_message",
    ])
    expect(new Set(completed.map((item) => item.itemId)).size).toBe(4)
    expect(liveIds).toEqual(completed.map((item) => item.itemId))
    expect(new Set(completed.map((item) => item.source?.callId)).size).toBe(1)
    expect(
      completed.every((item) => item.source?.callId.startsWith("model_call_")),
    ).toBe(true)
    await manager.shutdown()
    restarted = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnLoop({ stream, toolRegistry: createToolRegistry([]) }),
    })
    const recovered = await restarted.resumeThread(thread.id)
    expect(recovered?.agentStatus).toEqual({
      completed: "The final conclusion.",
    })
    const search = await store.searchThreads({
      searchTerm: "Checking the implementation",
      limit: 10,
    })
    expect(search.matches).toEqual([])
  } finally {
    await restarted?.shutdown()
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
