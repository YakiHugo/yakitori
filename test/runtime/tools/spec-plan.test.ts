import { describe, expect, it } from "vitest"
import type { ModelTarget } from "../../../src/runtime/model.ts"
import { createConfiguredModelsManager } from "../../../src/runtime/configured-models-manager.ts"
import { createModelProvider } from "../../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../../src/runtime/tools/spec-plan.ts"
import type { RuntimeTool } from "../../../src/runtime/tools/types.ts"

describe("Step tool planning", () => {
  it.each([
    {
      wireApi: "gemini_generate_content",
      model: "gemini-2.5-pro",
      user: true,
      tool: false,
    },
    {
      wireApi: "gemini_generate_content",
      model: "gemini-2.5-flash",
      user: true,
      tool: false,
    },
    {
      wireApi: "gemini_generate_content",
      model: "gemini-2.5-flash-lite",
      user: true,
      tool: false,
    },
    {
      wireApi: "gemini_generate_content",
      model: "models/gemini-3.8-flash",
      user: true,
      tool: true,
    },
    {
      wireApi: "gemini_generate_content",
      model: "gemini-4-custom",
      user: false,
      tool: false,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-6-astra",
      effort: "high",
      user: true,
      tool: false,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-6.1-sol",
      effort: "low",
      user: true,
      tool: false,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-6-sol",
      effort: "none",
      user: true,
      tool: true,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-6-sol",
      effort: "high",
      user: true,
      tool: false,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-5.1-codex",
      user: false,
      tool: false,
    },
    {
      wireApi: "openai_chat_completions",
      model: "gpt-custom",
      user: false,
      tool: false,
    },
    {
      wireApi: "openai_responses",
      model: "gpt-6-astra",
      user: true,
      tool: true,
    },
    {
      wireApi: "anthropic_messages",
      model: "claude-sonnet-4-6",
      user: true,
      tool: true,
    },
  ] as const)("separates user/tool PDF capability for $wireApi/$model", async (entry) => {
    const provider = "personal"
    const models = createConfiguredModelsManager({
      provider,
      catalogProvider:
        entry.wireApi === "anthropic_messages" ? "anthropic" : "openai",
      wireApi: entry.wireApi,
      models: [
        {
          id: entry.model,
          inputModalities: ["text", "image"],
          efforts: ["none", "low", "high"],
        },
      ],
    })
    const registry = createToolRegistry([])
    const selection = {
      provider,
      model: entry.model,
      ...("effort" in entry ? { effort: entry.effort } : {}),
    }
    const configuration = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "pdf",
      },
      models,
    ).resolveStep(selection, models)
    for (const nativePdf of [true, false]) {
      const step = captureStepContext({
        registry,
        configuration,
        wireApi: entry.wireApi,
        nativePdf,
      })
      expect(step.documentReading.nativePdf).toBe(nativePdf && entry.tool)
      expect(step.userDocumentReading.nativePdf).toBe(nativePdf && entry.user)
      if (
        nativePdf &&
        entry.user &&
        entry.wireApi === "gemini_generate_content"
      ) {
        expect(step.userDocumentReading.nativePdfLimits).toEqual({
          maxFileBytes: 50_000_000,
          maxRequestPages: 1_000,
          maxInlineBytes: 100_000_000,
        })
      }
      if (
        nativePdf &&
        entry.user &&
        entry.wireApi === "openai_chat_completions"
      ) {
        expect(step.userDocumentReading.nativePdfLimits).toEqual({
          maxFileBytes: 50_000_000,
          fileLimitExclusive: true,
          maxRequestBytes: 50_000_000,
        })
      }
      await step.toolRouter.release()
    }
    await registry.dispose()
  })

  it.each([
    target("openai", "gpt-5", "codex"),
    target("anthropic", "claude-sonnet-4-6", "anthropic"),
    target("faux", "model", "default"),
  ])("uses explicit Gemini wire capabilities before legacy provider $provider defaults", async (target) => {
    const registry = createToolRegistry()
    registry.replaceExternalSource("calendar", [externalDeferredTool()])
    const step = captureStepContext({
      registry,
      configuration: configuration(target, registry.trustedToolNames()),
      wireApi: "gemini_generate_content",
    })
    expect(step.toolWireProtocol).toBe("meta_dispatch")
    expect(step.toolRouter.modelDefinitions.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["tool_search", "use_tool"]),
    )
    expect(
      step.toolRouter.modelDefinitions.every((tool) => tool.kind !== "custom"),
    ).toBe(true)
    await step.toolRouter.release()
    await registry.dispose()
  })

  it.each([
    {
      provider: "openai-work",
      catalogProvider: "openai",
      model: "gpt-5",
      wireApi: "openai_responses",
      protocol: "openai_deferred",
      tool: "apply_patch",
    },
    {
      provider: "claude-work",
      catalogProvider: "anthropic",
      model: "claude-sonnet-4-6",
      wireApi: "anthropic_messages",
      protocol: "anthropic_deferred",
      tool: "write_file",
    },
    {
      provider: "openai",
      catalogProvider: "openai",
      model: "gpt-5",
      wireApi: "openai_chat_completions",
      protocol: "meta_dispatch",
      tool: "write_file",
    },
  ] as const)("uses declared $wireApi for connection $provider", async ({
    provider,
    catalogProvider,
    model,
    wireApi,
    protocol,
    tool,
  }) => {
    const models = createConfiguredModelsManager({
      provider,
      catalogProvider,
      wireApi,
      models: [{ id: model }],
    })
    const registry = createToolRegistry()
    registry.replaceExternalSource("calendar", [externalDeferredTool()])
    const client = createProviderRegistry({
      [provider]: createModelProvider({
        info: {
          id: provider,
          wireApi,
          capabilities: { remoteCompaction: false },
        },
        models,
        stream: async function* () {},
      }),
    }).createClient()
    const turn = client.startTurn(provider)
    const selection = { provider, model }
    const configuration = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/workspace",
        enabledTools: registry.trustedToolNames(),
        approvalPolicy: "always_approve",
        promptCacheKey: "configured",
      },
      models,
    ).resolveStep(selection, models)
    const step = captureStepContext({
      registry,
      configuration,
      ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    })
    expect(step.toolWireProtocol).toBe(protocol)
    expect(
      step.toolRouter.modelDefinitions.map((entry) => entry.name),
    ).toContain(tool)
    const toolNames = step.toolRouter.modelDefinitions.map(({ name }) => name)
    expect(toolNames).toContain("view_image")
    expect(step.documentReading.images).toBe(true)
    if (protocol === "openai_deferred")
      expect(
        step.toolRouter.modelDefinitions.find((entry) => entry.name === tool)
          ?.kind,
      ).toBe("custom")
    await step.toolRouter.release()
    await client.close()
  })

  it("keeps image tools disabled for text-only Chat models", async () => {
    const models = createConfiguredModelsManager({
      provider: "text-only",
      wireApi: "openai_chat_completions",
      models: [{ id: "model", inputModalities: ["text"] }],
    })
    const registry = createToolRegistry()
    const selection = { provider: "text-only", model: "model" }
    const config = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/workspace",
        enabledTools: registry.trustedToolNames(),
        approvalPolicy: "always_approve",
        promptCacheKey: "text-only",
      },
      models,
    )
    const step = captureStepContext({
      registry,
      configuration: config.resolveStep(selection, models),
      wireApi: "openai_chat_completions",
    })
    expect(step.documentReading).toEqual({ nativePdf: false, images: false })
    expect(
      step.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toContain("view_image")
    await step.toolRouter.release()
    await registry.dispose()
  })

  it.each([
    {
      target: target("codex", "gpt-5.6-sol", "codex"),
      present: ["apply_patch"],
      absent: ["edit_file", "write_file"],
      protocol: "openai_deferred",
    },
    {
      target: target("openai", "gpt-5", "codex"),
      present: ["apply_patch"],
      absent: ["edit_file", "write_file"],
      protocol: "openai_deferred",
    },
    {
      target: target("OpenAI", "GPT-5", "codex"),
      present: ["apply_patch"],
      absent: ["edit_file", "write_file"],
      protocol: "openai_deferred",
    },
    {
      target: target("anthropic", "claude-sonnet-4-6", "anthropic"),
      present: ["edit_file", "write_file"],
      absent: ["apply_patch"],
      protocol: "anthropic_deferred",
    },
    {
      target: target("grok", "grok-4.6", "grok"),
      present: ["edit_file"],
      absent: ["apply_patch", "write_file"],
      protocol: "meta_dispatch",
    },
    {
      target: target("kimi", "k3", "kimi"),
      present: ["edit_file", "write_file"],
      absent: ["apply_patch"],
      protocol: "meta_dispatch",
    },
  ] as const)("$target.provider/$target.model selects its model capabilities", ({
    target,
    present,
    absent,
    protocol,
  }) => {
    const registry = createToolRegistry()
    const step = captureStepContext({
      registry,
      configuration: configuration(target, registry.trustedToolNames()),
    })
    const names = step.toolRouter.definitions.map(({ name }) => name)

    expect(names).toEqual(expect.arrayContaining([...present]))
    for (const name of absent) expect(names).not.toContain(name)
    expect(step.toolWireProtocol).toBe(protocol)
  })

  it("keeps unknown model capabilities conservative and falls back to meta-dispatch", () => {
    const registry = createToolRegistry()
    const deferred = externalDeferredTool()
    registry.replaceExternalSource("calendar", [deferred])
    const step = captureStepContext({
      registry,
      configuration: configuration(
        target("other", "future-model", "default"),
        registry.trustedToolNames(),
      ),
    })
    const names = step.toolRouter.modelDefinitions.map(({ name }) => name)

    expect(names).toContain("exec_command")
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("edit_file")
    expect(names).toEqual(expect.arrayContaining(["tool_search", "use_tool"]))
    expect(names).not.toContain("calendar__search_events")
    expect(step.toolRouter.search("calendar events")).toMatchObject([
      { name: "calendar__search_events" },
    ])
    expect(step.toolWireProtocol).toBe("meta_dispatch")
  })

  it("keeps Grok's model-visible catalog stable and resolves use_tool through the Step router", () => {
    const registry = createToolRegistry()
    registry.replaceExternalSource("calendar", [externalDeferredTool()])
    const step = captureStepContext({
      registry,
      configuration: configuration(
        target("grok", "grok-4.6", "grok"),
        registry.trustedToolNames(),
      ),
    })
    const names = step.toolRouter.modelDefinitions.map(({ name }) => name)

    expect(names).toEqual(expect.arrayContaining(["tool_search", "use_tool"]))
    expect(names).not.toContain("calendar__search_events")
    expect(
      step.toolRouter.resolveInvocation("use_tool", {
        tool_name: "calendar__search_events",
        tool_input: { query: "planning" },
      }),
    ).toEqual({
      name: "calendar__search_events",
      input: { query: "planning" },
    })
  })

  it("reproduces the same tool bytes after switching away and back", async () => {
    const registry = createToolRegistry()
    const enabledTools = registry.trustedToolNames()
    const codex = target("codex", "gpt-5.6-sol", "codex")
    const first = captureStepContext({
      registry,
      configuration: configuration(codex, enabledTools),
    })
    const firstBytes = JSON.stringify(first.toolRouter.modelDefinitions)
    await first.toolRouter.release()
    const anthropic = captureStepContext({
      registry,
      configuration: configuration(
        target("anthropic", "claude-sonnet-4-6", "anthropic"),
        enabledTools,
      ),
    })
    await anthropic.toolRouter.release()
    const second = captureStepContext({
      registry,
      configuration: configuration(codex, enabledTools),
    })

    expect(JSON.stringify(second.toolRouter.modelDefinitions)).toBe(firstBytes)
  })

  it("keeps external definition order stable across source refresh order", async () => {
    const registry = createToolRegistry()
    registry.replaceExternalSource("calendar", [
      externalDeferredTool("z_events"),
      externalDeferredTool("a_events"),
    ])
    const modelTarget = target("codex", "gpt-5.6-sol", "codex")
    const enabledTools = registry.trustedToolNames()
    const first = captureStepContext({
      registry,
      configuration: configuration(modelTarget, enabledTools),
    })
    const firstBytes = JSON.stringify(first.toolRouter.modelDefinitions)
    await first.toolRouter.release()

    registry.replaceExternalSource("calendar", [
      externalDeferredTool("a_events"),
      externalDeferredTool("z_events"),
    ])
    const second = captureStepContext({
      registry,
      configuration: configuration(modelTarget, enabledTools),
    })

    expect(JSON.stringify(second.toolRouter.modelDefinitions)).toBe(firstBytes)
  })

  it("keeps meta-dispatch and native deferred projections isolated", async () => {
    const registry = createToolRegistry()
    registry.replaceExternalSource("calendar", [externalDeferredTool()])
    const enabledTools = registry.trustedToolNames()
    const kimiTarget = target("kimi", "k3", "kimi")
    const kimi = captureStepContext({
      registry,
      configuration: configuration(kimiTarget, enabledTools),
    })
    expect(kimi.toolRouter.modelDefinitions.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["tool_search", "use_tool"]),
    )
    expect(
      kimi.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toContain("calendar__search_events")
    expect(kimi.toolRouter.search("calendar events")).toMatchObject([
      { name: "calendar__search_events" },
    ])
    await kimi.toolRouter.release()

    const anthropicTarget = target(
      "anthropic",
      "claude-sonnet-4-6",
      "anthropic",
    )
    const anthropic = captureStepContext({
      registry,
      configuration: configuration(anthropicTarget, enabledTools),
    })
    expect(
      anthropic.toolRouter.modelDefinitions.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining(["tool_search", "calendar__search_events"]),
    )
    expect(
      anthropic.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toContain("use_tool")
    await anthropic.toolRouter.release()

    const kimiAgain = captureStepContext({
      registry,
      configuration: configuration(kimiTarget, enabledTools),
    })
    expect(
      kimiAgain.toolRouter.modelDefinitions.map(({ name }) => name),
    ).toEqual(expect.arrayContaining(["tool_search", "use_tool"]))
    expect(
      kimiAgain.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toContain("calendar__search_events")
  })
})

function target(
  provider: string,
  model: string,
  instructionProfileId: string,
): ModelTarget {
  return { provider, model, instructionProfileId }
}

function configuration(
  modelTarget: ModelTarget,
  enabledTools: readonly string[],
) {
  const selection = {
    provider: modelTarget.provider,
    model: modelTarget.model,
    ...(modelTarget.effort === undefined ? {} : { effort: modelTarget.effort }),
    ...(modelTarget.speed === undefined ? {} : { speed: modelTarget.speed }),
  }
  return SessionConfiguration.create({
    selection,
    workspaceRoot: "/workspace",
    enabledTools,
    approvalPolicy: "always_approve",
    promptCacheKey: "step-test",
  }).resolveStep(selection)
}

function externalDeferredTool(name = "search_events"): RuntimeTool {
  return {
    toolName: { namespace: "calendar", name },
    exposure: "deferred",
    description: "Search calendar events",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    effect: "observe",
    approvalRequirement: { kind: "none" },
    async execute() {
      return { ok: true, output: {}, content: "found" }
    },
  }
}
