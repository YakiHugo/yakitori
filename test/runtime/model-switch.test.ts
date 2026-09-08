import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import {
  ModelStopReason,
  type ModelRequest,
  type StreamFn,
} from "../../src/runtime/model.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type ModelFixture = { window: number; hash?: string }

describe("pre-sampling model switches", () => {
  it("uses the previous provider for a portable checkpoint when switching to a smaller foreign model", async () => {
    const requests: ModelRequest[] = []
    const harness = await setup(
      { old: { window: 200_000 }, new: { window: 100_000 } },
      recordingStream(requests, 100_000),
    )
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: { kind: "text", text: "switch provider" },
      modelSelection: { provider: "kimi", model: "new" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done new" })
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => [
          request.target.provider,
          request.target.model,
          request.compaction,
        ]),
    ).toEqual([["codex", "old", "local"]])
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "Portable progress",
    )
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "encryptedContent",
    )
  })
  it.each([
    {
      name: "different compatibility hashes",
      first: { window: 200_000, hash: "one" },
      second: { window: 200_000, hash: "two" },
      usage: 1_000,
      compact: "old",
    },
    {
      name: "a smaller window that no longer fits",
      first: { window: 200_000 },
      second: { window: 100_000 },
      usage: 100_000,
      compact: "old",
    },
    {
      name: "exactly the target trigger",
      first: { window: 200_000 },
      second: { window: 100_000 },
      usage: 90_000,
      compact: "new",
    },
    {
      name: "matching compatibility hashes",
      first: { window: 200_000, hash: "same" },
      second: { window: 200_000, hash: "same" },
      usage: 1_000,
    },
    {
      name: "a missing previous hash",
      first: { window: 200_000 },
      second: { window: 200_000, hash: "new" },
      usage: 1_000,
    },
    {
      name: "a missing target hash",
      first: { window: 200_000, hash: "old" },
      second: { window: 200_000 },
      usage: 1_000,
    },
    {
      name: "a smaller window that still fits",
      first: { window: 200_000 },
      second: { window: 100_000 },
      usage: 1_000,
    },
  ])("handles $name without including fresh input in the checkpoint request", async ({
    first,
    second,
    usage,
    compact,
  }) => {
    const requests: ModelRequest[] = []
    const stream = recordingStream(requests, usage)
    const harness = await setup({ old: first, new: second }, stream)
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: { kind: "text", text: "Original task." },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      modelSelection: { provider: "codex", model: "new" },
      content: { kind: "text", text: "Fresh correction: keep the public API." },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done new" })
    const compactions = requests.filter(
      (request) => request.compaction !== undefined,
    )
    expect(compactions.map((request) => request.target.model)).toEqual(
      compact === undefined ? [] : [compact],
    )
    for (const request of compactions) {
      expect(JSON.stringify(request.messages)).toContain("Original task.")
      expect(JSON.stringify(request.messages)).not.toContain("Fresh correction")
    }
    const final = requests.at(-1)
    expect(JSON.stringify(final?.messages)).toContain(
      "Fresh correction: keep the public API.",
    )
    expect(thread.snapshot().context.previousModel).toEqual({
      provider: "codex",
      model: "new",
      ...(second.hash === undefined ? {} : { compactionHash: second.hash }),
    })
  })

  it("restores the previous hash and detects a compatibility change under the same model name", async () => {
    const models: Record<string, ModelFixture> = {
      old: { window: 200_000, hash: "first" },
    }
    const requests: ModelRequest[] = []
    const harness = await setup(models, recordingStream(requests, 100))
    const manager = harness.manager()
    const thread = await manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await manager.shutdown()
    models.old = { window: 200_000, hash: "second" }
    const resumed = await harness.manager().resumeThread(thread.id)
    if (resumed === undefined) throw new Error("missing resumed thread")
    expect(resumed.snapshot().context.previousModel?.compactionHash).toBe(
      "first",
    )
    await resumed.startIfIdle({ content: { kind: "text", text: "continue" } })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "done old" })
    expect(
      requests.filter((request) => request.compaction !== undefined),
    ).toHaveLength(1)
    expect(resumed.snapshot().context.previousModel?.compactionHash).toBe(
      "second",
    )
  })

  it("retries model-specific remote failure with the target model under one compaction lifecycle", async () => {
    const requests: ModelRequest[] = []
    const goodStream = recordingStream(requests, 100)
    const stream: StreamFn = async function* (request) {
      if (request.compaction !== undefined && request.target.model === "old") {
        requests.push(request)
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.Error,
            content: [],
            error: {
              code: "model_not_found",
              message: "old model retired",
              details: { status: 404 },
            },
          },
        }
        return
      }
      yield* goodStream(request)
    }
    const harness = await setup(
      {
        old: { window: 200_000, hash: "first" },
        new: { window: 200_000, hash: "second" },
      },
      stream,
    )
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: { kind: "text", text: "continue" },
      modelSelection: { provider: "codex", model: "new" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done new" })
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => request.target.model),
    ).toEqual(["old", "new"])
    const stored = await harness.store.readThread(thread.id)
    expect(
      stored?.rollout
        .filter(
          ({ item }) =>
            item.type === "item_completed" &&
            item.item.type === "context_compaction",
        )
        .map(({ item }) => item),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ status: "completed" }),
      }),
    ])
  })

  it("reports the source compaction failure when the target fallback also fails", async () => {
    const requests: ModelRequest[] = []
    const normal = recordingStream(requests, 100)
    const stream: StreamFn = async function* (request) {
      if (request.compaction !== undefined) {
        requests.push(request)
        if (request.target.model === "old") {
          yield {
            type: "response",
            response: {
              stopReason: ModelStopReason.Error,
              content: [],
              error: {
                code: "not_found",
                message: "old model retired",
                details: { status: 404 },
              },
            },
          }
          return
        }
        throw new Error("target fallback failed")
      }
      yield* normal(request)
    }
    const harness = await setup(
      {
        old: { window: 200_000, hash: "first" },
        new: { window: 200_000, hash: "second" },
      },
      stream,
    )
    const thread = await harness.manager().createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect.poll(() => thread.agentStatus).toEqual({ completed: "done old" })

    await thread.startIfIdle({
      content: { kind: "text", text: "switch" },
      modelSelection: { provider: "codex", model: "new" },
    })

    await expect.poll(() => thread.agentStatus).toEqual({
      errored: "old model retired",
    })
  })

  it("does not advance previous-model state after an invalid checkpoint, so restart retries the switch", async () => {
    const requests: ModelRequest[] = []
    let fail = true
    const goodStream = recordingStream(requests, 100)
    const stream: StreamFn = async function* (request) {
      if (request.compaction !== undefined && fail) {
        requests.push(request)
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [],
            providerRequestId: "invalid_checkpoint",
          },
        }
        return
      }
      yield* goodStream(request)
    }
    const harness = await setup(
      {
        old: { window: 200_000, hash: "one" },
        new: { window: 200_000, hash: "two" },
      },
      stream,
    )
    const manager = harness.manager()
    const thread = await manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({ content: { kind: "text", text: "start" } })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: { kind: "text", text: "switch" },
      modelSelection: { provider: "codex", model: "new" },
    })
    await expect.poll(() => thread.agentStatus).toHaveProperty("errored")
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => request.target.model),
    ).toEqual(["old"])
    await manager.shutdown()
    fail = false
    const resumed = await harness.manager().resumeThread(thread.id)
    if (resumed === undefined) throw new Error("missing resumed thread")
    expect(resumed.snapshot().context.previousModel?.model).toBe("old")
    await resumed.startIfIdle({
      content: { kind: "text", text: "retry switch" },
    })
    await expect
      .poll(() => resumed.agentStatus)
      .toEqual({ completed: "done new" })
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => request.target.model),
    ).toEqual(["old", "old"])
  })
})

