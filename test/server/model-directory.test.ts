import { describe, expect, it } from "vitest"
import {
  createModelProvider,
  createProviderRegistry,
} from "../../src/runtime/index.ts"
import { createModelDirectory } from "../../src/server/model-directory.ts"

describe("model directory", () => {
  it("is case-insensitive and returns no speculative unknown models", async () => {
    const directory = createModelDirectory()

    const kimi = await directory.listModels("KIMI")
    expect(kimi).toHaveLength(4)
    expect(kimi.map((model) => model.effortStyle)).toEqual([
      "none",
      "none",
      "levels",
      "levels",
    ])
    expect(await directory.listModels("unknown")).toEqual([])
  })

  it("projects provider-owned models in their declared order with exact options and optional fields", async () => {
    const registry = createProviderRegistry({
      custom: createModelProvider({
        info: {
          id: "custom",
          wireApi: "unknown",
          capabilities: { remoteCompaction: false },
        },
        stream: async function* () {},
        models: {
          provider: "custom",
          async refresh() {},
          async listModels() {
            return [
              {
                model: "remote-model",
                displayName: "Remote Model",
                instructionProfileId: "default",
                inputModalities: ["text", "image"],
                imageDetailModes: ["high", "original"],
                effortStyle: "levels",
                efforts: ["low", "high"],
                defaultEffort: "high",
                speeds: ["standard", "fast"],
                shellToolType: "unified_exec",
                fileEditingToolType: "none",
                supportsNativeToolSearch: false,
              },
              {
                model: "minimal-model",
                instructionProfileId: "default",
                inputModalities: ["text"],
                imageDetailModes: [],
                effortStyle: "none",
                shellToolType: "unified_exec",
                fileEditingToolType: "none",
                supportsNativeToolSearch: false,
              },
            ]
          },
          resolve() {
            throw new Error("not used")
          },
          validate() {},
          capacity({ model }) {
            return model === "remote-model"
              ? {
                  contextWindowTokens: 1007,
                  maxContextWindowTokens: 1007,
                  effectiveContextWindowPercent: 95,
                  contextWindowScope: "input",
                }
              : undefined
          },
        },
      }),
    })

    await expect(
      createModelDirectory(registry).listModels("custom"),
    ).resolves.toEqual([
      {
        id: "remote-model",
        displayName: "Remote Model",
        instructionProfileId: "default",
        effectiveContextWindowTokens: 956,
        effortStyle: "levels",
        efforts: ["low", "high"],
        defaultEffort: "high",
        speeds: ["standard", "fast"],
        inputModalities: ["text", "image"],
        imageDetailModes: ["high", "original"],
      },
      {
        id: "minimal-model",
        displayName: "minimal-model",
        instructionProfileId: "default",
        effortStyle: "none",
        inputModalities: ["text"],
        imageDetailModes: [],
      },
    ])
  })
})
