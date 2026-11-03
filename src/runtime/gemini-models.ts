import type { ConfiguredModel } from "../protocol/providers.ts"

// Exact Gemini CLI model IDs, verified against its model definitions at
// 0ac57c029b848d109eef940afe0db4b5a0c3dad0 (2026-11-03):
// https://github.com/google-gemini/gemini-cli/blob/0ac57c029b848d109eef940afe0db4b5a0c3dad0/packages/core/src/config/models.ts
// https://github.com/google-gemini/gemini-cli/blob/0ac57c029b848d109eef940afe0db4b5a0c3dad0/schemas/settings.schema.json
// API capability/lifecycle takes precedence over the CLI's rollout defaults:
// https://ai.google.dev/gemini-api/docs/models
// https://ai.google.dev/gemini-api/docs/deprecations
// https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
// Do not infer capabilities from a Gemini/Gemma prefix or expose CLI routing
// aliases (auto/pro/flash/none, or Code Assist's gemini-3-flash) as API models.
const gemini3Models = [
  "gemini-3.8-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  // Canonical API target of the CLI's 3.5 Flash alias.
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
] as const

// 3.5 Flash remains an API alias routed by Google to 3.6 Flash. Keep its exact
// requested ID; account availability still comes from GET /models.
const currentModels = [
  ...gemini3Models,
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
] as const

// All 2.5 models are restricted to existing active users. Flash-Lite is not
// deprecated, but is not a new-account default either.
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite
const existingUserModels = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const

// Retain facts for explicitly saved configurations without advertising retired
// endpoints to new connections or silently rewriting the selected ID.
const retiredModels = [
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite-preview",
] as const

const models: readonly ConfiguredModel[] = [
  ...currentModels.map((id) => ({
    id,
    inputModalities: ["text", "image"] as const,
    imageDetailModes: ["high"] as const,
    ...(id === "gemma-4-31b-it" || id === "gemma-4-26b-a4b-it"
      ? { efforts: ["minimal", "high"] }
      : {}),
  })),
  ...[...existingUserModels, ...retiredModels].map((id) => ({
    id,
    defaultVisible: false,
    inputModalities: ["text", "image"] as const,
    imageDetailModes: ["high"] as const,
  })),
]

export const geminiPresetModels = models.filter(
  (model) => model.defaultVisible !== false,
)

export function geminiModelMetadata(
  model: string,
): ConfiguredModel | undefined {
  return models.find((entry) => entry.id === model.replace(/^models\//, ""))
}

// Gemini 3 supports nested binary function responses. Gemma 4 and Gemini 2.5
// accept images as user parts instead, even though both are vision models.
// https://ai.google.dev/gemini-api/docs/function-calling#multimodal
const nativeToolImageModels = new Set<string>([
  ...gemini3Models,
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite-preview",
])

export function supportsGeminiToolImages(model: string): boolean {
  return nativeToolImageModels.has(model.replace(/^models\//, ""))
}
