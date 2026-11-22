import type { ModelAssistantTextBlock } from "../protocol/conversation.ts"
import type { CitationSource } from "../protocol/execution-view.ts"

export type { CitationSource } from "../protocol/execution-view.ts"

export function citationSources(
  blocks: readonly ModelAssistantTextBlock[],
): CitationSource[] {
  const sources: CitationSource[] = []
  const seenURLs = new Set<string>()
  for (const [blockIndex, block] of blocks.entries()) {
    for (const [index, annotation] of (block.annotations ?? []).entries()) {
      const url = citationURL(annotation.url)
      const title = annotation.title?.trim()
      const label =
        annotation.kind === "file"
          ? title?.split(/[\\/]/).at(-1) || "File source"
          : title ||
            (url === undefined
              ? annotation.kind === "document"
                ? "Document source"
                : "Source"
              : new URL(url).hostname)
      const location =
        annotation.sourceLocation?.unit === "page"
          ? `from page ${annotation.sourceLocation.start}`
          : undefined
      // Matching local titles alone cannot prove that two documents are equal.
      if (url !== undefined) {
        const key = JSON.stringify([url, label, location])
        if (seenURLs.has(key)) continue
        seenURLs.add(key)
      }
      sources.push({
        id: `citation_${blockIndex}_${index}`,
        label,
        ...(url === undefined ? {} : { url }),
        ...(location === undefined ? {} : { location }),
      })
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
