import type { ConfiguredModel } from "../protocol/providers.ts"

// Standard international API IDs; Comate's GLM-5.0 display name maps to glm-5.
// https://cloud.baidu.com/doc/COMATE/s/emsseobso
// https://docs.z.ai/guides/llm/glm-4.7
// https://docs.z.ai/guides/llm/glm-5
// https://docs.z.ai/guides/llm/glm-5.1
// https://docs.z.ai/guides/llm/glm-5.2
export const glmModels: readonly ConfiguredModel[] = [
  { id: "glm-5.3" },
  {
    id: "glm-5.3-flash",
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    efforts: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    id: "glm-5.2",
    // Conservative decimal budget for the documented 1M context.
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
    imageDetailModes: [],
    // API accepts these aliases: none/minimal skip thinking, low/medium map
    // to high and xhigh maps to max. Older models use only the thinking toggle.
    // https://docs.z.ai/api-reference/llm/chat-completion
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  ...["glm-5.1", "glm-5", "glm-4.7"].map((id) => ({
    id,
    // Vendor pages give 200K/1M context, without exact integer units. These
    // conservative decimal budgets do not infer a larger binary hard limit.
    contextWindowTokens: 200_000,
    maxOutputTokens: 131_072,
    inputModalities: ["text"] as const,
    imageDetailModes: [],
    efforts: [],
  })),
]

export function glmTextModel(model: string): ConfiguredModel | undefined {
  return glmModels.find(
    (entry) =>
      entry.id === model &&
      entry.inputModalities?.length === 1 &&
      entry.inputModalities[0] === "text",
  )
}
