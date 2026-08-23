import { describe, expect, it } from "vitest"
import { createModelDirectory } from "../../src/server/model-directory.ts"

describe("model directory", () => {
  it("projects OpenAI models without inferring capabilities", async () => {
    const directory = createModelDirectory()

    expect(await directory.listModels("openai")).toEqual([
      {
        id: "gpt-5.1-codex",
        displayName: "gpt-5.1-codex",
        instructionProfileId: "codex",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      {
        id: "gpt-5",
        displayName: "gpt-5",
        instructionProfileId: "codex",
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ])
  })

  it("uses the explicit Grok catalog entries", async () => {
    const directory = createModelDirectory()

    expect(await directory.listModels("grok")).toEqual([
      {
        id: "grok-4.6",
        displayName: "Grok 4.6",
        instructionProfileId: "grok",
        efforts: ["low", "medium", "high", "xhigh"],
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      {
        id: "grok-4.5",
        displayName: "Grok 4.5",
        instructionProfileId: "grok",
        efforts: ["low", "medium", "high"],
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
    ])
  })

  it("preserves Codex picker order and per-model options", async () => {
    const directory = createModelDirectory()
    const models = await directory.listModels("codex")

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ])
    expect(models[0]).toEqual({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      instructionProfileId: "codex",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      speeds: ["standard", "fast"],
      inputModalities: ["text", "image"],
      imageDetailModes: ["high", "original"],
    })
    expect(models.at(-1)).toEqual({
      id: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      instructionProfileId: "codex",
      efforts: ["low", "medium", "high", "xhigh"],
      inputModalities: ["text"],
      imageDetailModes: [],
    })
  })

  it("is case-insensitive and returns no speculative unknown models", async () => {
    const directory = createModelDirectory()

    expect(await directory.listModels("KIMI")).toHaveLength(4)
    expect(await directory.listModels("unknown")).toEqual([])
  })
})
