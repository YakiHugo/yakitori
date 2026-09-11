import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  ModelStopReason,
  type ModelCompactionBlock,
  type ModelRequest,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const checkpoint: ModelCompactionBlock = {
  type: "compaction",
  provider: "codex",
  model: "gpt-5.6-sol",
  scope: "codex:account",
  id: "cmp_one",
  encryptedContent: "opaque-checkpoint",
}

function nativeItems(request: ModelRequest) {
  return request.messages.flatMap((item) =>
    item.role === "assistant"
      ? item.content.filter((block) => block.type === "compaction")
      : [],
  )
}

describe("provider-native compaction history", () => {
  it("bounds remote stream retries even after provisional output", async () => {
    let attempts = 0
    const provider = createModelProvider({
      info: {
        id: "codex",
        wireApi: "openai_responses",
        capabilities: { remoteCompaction: true },
        retry: { maxAttempts: 10, sleep: async () => {} },
      },
      stream: async function* () {
        attempts += 1
        yield { type: "snapshot", text: "provisional output" }
        yield {
          type: "failure",
          failure: {
            kind: "server_error",
            stage: "model_event",
            provider: "codex",
            wireApi: "openai_responses",
            providerCode: "transient",
            message: "retry",
          },
        }
      },
    })
    const client = provider.createClient()
    const session = client.startTurn()
    const events = []
    try {
      for await (const event of session.stream({
        compaction: "remote_v2",
        target: {
          provider: "codex",
          model: "gpt-5.6-sol",
          instructionProfileId: "codex",
        },
        system: [],
        messages: [],
        tools: [],
        toolWireProtocol: "eager",
      }))
        events.push(event)
    } finally {
      await session.close()
      await client.close()
    }
    expect(attempts).toBe(3)
    expect(events.filter((event) => event.type === "failure")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "server_error" },
    })
  })
  it("samples after one compaction even if the replacement still estimates above the trigger", async () => {
    let normalCalls = 0
    let compactions = 0
    const stream: StreamFn = async function* (request) {
      if (request.compaction !== undefined) {
        compactions += 1
        if (compactions > 1)
          throw new Error("Repeated compaction without sampling")
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ ...checkpoint, encryptedContent: "x".repeat(400_000) }],
            providerRequestId: "resp_big",
          },
        }
        return
      }
      normalCalls += 1
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: `sample ${normalCalls}` }],
          usage: { activeContextTokens: normalCalls === 1 ? 59_000 : 100 },
        },
      }
    }
    const harness = await setup(stream)
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "sample 1" })
    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "sample 2" })
    expect(compactions).toBe(1)
  })
  it("restores the native checkpoint and converts it through its owner before a cross-provider Turn", async () => {
    const requests: ModelRequest[] = []
    let normalCalls = 0
    const stream: StreamFn = async function* (request) {
      requests.push(request)
      if (request.compaction === "remote_v2") {
        expect(request.target.provider).toBe("codex")
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [checkpoint],
            providerRequestId: "resp_compact",
            usage: { inputTokens: 59_000, outputTokens: 20 },
          },
        }
        return
      }
      if (request.compaction === "local") {
        expect(request.target.provider).toBe("codex")
        expect(nativeItems(request)).toEqual([checkpoint])
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [
              {
                type: "text",
                text: "Portable progress: keep the public API unchanged.",
              },
            ],
          },
        }
        return
      }
      normalCalls += 1
      if (normalCalls === 2 || normalCalls === 3)
        expect(nativeItems(request)).toEqual([checkpoint])
      if (request.target.provider === "kimi") {
        expect(nativeItems(request)).toEqual([])
        expect(JSON.stringify(request.messages)).toContain("Portable progress")
        expect(JSON.stringify(request.messages)).toContain(
          "Do not change the public API.",
        )
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: `done ${normalCalls}` }],
          usage: { activeContextTokens: normalCalls === 1 ? 59_000 : 100 },
        },
      }
    }
    const harness = await setup(stream)
    const manager = harness.manager()
    const thread = await manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: { kind: "text", text: "Do not change the public API." },
    })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done 1" })
    await thread.startIfIdle({ content: { kind: "text", text: "Continue." } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done 2" })
    const stored = await harness.store.readThread(thread.id)
    const compacted = stored?.rollout.find(
      ({ item }) => item.type === "compacted",
    )
    expect(compacted?.item).toMatchObject({
      type: "compacted",
      summary: "",
      replacement: expect.arrayContaining([
        expect.objectContaining({
          item: { role: "assistant", content: [checkpoint] },
        }),
      ]),
    })
    if (stored === undefined || compacted === undefined)
      throw new Error("missing persisted checkpoint")
    const sequence = stored.rollout
      .slice(stored.rollout.indexOf(compacted))
      .map(({ item }) => item.type)
    expect(sequence.slice(0, 3)).toEqual([
      "compacted",
      "token_count",
      "item_completed",
    ])
    expect(sequence.indexOf("world_state")).toBeGreaterThan(2)
    expect(sequence.indexOf("model_context")).toBeGreaterThan(
      sequence.indexOf("world_state"),
    )
    expect(stored.rollout.at(-1)?.item).toMatchObject({
      type: "turn_completed",
      usage: { inputTokens: 59_000, outputTokens: 20 },
    })
    await manager.shutdown()
    const resumedManager = harness.manager()
    const resumed = await resumedManager.resumeThread(thread.id)
    if (resumed === undefined) throw new Error("missing restored thread")
    await resumed.startIfIdle({
      content: { kind: "text", text: "Continue after restart." },
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "done 3" })
    await resumed.startIfIdle({
      content: { kind: "text", text: "Continue with Kimi." },
      modelSelection: { provider: "kimi", model: "kimi-k2.5" },
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "done 4" })
    expect(
      requests.filter((request) => request.compaction === "remote_v2"),
    ).toHaveLength(1)
    expect(
      requests.filter((request) => request.compaction === "local"),
    ).toHaveLength(1)
  })

  it.each([
    "missing",
    "duplicate",
    "failed",
  ])("keeps the old history after a %s native checkpoint response", async (failure) => {
    const stream: StreamFn = async function* (request) {
      if (request.compaction === undefined) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "old assistant state" }],
            usage: { activeContextTokens: 59_000 },
          },
        }
        return
      }
      if (failure === "failed") {
        yield {
          type: "failure",
          failure: {
            kind: "provider_error",
            stage: "model_event",
            provider: "codex",
            wireApi: "openai_responses",
            providerCode: "unavailable",
            message: "compaction failed",
          },
        }
        return
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content:
            failure === "missing"
              ? []
              : failure === "duplicate"
                ? [checkpoint, checkpoint]
                : [checkpoint],
          providerRequestId: "resp_failed",
        },
      }
    }
    const harness = await setup(stream)
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: { kind: "text", text: "original request" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "old assistant state" })
    await thread.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect.poll(() => thread.agentStatus).toHaveProperty("errored")
    expect(JSON.stringify(thread.snapshot().context.history)).toContain(
      "old assistant state",
    )
    const stored = await harness.store.readThread(thread.id)
    expect(stored?.rollout.some(({ item }) => item.type === "compacted")).toBe(
      false,
    )
    expect(
      stored?.rollout.some(
        ({ item }) =>
          item.type === "item_completed" &&
          item.item.type === "context_compaction" &&
          item.item.status === "failed",
      ),
    ).toBe(true)
  })
})

async function setup(stream: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-native-compact-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const store = new JsonlThreadStore({ root })
  const registry = createProviderRegistry(
    Object.fromEntries(
      ["codex", "kimi"].map((id) => [
        id,
        createModelProvider({
          info: {
            id,
            wireApi: id === "codex" ? "openai_responses" : "anthropic_messages",
            capabilities: { remoteCompaction: id === "codex" },
            retry: { maxAttempts: 1 },
          },
          stream,
          continuationScope: `${id}:account`,
        }),
      ]),
    ),
  )
  return {
    root,
    store,
    manager() {
      const manager = new ThreadManager({
        store,
        createTurnProcessor: () =>
          createTurnProcessor({
            modelClient: registry.createClient(),
            provider: "codex",
            model: "gpt-5.6-sol",
            modelContextWindowTokens: 60_000,
            loadProjectInstructions: async () => undefined,
          }),
      })
      cleanups.push(() => manager.shutdown())
      return manager
    },
  }
}
