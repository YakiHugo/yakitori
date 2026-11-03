import { openAIVisionPolicy } from "./openai-vision-models.ts"
import { readImageDimensions } from "../kernel/image-metadata.ts"
import type { ModelImageBlock, ModelWireApi } from "./model.ts"
import type { ResolvedModel } from "./model-catalog.ts"

export type ImageTokenEstimator = (
  image: ModelImageBlock,
  stage: "history" | "prepared",
) => number

// Public Responses vision rules, verified 2026-11-02:
// https://developers.openai.com/api/docs/guides/images-vision
// These are estimates for context planning, not billing or image admission.
// Do not infer this policy from a connection ID, compatible protocol, Codex
// OAuth transport or model prefix.
export function openAIImageTokenEstimator(input: {
  serviceId?: string | undefined
  wireApi?: ModelWireApi | undefined
  model: Pick<
    ResolvedModel,
    | "model"
    | "usedFallbackModelMetadata"
    | "inputModalities"
    | "imageDetailModes"
  >
}): ImageTokenEstimator | undefined {
  if (input.serviceId !== "openai" || input.wireApi !== "openai_responses")
    return undefined
  // Exact visual facts are independently verified even when unrelated prompt,
  // tools or context metadata remains fallback. Unknown IDs still have no policy.
  const policy = openAIVisionPolicy(input.model.model)
  if (policy === undefined) return undefined

  return (image, stage) => {
    if (!input.model.inputModalities.includes("image")) return 0
    // Yakitori serializes absent detail as high, never the API's auto default.
    const original =
      image.detail === "original" &&
      (stage === "prepared" ||
        input.model.imageDetailModes.includes("original"))
    const maxDimension = original
      ? policy.originalMaxDimension
      : policy.highMaxDimension
    const patchBudget = original ? policy.originalPatchBudget : 2500
    const dimensions =
      image.data === undefined
        ? undefined
        : readImageDimensions(
            Buffer.from(image.data, "base64"),
            image.mediaType,
          )
    // A URL/file without decoded dimensions is not a small image. Reserve the
    // known detail's maximum admitted patch count; do not fetch during budgeting.
    if (dimensions === undefined)
      return Math.ceil((patchBudget ?? 30_000) * 1.2)
    const edgeScale = Math.min(
      1,
      maxDimension / Math.max(dimensions.width, dimensions.height),
    )
    let width = Math.max(1, Math.round(dimensions.width * edgeScale))
    let height = Math.max(1, Math.round(dimensions.height * edgeScale))
    let patches = Math.ceil(width / 32) * Math.ceil(height / 32)
    if (patchBudget !== undefined && patches > patchBudget) {
      let scale = Math.sqrt((32 * 32 * patchBudget) / (width * height))
      const across = (width * scale) / 32
      const down = (height * scale) / 32
      scale *= Math.min(Math.floor(across) / across, Math.floor(down) / down)
      width = Math.max(1, Math.floor(width * scale))
      height = Math.max(1, Math.floor(height * scale))
      patches = Math.ceil(width / 32) * Math.ceil(height / 32)
    }
    // Modern original has a rejection ceiling, NOT a resizing budget. Capping
    // its estimate would conceal oversized input; the provider owns admission.
    return Math.ceil(patches * 1.2)
  }
}
