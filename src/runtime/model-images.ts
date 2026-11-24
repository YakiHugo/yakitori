import type { RolloutAssetReference } from "../core/asset-types.ts"
import type {
  ModelMessage,
  ModelTarget,
  ModelUserContentBlock,
  ModelToolContentBlock,
  ModelImageBlock,
  ModelTextBlock,
} from "./model.ts"
import {
  catalogModelCapabilities,
  type ModelCapabilities,
} from "./model-catalog.ts"

const TOOL_IMAGE_CONTEXT_SAFETY_LIMIT = 4

export type ModelImageAdaptation = Readonly<{
  messages: readonly ModelMessage[]
  omittedImageCount: number
  downgradedOriginalCount: number
}>

export function adaptImagesForModel(
  messages: readonly ModelMessage[],
  target: ModelTarget,
  capabilities: Pick<
    ModelCapabilities,
    "imageDetailModes" | "inputModalities"
  > = catalogModelCapabilities(target),
  resolveRolloutImagePath?: (reference: RolloutAssetReference) => string,
): ModelImageAdaptation {
  const supportsImages = capabilities.inputModalities.includes("image")
  const supportsOriginal = capabilities.imageDetailModes.includes("original")
  const shouldDowngradeOriginal = supportsImages && !supportsOriginal
  let omittedImageCount = 0
  let downgradedOriginalCount = 0
  let earlierToolImages =
    messages.reduce(
      (count, message) =>
        message.role === "tool"
          ? count +
            message.content.filter((block) => block.type === "image").length
          : count,
      0,
    ) - TOOL_IMAGE_CONTEXT_SAFETY_LIMIT

  const adaptContent = <
    T extends ModelUserContentBlock | ModelToolContentBlock,
  >(
    blocks: readonly T[],
    isToolResult: boolean,
  ): readonly (T | ModelImageBlock | ModelTextBlock)[] => {
    let changed = false
    let downgradedOriginal = false
    const content = blocks.map((block) => {
      if (block.type !== "image") return block
      if (isToolResult && earlierToolImages > 0) {
        earlierToolImages -= 1
        omittedImageCount += 1
        changed = true
        const reference = block.file
        const path =
          reference !== undefined && "path" in reference
            ? (resolveRolloutImagePath?.(reference) ?? reference.path)
            : undefined
        return {
          type: "text" as const,
          text:
            path === undefined
              ? "[Earlier tool screenshot omitted from request context to bound payload size. No local file path is available; do not claim to see omitted images.]"
              : `[Earlier tool screenshot omitted from request context to bound payload size (saved at ${path}). Call view_image if you need to re-inspect it; do not claim to see omitted images.]`,
        }
      }
      if (!supportsImages) {
        omittedImageCount += 1
        changed = true
        return {
          type: "text" as const,
          text: `[Attached image was not sent because ${target.provider}/${target.model} does not have image input enabled. The user should select a verified vision-capable model if visual inspection is required.]`,
        }
      }
      if (!shouldDowngradeOriginal || block.detail !== "original") return block
      downgradedOriginalCount += 1
      changed = true
      downgradedOriginal = true
      return { ...block, detail: "high" as const }
    })
    if (!changed) return blocks
    return downgradedOriginal
      ? [
          ...content,
          {
            type: "text",
            text: `[Original image detail is not available for ${target.provider}/${target.model}; the image was sent using high detail.]`,
          },
        ]
      : content
  }
  const adapted = messages.map((message): ModelMessage => {
    if (message.role === "user" || message.role === "tool") {
      const content = adaptContent(message.content, message.role === "tool")
      return content === message.content ? message : { ...message, content }
    }
    return message
  })

  return {
    messages: adapted,
    omittedImageCount,
    downgradedOriginalCount,
  }
}
