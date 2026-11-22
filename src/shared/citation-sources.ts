import type { ModelAssistantTextBlock } from "../protocol/conversation.ts"
import type {
  CitationMention,
  CitationSource,
} from "../protocol/execution-view.ts"

export type { CitationSource } from "../protocol/execution-view.ts"

export function citationSources(
  blocks: readonly ModelAssistantTextBlock[],
): CitationSource[] {
  const sources: (Omit<CitationSource, "mentions"> & {
    mentions?: CitationMention[]
  })[] = []
  const byURL = new Map<string, (typeof sources)[number]>()
  let offset = 0
  for (const [blockIndex, block] of blocks.entries()) {
    const blockOffset = offset
    offset += block.text.length
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
      const key =
        url === undefined ? undefined : JSON.stringify([url, label, location])
      let source = key === undefined ? undefined : byURL.get(key)
      if (source === undefined) {
        source = {
          id: `citation_${blockIndex}_${index}`,
          label,
          ...(url === undefined ? {} : { url }),
          ...(location === undefined ? {} : { location }),
        }
        sources.push(source)
        if (key !== undefined) byURL.set(key, source)
      }
      const span = annotation.responseSpan
      if (
        span === undefined ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > block.text.length ||
        splitsSurrogate(block.text, span.start) ||
        splitsSurrogate(block.text, span.end)
      )
        continue
      const citedText = annotation.citedText?.trim()
      source.mentions ??= []
      source.mentions.push({
        responseSpan: {
          start: blockOffset + span.start,
          end: blockOffset + span.end,
        },
        ...(citedText ? { citedText } : {}),
      })
    }
  }
  return sources
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  )
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
