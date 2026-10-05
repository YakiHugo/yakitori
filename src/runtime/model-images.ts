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
): ModelImageAdaptation {
  const supportsImages = capabilities.inputModalities.includes("image")
  const supportsOriginal = capabilities.imageDetailModes.includes("original")
  const shouldDowngradeOriginal = supportsImages && !supportsOriginal
  let omittedImageCount = 0
  let downgradedOriginalCount = 0

  const adaptContent = <
    T extends ModelUserContentBlock | ModelToolContentBlock,
  >(
    blocks: readonly T[],
  ): readonly (T | ModelImageBlock | ModelTextBlock)[] => {
    let changed = false
    const content = blocks.map((block) => {
      if (block.type !== "image") return block
      if (!supportsImages) {
        omittedImageCount += 1
        changed = true
        return {
          type: "text" as const,
          text: `[Attached image was not sent because ${target.provider}/${target.model} does not support image input. The user should switch to a vision-capable model if visual inspection is required.]`,
        }
      }
      if (!shouldDowngradeOriginal || block.detail !== "original") return block
      downgradedOriginalCount += 1
      changed = true
      return { ...block, detail: "high" as const }
    })
    if (!changed) return blocks
    return supportsImages
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
    if (message.role === "user") {
      const content = adaptContent(message.content)
      return content === message.content ? message : { ...message, content }
    }
    if (message.role === "tool") {
      const content = adaptContent(message.content)
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
