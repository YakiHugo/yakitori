import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import type { ModelSelection } from "../../src/kernel/events.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createDiscoveringModelsManager } from "../../src/runtime/models-manager.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createThreadCollaboration } from "../../src/runtime/thread-collaboration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createFauxProvider } from "../support/faux-provider.ts"

const target = { provider: "faux", model: "scripted" }
const context = {
  target,
  readModels: async () => ({
    current: { ...target, instructionProfileId: "default" },
    models: [{ ...target }],
    resolve: (selection: ModelSelection) => selection,
  }),
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-thread-creation-"))
  const provider = createFauxProvider([
    { content: [{ type: "text", text: "parent answer" }] },
    { content: [{ type: "text", text: "independent answer" }] },
    { content: [{ type: "text", text: "followup answer" }] },
  ])
  const start = () => {
    const store = new JsonlThreadStore({ root })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const service = createThreadCollaboration({
      store,
      getThreadManager: () => manager,
    })
    return { store, manager, service }
  }
  const first = start()
  const configuration = SessionConfiguration.create({
    selection: target,
    workspaceRoot: process.cwd(),
    promptCacheKey: "parent-cache",
    enabledTools: [],
    approvalPolicy: "auto_file_tools",
  }).snapshot
  const source = await first.manager.createThread({
    title: "Source",
    workingDirectory: process.cwd(),
    projectId: "project",
    mateId: "mate",
    mateRevisionId: "revision",
    initialConfiguration: configuration,
  })
  await source.startIfIdle({ content: createUserInput("parent-only history") })
  await expect.poll(() => source.status).toBe("idle")
  return {
    ...first,
    root,
    source,
    provider,
    start,
    async cleanup() {
      await first.manager.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("independent session creation", () => {
  it.each([
    false,
    true,
  ])("rebuilds target model settings while preserving explicit session policy (custom instructions: %s)", async (customInstructions) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-target-configuration-"))
    const sourceSelection = { provider: "source-account", model: "large" }
    const workerSelection = {
      provider: "worker-account",
      model: "claude-sonnet-4-6",
      effort: "low",
    }
    const sourceModels = createConfiguredModelsManager({
      provider: sourceSelection.provider,
      models: [
        {
          id: "large",
          contextWindowTokens: 1_000_000,
          maxContextWindowTokens: 1_000_000,
        },
      ],
    })
    const workerModels = createDiscoveringModelsManager({
      provider: workerSelection.provider,
      catalogProvider: "anthropic",
      identity: async () => "worker",
      discover: async () => [
        {
          id: workerSelection.model,
          contextWindowTokens: 128_000,
          maxContextWindowTokens: 128_000,
          instructions: "TARGET_MODEL_RULES",
          maxOutputTokens: 8192,
          autoCompactTokenLimit: 64_000,
          efforts: ["low", "high"],
          defaultEffort: "low",
        },
      ],
    })
    await workerModels.refresh()
    const worker = createFauxProvider([
      { content: [{ type: "text", text: "worker completed" }] },
    ])
    const registry = createProviderRegistry(
      Object.fromEntries(
        (
          [
            [sourceSelection.provider, sourceModels],
            [workerSelection.provider, workerModels],
          ] as const
        ).map(([provider, models]) => {
          return [
            provider,
            createModelProvider({
              info: {
                id: provider,
                serviceId: `${provider}-service`,
                wireApi: "anthropic_messages",
                capabilities: { remoteCompaction: false },
              },
              models,
              stream: worker.stream,
            }),
          ]
        }),
      ),
    )
    const store = new JsonlThreadStore({ root })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    try {
      const sourceConfiguration = SessionConfiguration.create(
        {
          selection: sourceSelection,
          workspaceRoot: process.cwd(),
          promptCacheKey: "source-cache",
          enabledTools: [],
          approvalPolicy: "auto_file_tools",
          executionPolicy: {
            modelVisibleToolResultBytes: 4096,
            modelVisibleToolResultLines: 100,
            assistantResponseBytes: 128_000,
          },
          modelContextWindowTokens: 600_000,
          modelAutoCompactTokenLimit: 10,
          modelAutoCompactTokenLimitScope: "body_after_prefix",
          modelTransport: { maxAttempts: 11 },
          ...(customInstructions
            ? { baseInstructions: "User policy for independent tasks." }
            : {}),
        },
        sourceModels,
      ).snapshot
      const source = await manager.createThread({
        workingDirectory: process.cwd(),
        mateId: "mate",
        mateRevisionId: "revision",
        initialConfiguration: {
          ...sourceConfiguration,
          serviceId: "source-service",
        },
      })
      const control = createThreadCollaboration({
        store,
        getThreadManager: () => manager,
      }).bind(source.id, {
        target: sourceSelection,
        models: (provider) => registry.models(provider),
        readModels: async () => ({
          current: sourceSelection,
          models: [
            {
              provider: workerSelection.provider,
              model: workerSelection.model,
              efforts: ["low", "high"],
              defaultEffort: "low",
            },
          ],
          resolve(selection) {
            registry.models(selection.provider).validate(selection)
            return selection
          },
        }),
      })
      const created = await control.create({
        requestId: "target-configuration",
        message: "work",
        model: `${workerSelection.provider}/${workerSelection.model}`,
      })
      expect(await control.wait([created], 5_000)).toMatchObject({
        results: [{ status: "completed" }],
      })
      expect(worker.requests).toHaveLength(1)
      expect(worker.requests[0]).toMatchObject({
        target: workerSelection,
        maxOutputTokens: 8192,
      })
      expect(
        worker.requests[0]?.system.find(
          (section) => section.id === "base.instructions",
        )?.text,
      ).toBe(
        customInstructions
          ? "User policy for independent tasks."
          : "TARGET_MODEL_RULES",
      )
      const childConfiguration = manager
        .getThread(created.threadId)
        ?.snapshot().configuration
      if (childConfiguration === undefined)
        throw new Error("Expected initialized child configuration")
      expect(childConfiguration).toMatchObject({
        approvalPolicy: "auto_file_tools",
        enabledTools: [],
        serviceId: "worker-account-service",
        modelChoice: workerSelection,
        executionPolicyDefaults: {
          modelVisibleToolResultBytes: 4096,
          modelVisibleToolResultLines: 100,
          assistantResponseBytes: 128_000,
        },
      })
      expect(childConfiguration).not.toHaveProperty("modelContextWindowTokens")
      expect(childConfiguration).not.toHaveProperty(
        "modelAutoCompactTokenLimit",
      )
      expect(childConfiguration).not.toHaveProperty("modelTransport")
      const step = SessionConfiguration.restore(
        childConfiguration,
        workerModels,
      ).resolveStep(workerSelection, workerModels)
      expect(step.modelInstructions.text).toBe("TARGET_MODEL_RULES")
      expect(step.modelCapacity).toMatchObject({ contextWindowTokens: 128_000 })
      expect(step.autoCompact).toEqual({ limitTokens: 64_000, scope: "total" })
      expect(source.snapshot().configuration).toMatchObject({
        modelContextWindowTokens: 600_000,
        modelAutoCompactTokenLimit: 10,
      })
    } finally {
      await manager.shutdown()
      await registry.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("inherits execution settings without history, deduplicates concurrent retries and tracks results across restart", async () => {
    const f = await fixture()
    try {
      const control = f.service.bind(f.source.id, context)
      const request = {
        requestId: "new-task",
        message: "new task",
        title: "Independent",
      }
      const [created, duplicate] = await Promise.all([
        control.create(request),
        control.create(request),
      ])
      expect(duplicate).toEqual(created)
      expect(await control.wait([created], 5_000)).toMatchObject({
        results: [{ status: "completed", consumed: true }],
      })
      expect(f.provider.callCount).toBe(2)
      expect(JSON.stringify(f.provider.requests[1]?.messages)).not.toContain(
        "parent-only history",
      )
      const child = f.manager.getThread(created.threadId)?.snapshot()
      expect(child?.metadata).toMatchObject({
        conversationId: created.threadId,
        workingDirectory: process.cwd(),
        projectId: "project",
        mateId: "mate",
        mateRevisionId: "revision",
      })
      expect(child?.metadata).not.toHaveProperty("parentThreadId")
      expect(child?.configuration).toMatchObject({
        approvalPolicy: "auto_file_tools",
        promptCacheKey: created.threadId,
        executionPolicyDefaults:
          f.source.snapshot().configuration?.executionPolicyDefaults,
      })
      expect(await control.list()).toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({ threadId: created.threadId }),
        ]),
      })
      await expect(
        control.create({ ...request, model: "faux/scripted" }),
      ).rejects.toMatchObject({ code: "request_conflict" })

      await f.manager.shutdown()
      const restarted = f.start()
      try {
        const recovered = restarted.service.bind(f.source.id, {
          ...context,
          // Retries use the original persisted choice, even if discovery is offline.
          readModels: async () => {
            throw new Error("catalog unavailable")
          },
        })
        expect(await recovered.create(request)).toMatchObject({
          ...created,
          delivery: "replayed",
        })
        expect(await recovered.wait([created], 0)).toMatchObject({
          results: [{ status: "completed" }],
        })
        expect(
          JSON.stringify(
            await recovered.read({
              threadId: created.threadId,
              turnId: created.turnId,
            }),
          ),
        ).toContain("independent answer")
        expect(f.provider.callCount).toBe(2)
        const followup = await recovered.send({
          threadId: created.threadId,
          requestId: "followup",
          message: "continue",
        })
        expect(await recovered.wait([followup], 5_000)).toMatchObject({
          results: [{ status: "completed" }],
        })
        expect(f.provider.requests[2]?.target).toMatchObject(target)
        expect(await restarted.store.listThreadIds()).toHaveLength(2)
        expect(f.source.status).toBe("shutdown")
      } finally {
        await restarted.manager.shutdown()
      }
    } finally {
      await f.cleanup()
    }
  })

  it("rejects unavailable models and unsupported efforts before creating a session", async () => {
    const f = await fixture()
    try {
      const control = f.service.bind(f.source.id, context)
      for (const overrides of [
        { model: "other/scripted" },
        { reasoningEffort: "high" },
      ]) {
        await expect(
          control.create({
            requestId: "invalid",
            message: "work",
            ...overrides,
          }),
        ).rejects.toMatchObject({ code: "invalid_tool_input" })
      }
      expect(await f.store.listThreadIds()).toEqual([f.source.id])
      expect(f.provider.callCount).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it("requires an initialized source policy before creating an independent session", async () => {
    const f = await fixture()
    try {
      const source = await f.manager.createThread({
        workingDirectory: process.cwd(),
        mateId: "mate",
        mateRevisionId: "revision",
      })
      const before = await f.store.listThreadIds()
      await expect(
        f.service
          .bind(source.id, context)
          .create({ requestId: "uninitialized", message: "work" }),
      ).rejects.toMatchObject({ code: "source_not_initialized" })
      expect(await f.store.listThreadIds()).toEqual(before)
      expect(f.provider.callCount).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it("does not create a task when the source is cancelled during model discovery", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const creation = f.service
        .bind(f.source.id, {
          ...context,
          signal: controller.signal,
          async readModels() {
            entered.resolve()
            await release.promise
            return context.readModels()
          },
        })
        .create({ requestId: "cancelled", message: "work" })
      await entered.promise
      controller.abort()
      release.resolve()
      await expect(creation).rejects.toMatchObject({ name: "AbortError" })
      expect(await f.store.listThreadIds()).toEqual([f.source.id])
      expect(f.provider.callCount).toBe(1)
    } finally {
      release.resolve()
      await f.cleanup()
    }
  })

  it("does not let a subagent escape the bounded spawn graph", async () => {
    const f = await fixture()
    try {
      const child = await f.manager.createThread({
        parentThreadId: f.source.id,
        metadata: { agent: { kind: "subagent" } },
      })
      await expect(
        f.service
          .bind(child.id, context)
          .create({ requestId: "escape", message: "work" }),
      ).rejects.toMatchObject({ code: "source_is_subagent" })
      expect(f.provider.callCount).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it("resumes a saved configuration when creation stops before initial task admission", async () => {
    const f = await fixture()
    try {
      const control = createThreadCollaboration({
        store: f.store,
        getThreadManager: () => f.manager,
        onCreated() {
          throw new Error("stopped before task admission")
        },
      }).bind(f.source.id, context)
      const request = { requestId: "partial", message: "work" }
      await expect(control.create(request)).rejects.toThrow(
        "stopped before task admission",
      )
      const childId = (await f.store.listThreadIds()).find(
        (id) => id !== f.source.id,
      )
      if (childId === undefined) throw new Error("Expected saved configuration")
      const stored = await f.store.readThread(childId)
      if (stored === undefined) throw new Error("Expected created session")
      expect(
        stored.rollout.some(
          ({ item }) => item.type === "thread_message_admitted",
        ),
      ).toBe(false)
      expect(f.provider.callCount).toBe(1)
      await f.manager.shutdown()
      const restarted = f.start()
      try {
        const recovered = restarted.service.bind(f.source.id, {
          ...context,
          readModels: async () => {
            throw new Error("catalog unavailable")
          },
        })
        const admitted = await recovered.create(request)
        expect(admitted).toMatchObject({
          threadId: childId,
          delivery: "started",
        })
        expect(await recovered.wait([admitted], 5_000)).toMatchObject({
          results: [{ status: "completed" }],
        })
        expect(await recovered.create(request)).toMatchObject({
          threadId: childId,
          delivery: "replayed",
        })
        expect(
          (await restarted.manager.resumeThread(childId))?.snapshot()
            .configuration?.approvalPolicy,
        ).toBe("auto_file_tools")
        expect(f.provider.callCount).toBe(2)
      } finally {
        await restarted.manager.shutdown()
      }
    } finally {
      await f.cleanup()
    }
  })
})
