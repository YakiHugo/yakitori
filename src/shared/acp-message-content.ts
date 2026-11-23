import { ATTACHMENT_FILE_SAFETY_BYTES } from "../protocol/attachment-upload.ts"
import type { ModelImageBlock } from "../protocol/conversation.ts"
import type { CitationSource } from "../protocol/execution-view.ts"
import { citationURL } from "./citation-sources.ts"

export function acpRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

export function acpString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined
}

export function acpMessageContent(
  content: Record<string, unknown>,
  sourceId: string,
): Readonly<{
  image?: ModelImageBlock
  source?: CitationSource
  text?: string
}> {
  if (content.type === "image") {
    const image = acpBitmap(content.mimeType, content.data)
    return image === undefined ? {} : { image }
  }
  if (content.type !== "resource_link" && content.type !== "resource") return {}
  const resource =
    content.type === "resource" ? acpRecord(content.resource) : content
  const uri = acpString(resource.uri)
  if (uri === undefined) return {}
  const url = citationURL(uri)
  const label =
    acpString(resource.title) ??
    acpString(resource.name) ??
    uri.split("/").findLast((part) => part.length > 0) ??
    uri
  const source = { id: sourceId, label, ...(url === undefined ? {} : { url }) }
  if (content.type === "resource_link") return { source }
  const image = acpBitmap(resource.mimeType, resource.blob)
  if (image !== undefined) return { image, source }
  if (typeof resource.text !== "string" || resource.text.length === 0)
    return { source }
  // Embedded text is resource data. Preserve it as literal text in Markdown.
  let fenceLength = 3
  for (const [run] of resource.text.matchAll(/^ {0,3}`{3,}/gmu))
    fenceLength = Math.max(fenceLength, run.trimStart().length + 1)
  const fence = "`".repeat(fenceLength)
  return { source, text: `\n\n${fence}\n${resource.text}\n${fence}\n\n` }
}

export function acpBitmap(
  mediaType: unknown,
  data: unknown,
): ModelImageBlock | undefined {
  if (
    (mediaType !== "image/png" &&
      mediaType !== "image/jpeg" &&
      mediaType !== "image/gif" &&
      mediaType !== "image/webp") ||
    typeof data !== "string" ||
    data.length > Math.ceil(ATTACHMENT_FILE_SAFETY_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  )
    return undefined
  return { type: "image", mediaType, data }
}
