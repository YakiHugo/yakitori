import { expect, it } from "vitest"
import {
  resolveModel,
  resolveModelWireEffort,
} from "../../src/runtime/model-catalog.ts"
import { discoverCodexModels } from "../../src/runtime/model-discovery.ts"
import {
  createDiscoveringModelsManager,
  createStaticModelsManager,
} from "../../src/runtime/models-manager.ts"
import { getModelInstructions } from "../../src/runtime/prompt-registry.ts"

// Metadata verified against openai/codex models.json @ 7e8143a8970394e38830ff7b30143da539bd0a18.
it.each([
  [
    "gpt-6.1-sol",
    272000,
    "6df4f6b6b8d1ce39e103a724d36d77d712c5f8ed518ff7e43270554a3613954f",
  ],
  [
    "gpt-6.1-terra",
    500000,
    "8e5e8f9a863bb360482e4d9fc000f1e4f1a85b1fdab7301dba58b36d1185b707",
  ],
] as const)("provides offline %s metadata without substituting public API limits", async (model, contextWindowTokens, revision) => {
  const manager = createStaticModelsManager("personal", "codex")
  const target = { provider: "personal", model }
  const resolved = manager.resolve(target)
  expect(
    (await manager.listModels()).some((entry) => entry.model === model),
  ).toBe(true)
  expect(resolved).toMatchObject({
    inputModalities: ["text", "image"],
    imageDetailModes: ["high", "original"],
    defaultEffort: "low",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    multiAgentReasoningEffort: "xhigh",
    speeds: ["standard", "fast"],
    shellToolType: "unified_exec",
    applyPatchToolType: "custom",
    supportsNativeToolSearch: true,
    usedFallbackModelMetadata: false,
    toolOutputTruncation: { mode: "tokens", limit: 10000 },
  })
  expect(manager.capacity(target)).toEqual({
    contextWindowTokens,
    maxContextWindowTokens: 872000,
    effectiveContextWindowPercent: 95,
    contextWindowScope: "input",
  })
  expect(() =>
    manager.validate({ ...target, effort: "ultra", speed: "fast" }),
  ).not.toThrow()
  expect(resolveModelWireEffort({ ...target, effort: "ultra" }, resolved)).toBe(
    "xhigh",
  )
  expect(getModelInstructions(resolved).revision).toBe(revision)
  expect(
    resolveModel({ provider: "openai", model }).usedFallbackModelMetadata,
  ).toBe(true)
  expect(
    resolveModel({ provider: "codex", model: `${model}-custom` })
      .usedFallbackModelMetadata,
  ).toBe(true)
})

it.each([
  "gpt-6.1-sol",
  "gpt-6.1-terra",
])("lets fresh %s discovery override bundled image capability and instructions", async (model) => {
  const manager = createDiscoveringModelsManager({
    provider: "personal",
    catalogProvider: "codex",
    identity: async () => "test-account",
    discover: () =>
      discoverCodexModels({
        baseUrl: "https://codex.example",
        accessToken: "test",
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: model,
                  shell_type: "shell_command",
                  apply_patch_tool_type: "freeform",
                  input_modalities: ["text", "image"],
                  supports_image_detail_original: false,
                  context_window: 123456,
                  max_context_window: 234567,
                  model_messages: {
                    instructions_template: "Fresh model-specific instructions",
                  },
                  supported_reasoning_levels: [{ effort: "high" }],
                  default_reasoning_level: "high",
                },
              ],
            }),
          ),
      }),
  })
  await manager.refresh()
  const target = { provider: "personal", model }
  expect(manager.resolve(target)).toMatchObject({
    imageDetailModes: ["high"],
    defaultEffort: "high",
    efforts: ["high"],
  })
  expect(manager.capacity(target)?.contextWindowTokens).toBe(123456)
  expect(getModelInstructions(manager.resolve(target)).text).toBe(
    "Fresh model-specific instructions",
  )
})
