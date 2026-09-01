import type { ModelMessage, ModelTarget } from "./model.ts"
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

  const adapted = messages.map((message): ModelMessage => {
    if (message.role !== "user" || (message.images?.length ?? 0) === 0) {
      return message
    }
    if (!supportsImages) {
      omittedImageCount += message.images?.length ?? 0
      const { images: _images, ...withoutImages } = message
      return {
        ...withoutImages,
        content: [
          ...message.content,
          {
            type: "text",
            text: `[${message.images?.length ?? 0} attached image(s) were not sent because ${target.provider}/${target.model} does not support image input. The user should switch to a vision-capable model if visual inspection is required.]`,
          },
        ],
      }
    }
    if (!shouldDowngradeOriginal) return message
    let messageDowngradedOriginalCount = 0
    const images = (message.images ?? []).map((image) => {
      if (image.detail !== "original") return image
      downgradedOriginalCount += 1
      messageDowngradedOriginalCount += 1
      return { ...image, detail: "high" as const }
    })
    if (messageDowngradedOriginalCount === 0) return message
    return {
      ...message,
      content: [
        ...message.content,
        {
          type: "text",
          text: `[Original image detail is not available for ${target.provider}/${target.model}; the image was sent using high detail.]`,
        },
      ],
      images,
    }
  })

  return {
    messages: adapted,
    omittedImageCount,
    downgradedOriginalCount,
  }
}