function recordingStream(requests: ModelRequest[], usage: number): StreamFn {
  let samples = 0
  return async function* (request) {
    requests.push(request)
    if (request.compaction === "local") {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Portable progress" }],
        },
      }
      return
    }
    if (request.compaction === "remote_v2") {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          providerRequestId: "compaction_response",
          content: [
            {
              type: "compaction",
              provider: "codex",
              model: request.target.model,
              scope: "codex:account",
              encryptedContent: "checkpoint",
            },
          ],
        },
      }
      return
    }
    samples += 1
    yield {
      type: "response",
      response: {
        stopReason: ModelStopReason.EndTurn,
        content: [{ type: "text", text: `done ${request.target.model}` }],
        usage: { activeContextTokens: samples === 1 ? usage : 100 },
      },
    }
  }
}

async function setup(fixtures: Record<string, ModelFixture>, stream: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-switch-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const store = new JsonlThreadStore({ root })
  const registry = createProviderRegistry(
    Object.fromEntries(
      ["codex", "kimi"].map((provider) => {
        const base = createStaticModelsManager(provider)
        return [
          provider,
          createModelProvider({
            info: {
              id: provider,
              wireApi: "openai_responses",
              capabilities: { remoteCompaction: provider === "codex" },
              retry: { maxAttempts: 1 },
            },
            stream,
            models: {
              ...base,
              validate() {},
              resolve(selection) {
                const fixture = fixtures[selection.model]
                if (fixture === undefined)
                  throw new Error("unknown fixture model")
                return {
                  ...base.resolve({
                    provider,
                    model: provider === "codex" ? "gpt-5.6-sol" : "kimi-k2.5",
                  }),
                  model: selection.model,
                  ...(fixture.hash === undefined
                    ? {}
                    : { compactionHash: fixture.hash }),
                }
              },
              capacity(selection) {
                const fixture = fixtures[selection.model]
                if (fixture === undefined)
                  throw new Error("unknown fixture model")
                return {
                  contextWindowTokens: fixture.window,
                  maxContextWindowTokens: fixture.window,
                  effectiveContextWindowPercent: 100,
                }
              },
            },
          }),
        ]
      }),
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
            model: "old",
            loadProjectInstructions: async () => undefined,
          }),
      })
      cleanups.push(() => manager.shutdown())
      return manager
    },
  }
}
