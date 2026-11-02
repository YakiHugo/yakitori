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
// OAuth transport, model prefix, or fallback model metadata.
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
  if (
    input.serviceId !== "openai" ||
    input.wireApi !== "openai_responses" ||
    input.model.usedFallbackModelMetadata
  )
    return undefined
  const model = input.model.model
  const modernOriginal = [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ].includes(model)
  if (
    !modernOriginal &&
    !["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].includes(model)
  )
    return undefined

  return (image, stage) => {
    if (!input.model.inputModalities.includes("image")) return 0
    // Yakitori serializes absent detail as high, never the API's auto default.
    const original =
      image.detail === "original" &&
      (stage === "prepared" ||
        input.model.imageDetailModes.includes("original"))
    const maxDimension = original
      ? modernOriginal
        ? 65_535
        : 6_000
      : model === "gpt-6-astra"
        ? 65_535
        : 2_048
    const patchBudget = original ? (modernOriginal ? undefined : 10_000) : 2_500
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
    // Except native Astra, inline raw history still goes through the 2048-edge high
    // preparation before transport. Account for that projection without
    // rewriting history. Prepared inline bytes already have their wire size.
    const projectedMaxDimension =
      stage === "history" && !original && model !== "gpt-6-astra"
        ? Math.min(maxDimension, 2048)
        : maxDimension
    const edgeScale = Math.min(
      1,
      projectedMaxDimension / Math.max(dimensions.width, dimensions.height),
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
