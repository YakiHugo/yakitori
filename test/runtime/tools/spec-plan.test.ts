import { describe, expect, it } from "vitest"
import type { ModelTarget } from "../../../src/runtime/model.ts"
import { SessionConfiguration } from "../../../src/runtime/session-configuration.ts"
import {
  createToolRegistry,
  namespacedToolName,
} from "../../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../../src/runtime/tools/spec-plan.ts"
import type { RuntimeTool } from "../../../src/runtime/tools/types.ts"

describe("Step tool planning", () => {
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
    registry.registerExternal(deferred, "calendar")
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
    registry.registerExternal(externalDeferredTool(), "calendar")
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
    registry.registerExternal(externalDeferredTool(), "calendar")
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
    toolName: namespacedToolName("calendar", name),
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
