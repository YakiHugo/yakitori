import { describe, expect, it } from "vitest"
import type { ModelTarget } from "../../../src/runtime/model.ts"
import { resolveModel } from "../../../src/runtime/model-catalog.ts"
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
      protocol: "eager",
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
      target,
      modelInfo: resolveModel(target),
      enabledTools: registry.trustedToolNames(),
    })
    const names = step.toolRouter.definitions.map(({ name }) => name)

    expect(names).toEqual(expect.arrayContaining([...present]))
    for (const name of absent) expect(names).not.toContain(name)
    expect(step.toolWireProtocol).toBe(protocol)
  })

  it("does not infer apply_patch or tool search for an unknown model", () => {
    const registry = createToolRegistry()
    const deferred = externalDeferredTool()
    registry.registerExternal(deferred, "calendar")
    const step = captureStepContext({
      registry,
      target: target("other", "future-model", "default"),
      modelInfo: resolveModel({ provider: "other", model: "future-model" }),
      enabledTools: registry.trustedToolNames(),
    })
    const names = step.toolRouter.modelDefinitions.map(({ name }) => name)

    expect(names).toContain("exec_command")
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("edit_file")
    expect(names).not.toContain("tool_search")
    expect(names).not.toContain("calendar__search_events")
  })

  it("keeps Grok's model-visible catalog stable and resolves use_tool through the Step router", () => {
    const registry = createToolRegistry()
    registry.registerExternal(externalDeferredTool(), "calendar")
    const step = captureStepContext({
      registry,
      target: target("grok", "grok-4.6", "grok"),
      modelInfo: resolveModel({ provider: "grok", model: "grok-4.6" }),
      enabledTools: registry.trustedToolNames(),
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
      target: codex,
      modelInfo: resolveModel(codex),
      enabledTools,
    })
    const firstBytes = JSON.stringify(first.toolRouter.modelDefinitions)
    await first.toolRouter.release()
    const anthropic = captureStepContext({
      registry,
      target: target("anthropic", "claude-sonnet-4-6", "anthropic"),
      modelInfo: resolveModel({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
      enabledTools,
    })
    await anthropic.toolRouter.release()
    const second = captureStepContext({
      registry,
      target: codex,
      modelInfo: resolveModel(codex),
      enabledTools,
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
      target: modelTarget,
      modelInfo: resolveModel(modelTarget),
      enabledTools,
    })
    const firstBytes = JSON.stringify(first.toolRouter.modelDefinitions)
    await first.toolRouter.release()

    registry.replaceExternalSource("calendar", [
      externalDeferredTool("a_events"),
      externalDeferredTool("z_events"),
    ])
    const second = captureStepContext({
      registry,
      target: modelTarget,
      modelInfo: resolveModel(modelTarget),
      enabledTools,
    })

    expect(JSON.stringify(second.toolRouter.modelDefinitions)).toBe(firstBytes)
  })

  it("does not share deferred search catalogs across model capabilities", async () => {
    const registry = createToolRegistry()
    registry.registerExternal(externalDeferredTool(), "calendar")
    const enabledTools = registry.trustedToolNames()
    const kimiTarget = target("kimi", "k3", "kimi")
    const kimi = captureStepContext({
      registry,
      target: kimiTarget,
      modelInfo: resolveModel(kimiTarget),
      enabledTools,
    })
    expect(
      kimi.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toEqual(
      expect.arrayContaining(["tool_search", "calendar__search_events"]),
    )
    await kimi.toolRouter.release()

    const anthropicTarget = target(
      "anthropic",
      "claude-sonnet-4-6",
      "anthropic",
    )
    const anthropic = captureStepContext({
      registry,
      target: anthropicTarget,
      modelInfo: resolveModel(anthropicTarget),
      enabledTools,
    })
    expect(
      anthropic.toolRouter.modelDefinitions.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining(["tool_search", "calendar__search_events"]),
    )
    await anthropic.toolRouter.release()

    const kimiAgain = captureStepContext({
      registry,
      target: kimiTarget,
      modelInfo: resolveModel(kimiTarget),
      enabledTools,
    })
    expect(
      kimiAgain.toolRouter.modelDefinitions.map(({ name }) => name),
    ).not.toEqual(
      expect.arrayContaining(["tool_search", "calendar__search_events"]),
    )
  })
})

function target(
  provider: string,
  model: string,
  instructionProfileId: string,
): ModelTarget {
  return { provider, model, instructionProfileId }
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
