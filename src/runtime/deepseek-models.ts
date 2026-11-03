import type { ConfiguredModel } from "../protocol/providers.ts"

// Comate lists V4 Pro; the direct vendor catalog confirms it remains served
// as V4-Pro-0813, with text-only input and these exact token limits.
// https://cloud.baidu.com/doc/COMATE/s/emsseobso
// https://api-docs.deepseek.com/api/list-models/
export const deepseekModels: readonly ConfiguredModel[] = [
  {
    id: "deepseek-flash",
    inputModalities: ["text", "image"],
    imageDetailModes: ["high", "original"],
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ["text"],
    imageDetailModes: [],
    // `none` disables thinking; the other values are native effort levels.
    // https://api-docs.deepseek.com/api/create-chat-completion/
    efforts: ["none", "low", "high", "max"],
    defaultEffort: "high",
  },
]
