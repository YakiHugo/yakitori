import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

it.each([
  "local",
  "remote_v2",
] as const)("%s compaction summarizes a loaded skill while preserving the user's request through reload", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-compaction-"))
  const skillDir = join(root, ".agents", "skills", "review")
  await mkdir(skillDir, { recursive: true })
  const body = `SKILL BODY\n${"x".repeat(260_000)}`
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: review\ndescription: Review parser changes\n---\n${body}`,
  )
  const userRequest =
    "Use $review to fix the parser. Keep the public API and error messages unchanged."
  let normalCalls = 0
  const requests: ModelRequest[] = []
  const stream: StreamFn = async function* (request) {
    requests.push(request)
    if (request.compaction !== undefined) {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content:
            mode === "local"
              ? [{ type: "text", text: "Parser review checkpoint." }]
              : [
                  {
                    type: "compaction",
                    provider: "faux",
                    model: "scripted",
                    scope: "test",
                    id: "checkpoint",
                    encryptedContent: "opaque",
                  },
                ],
          providerRequestId: "compacted_response",
        },
      }
      return
    }
    normalCalls += 1
    yield {
      type: "response",
      response: {
        stopReason: ModelStopReason.EndTurn,
        content: [
          { type: "text", text: normalCalls === 1 ? "reviewed" : "continued" },
        ],
      },
    }
  }
  const registry = createProviderRegistry({
    faux: createModelProvider({
      info: {
        id: "faux",
        wireApi: "unknown",
        capabilities: { remoteCompaction: mode === "remote_v2" },
        retry: { maxAttempts: 1 },
      },
      stream,
      continuationScope: "test",
    }),
  })
  const start = () => {
    const store = new JsonlThreadStore({ root: join(root, "store") })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "faux",
          model: "scripted",
          modelContextWindowTokens: 1_000_000,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    return { store, manager }
  }
  let runtime = start()
  try {
    const thread = await runtime.manager.createThread({
      workingDirectory: root,
      mateId: "mate_test",
      mateRevisionId: "revision_test",
    })
    await thread.startIfIdle({ content: { kind: "text", text: userRequest } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "reviewed" })
    const original = thread
      .snapshot()
      .context.history.find(
        ({ item }) =>
          item.role === "user" &&
          item.context === undefined &&
          item.content.some(
            (block) => block.type === "text" && block.text === userRequest,
          ),
      )
    expect(original).toBeDefined()
    await thread.compact("compact_skills")
    await expect.poll(() => thread.agentStatus).toEqual({ completed: null })
    const compactionRequest = requests.find(
      (request) => request.compaction !== undefined,
    )
    expect(compactionRequest?.compaction).toBe(mode)
    const skill = compactionRequest?.messages.find(
      (message) =>
        message.role === "user" && message.context?.type === "skill_invocation",
    )
    expect(
      skill?.role === "user" &&
        skill.content.some(
          (block) => block.type === "text" && block.text.includes(body),
        ),
    ).toBe(true)
    const stored = await runtime.store.readThread(thread.id)
    const compacted = stored?.rollout.find(
      ({ item }) => item.type === "compacted",
    )?.item
    if (compacted?.type !== "compacted")
      throw new Error("Missing persisted checkpoint")
    expect(compacted.replacement).toContainEqual(original)
    expect(JSON.stringify(compacted.replacement)).not.toContain("SKILL BODY")
    expect(
      stored?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "user" &&
          item.item.item.context?.type === "skill_invocation",
      ),
    ).toBe(true)

    await runtime.manager.shutdown()
    runtime = start()
    const resumed = await runtime.manager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("Missing restored thread")
    expect(resumed.snapshot().context.history).toContainEqual(original)
    await resumed.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "continued" })
    expect(
      requests.filter((request) => request.compaction !== undefined),
    ).toHaveLength(1)
    expect(normalCalls).toBe(2)
    for (const request of requests) {
      expect(request.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: userRequest }],
        }),
      )
    }
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "SKILL BODY",
    )
  } finally {
    await runtime.manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
