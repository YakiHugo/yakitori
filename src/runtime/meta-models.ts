import type { ConfiguredModel } from "../protocol/providers.ts"

// Muse Code's API-accessible Standard models, checked 2026-11-03:
// https://dev.meta.ai/docs/models
// https://dev.meta.ai/docs/reasoning
// Wonder Full is subscription-only, not an alias for API Wonder + max effort.
export const metaModels: readonly ConfiguredModel[] = [
  { id: "muse-spark-1.3", displayName: "Muse Spark 1.3" },
  { id: "muse-wonder-1.0", displayName: "Muse Wonder 1.0" },
  { id: "muse-spark-1.2", displayName: "Muse Spark 1.2" },
].map((model) => ({
  ...model,
  contextWindowTokens: 1_048_576,
  contextWindowScope: "total",
  inputModalities: ["text", "image"],
  imageDetailModes: ["high"],
  efforts:
    model.id === "muse-spark-1.2"
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : ["minimal", "low", "medium", "high", "xhigh", "max"],
}))

export function isMetaVisionModel(model: string): boolean {
  return metaModels.some((entry) => entry.id === model)
}

// Selecting these IDs permits Meta to train on prompts, code, files and replies.
// Do not expose or execute them until a separate informed opt-in flow exists.
// https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode
export function isMetaContributorModel(model: string): boolean {
  return (
    model === "muse-spark-1.3-contributor" ||
    model === "muse-spark-1.2-contributor"
  )
}
