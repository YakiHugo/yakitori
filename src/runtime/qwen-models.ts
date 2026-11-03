import type { ConfiguredModel } from "../protocol/providers.ts"

// Qwen-owned preset union in Qwen Code, checked 2026-11-03:
// https://github.com/QwenLM/qwen-code/tree/c26a32006a82d516eeb83640f8fc3a4f1243707b/packages/core/src/providers/presets
// Modalities are checked against the exact model, not inferred from a series:
// https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models
// https://help.aliyun.com/zh/model-studio/qwen3-7-max
// Endpoint/region/plan availability is separate from these model capabilities.
export const qwenModels: readonly ConfiguredModel[] = [
  ...["qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash"].map((id) => ({
    id,
    contextWindowTokens: 1_000_000,
    inputModalities: ["text", "image"] as const,
    imageDetailModes: ["high"] as const,
    // Common documented Chat Completions levels across DashScope/QwenCloud.
    efforts: ["low", "medium", "xhigh"],
    defaultEffort: "xhigh",
  })),
  ...["qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash", "qwen3.5-plus"].map(
    (id) => ({
      id,
      contextWindowTokens: 1_000_000,
      inputModalities: ["text", "image"] as const,
      imageDetailModes: ["high"] as const,
      // Older models use enable_thinking, not reasoning_effort levels.
      efforts: [],
    }),
  ),
  {
    // The alias is the text-only 2026-05-20 model, not the visual 06-08 snapshot.
    id: "qwen3.7-max",
    contextWindowTokens: 1_000_000,
    inputModalities: ["text"],
    efforts: [],
  },
  // Still present in Qwen Code's older Coding Plan preset, but not in the
  // current plan's advertised list. Keep explicit configuration possible
  // without presenting these legacy entries as current recommendations.
  {
    id: "qwen3-coder-plus",
    defaultVisible: false,
    contextWindowTokens: 1_000_000,
    inputModalities: ["text"],
    efforts: [],
  },
  {
    id: "qwen3-coder-next",
    defaultVisible: false,
    contextWindowTokens: 262_144,
    inputModalities: ["text"],
    efforts: [],
  },
  {
    id: "qwen3-max-2026-01-23",
    defaultVisible: false,
    contextWindowTokens: 262_144,
    inputModalities: ["text"],
    efforts: [],
  },
]

export function isQwenVisionModel(model: string): boolean {
  return qwenModels.some(
    (entry) => entry.id === model && entry.inputModalities?.includes("image"),
  )
}

export function isQwenTextModel(model: string): boolean {
  return qwenModels.some(
    (entry) => entry.id === model && !entry.inputModalities?.includes("image"),
  )
}
