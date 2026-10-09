import { isJsonObject } from "../kernel/events.ts"
import type { ModelTextBlock } from "../protocol/conversation.ts"

export type CitationSource = Readonly<{
  id: string
  label: string
  url?: string
  location?: string
}>

export function citationSources(
  blocks: readonly ModelTextBlock[],
): CitationSource[] {
  const sources: CitationSource[] = []
  for (const [blockIndex, block] of blocks.entries()) {
    for (const provider of [
      "openai",
      "anthropic",
      "chatCompletions",
    ] as const) {
      const metadata = block.providerMetadata?.[provider]
      if (!isJsonObject(metadata)) continue
      const part = metadata.part
      const annotations =
        provider === "openai"
          ? isJsonObject(part)
            ? part.annotations
            : undefined
          : provider === "anthropic"
            ? metadata.citations
            : metadata.annotations
      if (!Array.isArray(annotations)) continue
      for (const [annotationIndex, annotation] of annotations.entries()) {
        if (!isJsonObject(annotation)) continue
        const value = isJsonObject(annotation.url_citation)
          ? annotation.url_citation
          : annotation
        const type = annotation.type
        let label: string | undefined
        let url: string | undefined
        let location: string | undefined
        if (
          type === "url_citation" ||
          type === "web_search_result_location" ||
          type === "search_result_location"
        ) {
          url = citationURL(value.url ?? value.source)
          label =
            typeof value.title === "string" && value.title.trim()
              ? value.title.trim()
              : url
                ? new URL(url).hostname
                : "Source"
        } else if (
          type === "file_citation" ||
          type === "container_file_citation" ||
          type === "file_path"
        ) {
          const filename = annotation.filename ?? annotation.file_path
          label =
            typeof filename === "string" && filename.trim()
              ? filename.split(/[\\/]/).at(-1) || "File source"
              : "File source"
        } else if (
          type === "page_location" ||
          type === "char_location" ||
          type === "content_block_location"
        ) {
          label =
            typeof annotation.document_title === "string" &&
            annotation.document_title.trim()
              ? annotation.document_title.trim()
              : "Document source"
          if (
            type === "page_location" &&
            typeof annotation.start_page_number === "number" &&
            Number.isInteger(annotation.start_page_number) &&
            annotation.start_page_number > 0
          )
            location = `from page ${annotation.start_page_number}`
        }
        if (label === undefined) continue
        // Sources is a display list; native annotations stay on the response blocks.
        // Matching local titles alone cannot prove that two documents are equal.
        if (
          url !== undefined &&
          sources.some(
            (source) =>
              source.url === url &&
              source.label === label &&
              source.location === location,
          )
        )
          continue
        sources.push({
          id: `citation_${blockIndex}_${provider}_${annotationIndex}`,
          label,
          ...(url === undefined ? {} : { url }),
          ...(location === undefined ? {} : { location }),
        })
      }
    }
  }
  return sources
}

export function citationURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return undefined
  }
}
