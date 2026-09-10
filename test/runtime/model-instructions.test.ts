import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import type { ModelRequest, StreamFn } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createDiscoveringModelsManager } from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

it("persists discovered model instructions before sampling and updates them across resume and model switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-instructions-"))
  const store = new JsonlThreadStore({ root })
  const requests: ModelRequest[] = []
  let revision = 1
  const models = createDiscoveringModelsManager({
    provider: "codex",
    ttlMs: 0,
    discover: async () => [
      {
        id: "gpt-6-astra",
        instructions: `Astra instructions revision ${revision}`,
      },
      { id: "gpt-5.6-sol", instructions: "Sol specific instructions" },
    ],
  })
  const stream: StreamFn = async function* (request) {
    const stored = await store.readThread(threadId)
    // The request must have a durable explanation for the prompt it sends.
    expect(JSON.stringify(stored?.rollout)).toContain(
      request.target.model === "gpt-6-astra"
        ? `Astra instructions revision ${revision}`
        : "Sol specific instructions",
    )
    requests.push(request)
    yield {
      type: "response",
      response: {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    }
  }
  const registry = createProviderRegistry({
    codex: createModelProvider({
      info: {
        id: "codex",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: false },
        retry: { maxAttempts: 1 },
      },
      models,
      stream,
    }),
  })
  const makeManager = () =>
    new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "codex",
          model: "gpt-6-astra",
          loadProjectInstructions: async () => undefined,
        }),
    })
  let manager = makeManager()
  let threadId = ""
  try {
    let thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    threadId = thread.id
    await thread.startIfIdle({
      content: { kind: "text", text: "first request" },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "Astra instructions revision 1",
    )
    const pinnedBase = requests[0]?.system

    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(
      JSON.stringify(requests[1]?.messages).match(
        /Astra instructions revision 1/g,
      ),
    ).toHaveLength(1)

    await manager.shutdown()
    revision = 2
    manager = makeManager()
    const resumed = await manager.resumeThread(threadId)
    if (resumed === undefined) throw new Error("Stored thread was not resumed")
    thread = resumed
    await thread.startIfIdle({
      content: { kind: "text", text: "resumed request" },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(requests[2]?.system).toEqual(pinnedBase)
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      "Astra instructions revision 2",
    )

    await thread.startIfIdle({
      content: { kind: "text", text: "switch model" },
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(requests[3]?.target.model).toBe("gpt-5.6-sol")
    expect(JSON.stringify(requests[3]?.messages)).toContain(
      "Sol specific instructions",
    )
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ["codex", "gpt-6-astra"],
  ["kimi", "k3-256k"],
  ["grok", "grok-4.6"],
])("keeps %s request prefixes stable across tools, turns, and restart", async (provider, model) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-cache-prefix-"))
  const store = new JsonlThreadStore({ root })
  const requests: ModelRequest[] = []
  const stream: StreamFn = async function* (request) {
    const { signal: _signal, ...stableRequest } = request
    requests.push(structuredClone(stableRequest))
    yield {
      type: "response",
      response:
        requests.length === 1
          ? {
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_call",
                  id: "read_rules",
                  name: "read_file",
                  input: { path: "rules.txt" },
                },
              ],
            }
          : {
              stopReason: "end_turn",
              content: [{ type: "text", text: "done" }],
            },
    }
  }
  const registry = createProviderRegistry({
    [provider]: createModelProvider({
      info: {
        id: provider,
        wireApi: "unknown",
        capabilities: { remoteCompaction: false },
        retry: { maxAttempts: 1 },
      },
      stream,
    }),
  })
  const makeManager = () =>
    new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider,
          model,
          loadProjectInstructions: async () => undefined,
        }),
    })
  let manager = makeManager()
  try {
    await writeFile(join(root, "rules.txt"), "Stable reference material.")
    let thread = await manager.createThread({
      workingDirectory: root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: { kind: "text", text: "Read rules.txt" },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(requests).toHaveLength(2)
    expect(
      requests[1]?.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes("Stable reference material."),
      ),
    ).toBe(true)
    await thread.startIfIdle({ content: { kind: "text", text: "Continue" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    const threadId = thread.id
    await manager.shutdown()
    manager = makeManager()
    const resumed = await manager.resumeThread(threadId)
    if (resumed === undefined) throw new Error("Thread was not resumed")
    thread = resumed
    await thread.startIfIdle({
      content: { kind: "text", text: "Continue after restart" },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done" })
    expect(requests).toHaveLength(4)
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]
      const current = requests[index]
      if (previous === undefined || current === undefined)
        throw new Error("Missing captured request")
      expect(current.cacheKey).toBe(threadId)
      expect(current.target).toEqual(previous.target)
      expect(current.system).toEqual(previous.system)
      expect(current.tools).toEqual(previous.tools)
      expect(current.messages.slice(0, previous.messages.length)).toEqual(
        previous.messages,
      )
    }
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
