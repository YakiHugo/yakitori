import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import {
  type ModelRequest,
  ModelStopReason,
  type StreamFn,
} from "../../src/runtime/model.ts"
import { validateModelHistoryScope } from "../../src/runtime/model-native.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type ModelFixture = { window: number; hash?: string }

describe("pre-sampling model switches", () => {
  it.each([
    { usage: 100, compacts: false },
    { usage: 100_000, compacts: true },
  ])("continues ordinary history after the previous configured model is removed ($compacts compaction)", async ({
    usage,
    compacts,
  }) => {
    const requests: ModelRequest[] = []
    const harness = await setupConfigured(recordingStream(requests, usage))
    const thread = await harness.manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: inputFixture([
        { type: "text" as const, text: "Original task." },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done model-a" })

    await harness.registration.replace({
      work: harness.provider("work", [
        { id: "model-b", contextWindowTokens: 100_000 },
      ]),
    })
    await thread.startIfIdle({
      content: inputFixture([
        { type: "text" as const, text: "Continue with the available model." },
      ]),
      modelSelection: { provider: "work", model: "model-b" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done model-b" })
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => ({
          provider: request.target.provider,
          model: request.target.model,
          compaction: request.compaction,
        })),
    ).toEqual(
      compacts
        ? [{ provider: "work", model: "model-b", compaction: "local" }]
        : [],
    )
    const history = JSON.stringify(requests.at(-1)?.messages)
    expect(history).toContain(compacts ? "Portable progress" : "Original task.")
    expect(history).toContain("Continue with the available model.")
    expect(thread.snapshot().context.previousModel).toMatchObject({
      provider: "work",
      model: "model-b",
    })
  })

  it.each([
    "model",
    "provider",
  ])("requires restoring a native checkpoint's removed source %s", async (removed) => {
    const requests: ModelRequest[] = []
    let samples = 0
    const stream: StreamFn = async function* (request) {
      requests.push(request)
      if (request.compaction === "codex_remote") {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            providerResponseId: "native_response",
            content: [
              {
                type: "compaction",
                provider: "work",
                model: "model-a",
                scope: "work:account",
                encryptedContent: "opaque checkpoint",
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
          content: [{ type: "text", text: `sample ${samples}` }],
          usage: { activeContextTokens: samples === 1 ? 100_000 : 100 },
        },
      }
    }
    const harness = await setupConfigured(stream, true)
    const thread = await harness.manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "sample 1" })
    await thread.startIfIdle({
      content: inputFixture([
        { type: "text" as const, text: "create checkpoint" },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "sample 2" })
    expect(
      requests.filter((request) => request.compaction === "codex_remote"),
    ).toHaveLength(1)
    const provider = removed === "model" ? "work" : "other"
    await harness.registration.replace({
      [provider]: harness.provider(provider, [
        { id: "model-b", contextWindowTokens: 200_000 },
      ]),
    })
    const callsBeforeSwitch = requests.length
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "continue" }]),
      modelSelection: { provider, model: "model-b" },
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({
        errored:
          "Native checkpoint continuation requires work/model-a. Restore its provider connection and model configuration before continuing.",
      })
    expect(requests).toHaveLength(callsBeforeSwitch)
    expect(thread.snapshot().context.previousModel).toMatchObject({
      provider: "work",
      model: "model-a",
    })
    expect(JSON.stringify(thread.snapshot().context.history)).toContain(
      "opaque checkpoint",
    )
  })

  it.each([
    100_000, 200_000,
  ])("converts an opaque checkpoint through its owner before switching models within the same account to a %i-token window", async (window) => {
    const requests: ModelRequest[] = []
    let samples = 0
    const stream: StreamFn = async function* (request) {
      validateModelHistoryScope(request, "openai_responses")
      requests.push(request)
      if (request.compaction === "codex_remote") {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            providerResponseId: "native_response",
            content: [
              {
                type: "compaction",
                provider: "work",
                model: "model-a",
                scope: "work:account",
                encryptedContent: "opaque checkpoint",
              },
            ],
          },
        }
        return
      }
      if (request.compaction === "local") {
        expect(request.target).toMatchObject({
          provider: "work",
          model: "model-a",
        })
        expect(JSON.stringify(request.messages)).toContain("opaque checkpoint")
        expect(JSON.stringify(request.messages)).not.toContain(
          "Fresh correction",
        )
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "Portable retained progress" }],
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
          usage: { activeContextTokens: samples === 1 ? 100_000 : 100 },
        },
      }
    }
    const harness = await setupConfigured(stream, true)
    const thread = await harness.manager.createThread({
      workingDirectory: harness.root,
      mateId: "mate",
      mateRevisionId: "revision",
    })
    for (const text of ["Original task", "Create checkpoint"]) {
      await thread.startIfIdle({
        content: inputFixture([{ type: "text", text }]),
      })
      await expect
        .poll(() => thread.agentStatus)
        .toEqual({ completed: "done model-a" })
    }
    expect(
      requests.filter((request) => request.compaction === "codex_remote"),
    ).toHaveLength(1)
    await harness.registration.replace({
      work: harness.provider("work", [
        { id: "model-a", contextWindowTokens: 100_000 },
        { id: "model-b", contextWindowTokens: window },
      ]),
    })
    await thread.startIfIdle({
      modelSelection: { provider: "work", model: "model-b" },
      content: inputFixture([
        { type: "text", text: "Fresh correction: continue with model B" },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done model-b" })
    expect(
      requests
        .filter((request) => request.compaction !== undefined)
        .map((request) => [request.target.model, request.compaction]),
    ).toEqual([
      ["model-a", "codex_remote"],
      ["model-a", "local"],
    ])
    const final = requests.at(-1)
    expect(final?.target.model).toBe("model-b")
    expect(JSON.stringify(final?.messages)).toContain(
      "Portable retained progress",
    )
    expect(JSON.stringify(final?.messages)).toContain(
      "Fresh correction: continue with model B",
    )
    expect(JSON.stringify(final?.messages)).not.toContain("opaque checkpoint")
  })

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
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: inputFixture([
        { type: "text" as const, text: "switch provider" },
      ]),
      modelSelection: { provider: "kimi-code", model: "new" },
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
      content: inputFixture([
        { type: "text" as const, text: "Original task." },
      ]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      modelSelection: { provider: "codex", model: "new" },
      content: inputFixture([
        {
          type: "text" as const,
          text: "Fresh correction: keep the public API.",
        },
      ]),
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
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
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
    await resumed.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "continue" }]),
    })
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
          type: "failure",
          failure: {
            kind: "invalid_request",
            stage: "model_event",
            provider: request.target.provider,
            wireApi: "unknown",
            providerCode: "model_not_found",
            status: 404,
            message: "old model retired",
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
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "continue" }]),
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
            type: "failure",
            failure: {
              kind: "invalid_request",
              stage: "model_event",
              provider: request.target.provider,
              wireApi: "unknown",
              providerCode: "not_found",
              status: 404,
              message: "old model retired",
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
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })

    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "switch" }]),
      modelSelection: { provider: "codex", model: "new" },
    })

    await expect
      .poll(() => thread.agentStatus)
      .toEqual({
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
            providerResponseId: "invalid_checkpoint",
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
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "start" }]),
    })
    await expect
      .poll(() => thread.agentStatus)
      .toEqual({ completed: "done old" })
    await thread.startIfIdle({
      content: inputFixture([{ type: "text" as const, text: "switch" }]),
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
      content: inputFixture([{ type: "text" as const, text: "retry switch" }]),
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

async function setupConfigured(stream: StreamFn, remoteCompaction = false) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-configured-switch-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const provider = (
    id: string,
    models: readonly { id: string; contextWindowTokens: number }[],
  ) =>
    createModelProvider({
      info: {
        id,
        wireApi: remoteCompaction
          ? "openai_responses"
          : "openai_chat_completions",
        capabilities: {
          remoteCompaction: remoteCompaction ? "codex_remote" : false,
        },
        retry: { maxAttempts: 1 },
      },
      models: createConfiguredModelsManager({ provider: id, models }),
      continuationScope: `${id}:account`,
      stream,
    })
  const registry = createProviderRegistry()
  const registration = registry.register("test", {
    work: provider("work", [
      {
        id: "model-a",
        contextWindowTokens: remoteCompaction ? 100_000 : 200_000,
      },
      { id: "model-b", contextWindowTokens: 100_000 },
    ]),
  })
  const manager = new ThreadManager({
    store: new JsonlThreadStore({ root }),
    createTurnProcessor: () =>
      createTurnProcessor({
        modelClient: registry.createClient(),
        provider: "work",
        model: "model-a",
        loadProjectInstructions: async () => undefined,
      }),
  })
  cleanups.push(() => manager.shutdown())
  return { root, manager, registration, provider }
}

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
    if (request.compaction === "codex_remote") {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          providerResponseId: "compaction_response",
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
      ["codex", "kimi-code"].map((provider) => {
        const base = createStaticModelsManager(provider)
        return [
          provider,
          createModelProvider({
            info: {
              id: provider,
              wireApi: "openai_responses",
              capabilities: {
                remoteCompaction: provider === "codex" ? "codex_remote" : false,
              },
              retry: { maxAttempts: 1 },
            },
            stream,
            models: {
              ...base,
              capture() {
                return this
              },
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
                  contextWindowScope: "input",
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
