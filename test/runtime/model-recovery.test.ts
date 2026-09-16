import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { ModelMessage, StreamFn } from "../../src/runtime/model.ts"
import { createModelRequestStream } from "../../src/runtime/model-request.ts"
import {
  createToolRegistry,
  plainToolName,
} from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

const testUserHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testUserHome.path,
}))

it("recovers a model request without replaying a completed tool or duplicating its durable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-recovery-"))
  testUserHome.path = root
  const effectFile = join(root, "effect.txt")
  const histories: (readonly ModelMessage[])[] = []
  const provider: StreamFn = async function* (request) {
    histories.push(structuredClone(request.messages))
    if (histories.length === 1) {
      yield {
        type: "response",
        response: {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_call",
              id: "effect_call",
              name: "record_effect",
              input: {},
            },
          ],
        },
      }
      return
    }
    if (histories.length === 2) {
      yield {
        type: "failure",
        failure: {
          kind: "idle_timeout",
          stage: "response_body",
          provider: "faux",
          wireApi: "unknown",
          message: "Stream idle timeout",
        },
      }
      return
    }
    yield {
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    }
  }
  const stream = createModelRequestStream(provider, {
    wireApi: "unknown",
    maxAttempts: 2,
    sleep: async () => {},
  })
  const toolRegistry = createToolRegistry([
    {
      toolName: plainToolName("record_effect"),
      description: "Record a local effect",
      inputSchema: { type: "object" },
      effect: "mutate",
      approvalRequirement: { kind: "none" },
      async execute() {
        await appendFile(effectFile, "effect\n")
        return { ok: true, output: "recorded", content: "recorded" }
      },
    },
  ])
  const storeRoot = join(root, "store")
  const store = new JsonlThreadStore({ root: storeRoot })
  await store.initialize()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () =>
      createTurnProcessor({
        stream,
        toolRegistry,
        provider: "faux",
        model: "faux",
        loadProjectInstructions: async () => undefined,
      }),
  })
  try {
    const thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    await thread.startIfIdle({
      content: { kind: "text", text: "Record the effect and finish." },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    await manager.shutdown()

    expect(await readFile(effectFile, "utf8")).toBe("effect\n")
    expect(histories).toHaveLength(3)
    expect(histories[1]).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "effect_call",
        content: "recorded",
      }),
    )
    expect(histories[2]).toEqual(histories[1])
    const reopenedStore = new JsonlThreadStore({ root: storeRoot })
    await reopenedStore.initialize()
    const stored = await reopenedStore.readThread(thread.id)
    expect(
      stored?.rollout.filter(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "tool" &&
          item.item.item.toolCallId === "effect_call",
      ),
    ).toHaveLength(1)
    expect(
      stored?.rollout
        .filter(({ item }) => item.type === "turn_completed")
        .map(({ item }) => item),
    ).toEqual([expect.objectContaining({ outcome: "completed" })])
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
