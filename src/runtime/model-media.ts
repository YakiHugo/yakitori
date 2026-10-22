import type { RolloutAssets } from "../core/rollout-assets.ts"
import { formatInputContext } from "./input-context.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelTarget,
  ModelToolContentBlock,
} from "./model.ts"
import type { ModelCapabilities } from "./model-catalog.ts"
import { adaptImagesForModel } from "./model-images.ts"
import type { DocumentReadingCapabilities } from "./prepare-model-document.ts"
import { prepareModelImage } from "./prepare-model-image.ts"

export async function prepareModelMedia(
  messages: readonly ModelMessage[],
  input: Readonly<{
    target: ModelTarget
    imageCapabilities: Pick<
      ModelCapabilities,
      "imageDetailModes" | "inputModalities"
    >
    rolloutAssets: RolloutAssets | undefined
    documentReading: DocumentReadingCapabilities
    userDocumentReading: DocumentReadingCapabilities
    signal?: AbortSignal
  }>,
): Promise<readonly ModelMessage[]> {
  const adapted = adaptImagesForModel(
    messages,
    input.target,
    input.imageCapabilities,
  ).messages
  const { createNativePdfBudget, prepareModelDocuments } = await import(
    "./prepare-model-document.ts"
  )
  const nativePdfBudget = createNativePdfBudget(
    input.userDocumentReading.nativePdfLimits ??
      input.documentReading.nativePdfLimits,
    // Images and PDF pages share Anthropic's allowance. Reserve all ordinary
    // image occurrences first, including later messages, so an earlier PDF
    // cannot displace them. History/cache reuse does not deduplicate the wire.
    adapted.reduce(
      (count, message) =>
        count +
        (message.role === "user" || message.role === "tool"
          ? message.content.filter((block) => block.type === "image").length
          : 0),
      0,
    ),
  )
  const resolved: ModelMessage[] = []
  // Project messages in order so a history full of PDFs cannot launch one
  // rasterization worker per message concurrently.
  for (const message of adapted) {
    if (message.role !== "user" && message.role !== "tool") {
      resolved.push(message)
      continue
    }
    const resolveImage = async (image: ModelImageBlock) => {
      if ("data" in image && image.data !== undefined)
        return prepareModelImage(
          Buffer.from(image.data, "base64"),
          image.detail ?? "high",
        )
      return image
    }
    const content: ModelToolContentBlock[] = []
    // PDF raster/text fallback expands at its source slot, not after later text
    // or other assets. Keep the existing sequential PDF cache/budget boundary.
    for (const block of message.content) {
      if (block.type === "image") content.push(await resolveImage(block))
      else if (block.type === "text") content.push(block)
      else {
        const projected = await prepareModelDocuments(
          [block],
          input.rolloutAssets,
          message.role === "user"
            ? input.userDocumentReading
            : input.documentReading,
          input.signal,
          nativePdfBudget,
        )
        if (projected.content !== "")
          content.push({ type: "text", text: projected.content })
        content.push(...projected.images, ...projected.documents)
      }
    }
    if (message.role === "user") {
      const { contextAttachments, ...user } = message
      if (contextAttachments?.length)
        content.push({
          type: "text",
          text: formatInputContext(contextAttachments),
        })
      resolved.push({ ...user, content })
    } else resolved.push({ ...message, content })
  }
  return resolved
}
