import { isJsonObject, type ModelTextBlock } from "../kernel/events.ts"

export type CitationOrigin = Readonly<{
  provider: "openai" | "anthropic" | "chatCompletions"
  blockIndex: number
  // Kept in the original text block's coordinates, never the joined message.
  range?: Readonly<{ start: number; end: number }>
}>
export type CitationSource = Readonly<{
  id: string
  label: string
  url?: string
  location?: string
  origins: readonly CitationOrigin[]
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
        const start = value.start_index
        const end = value.end_index
        const boundary = (index: number) =>
          index === 0 ||
          index === block.text.length ||
          !(
            block.text.charCodeAt(index) >= 0xdc00 &&
            block.text.charCodeAt(index) <= 0xdfff &&
            block.text.charCodeAt(index - 1) >= 0xd800 &&
            block.text.charCodeAt(index - 1) <= 0xdbff
          )
        const range =
          typeof start === "number" &&
          typeof end === "number" &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end > start &&
          end <= block.text.length &&
          boundary(start) &&
          boundary(end)
            ? { start, end }
            : undefined
        const origin: CitationOrigin = {
          provider,
          blockIndex,
          ...(range === undefined ? {} : { range }),
        }
        // URL identity can merge display rows while retaining every block origin.
        // Matching local titles alone cannot prove that two documents are equal.
        const existing =
          url === undefined
            ? -1
            : sources.findIndex(
                (source) =>
                  source.url === url &&
                  source.label === label &&
                  source.location === location,
              )
        const source = sources[existing]
        if (source !== undefined) {
          if (
            !source.origins.some(
              (item) =>
                item.provider === provider &&
                item.blockIndex === blockIndex &&
                item.range?.start === range?.start &&
                item.range?.end === range?.end,
            )
          )
            sources[existing] = {
              ...source,
              origins: [...source.origins, origin],
            }
        } else {
          sources.push({
            id: `citation_${blockIndex}_${provider}_${annotationIndex}`,
            label,
            ...(url === undefined ? {} : { url }),
            ...(location === undefined ? {} : { location }),
            origins: [origin],
          })
        }
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
