import type { ConfiguredModel } from "../protocol/providers.ts"

// TRAE's first-party Seed entries, checked against Ark's exact API IDs.
// https://docs.trae.cn/enterprise_model-settings-for-trae-enterprise
// https://docs.volcengine.com/docs/ark/model-list?lang=zh
// Keep the existing Pro snapshot; do not infer a Seed Code API model ID.
export const doubaoModels: readonly ConfiguredModel[] = [
  {
    id: "doubao-seed-evolving",
    displayName: "Doubao Seed Evolving",
    // Ark publishes 1024k/256k but examples mix decimal and binary units.
    // Use the smaller budgets, not an inferred exact provider hard limit.
    contextWindowTokens: 1_024_000,
    maxOutputTokens: 256_000,
  },
  {
    id: "doubao-seed-2-1-pro-260915",
    displayName: "Doubao Seed 2.1 Pro",
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 262_144,
  },
  {
    id: "doubao-seed-2-1-turbo-260628",
    displayName: "Doubao Seed 2.1 Turbo",
    contextWindowTokens: 256_000,
    maxOutputTokens: 256_000,
  },
].map((model) => ({
  ...model,
  // Only still images are adapted here, not Ark's video/audio input.
  inputModalities: ["text", "image"],
  imageDetailModes: ["high"],
  // Ark accepts all seven levels; none maps to minimal, xhigh/max to high.
  // https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
}))

export function isDoubaoVisionModel(model: string): boolean {
  return doubaoModels.some((entry) => entry.id === model)
}
