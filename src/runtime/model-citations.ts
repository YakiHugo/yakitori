import type {
  CanonicalAnnotation,
  CitationRange,
} from "../protocol/conversation.ts"
import { isJsonObject } from "../protocol/json.ts"

// Responses sends a flat annotation. Chat Completions wraps URL citations.
export function openAICitations(
  value: unknown,
  text: string,
): CanonicalAnnotation[] {
  if (!Array.isArray(value)) return []
  const citations: CanonicalAnnotation[] = []
  for (const annotation of value) {
    if (!isJsonObject(annotation)) continue
    if (annotation.type === "url_citation") {
      const source = isJsonObject(annotation.url_citation)
        ? annotation.url_citation
        : annotation
      const title = stringField(source.title)
      const url = stringField(source.url ?? source.source)
      const responseSpan = characterSpan(
        text,
        source.start_index,
        source.end_index,
      )
      citations.push({
        kind: "url",
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        ...(responseSpan === undefined ? {} : { responseSpan }),
      })
    } else if (
      annotation.type === "file_citation" ||
      annotation.type === "container_file_citation" ||
      annotation.type === "file_path"
    ) {
      const title = stringField(annotation.filename ?? annotation.file_path)
      const responseSpan = characterSpan(
        text,
        annotation.start_index,
        annotation.end_index,
      )
      citations.push({
        kind: "file",
        ...(title === undefined ? {} : { title }),
        ...(responseSpan === undefined ? {} : { responseSpan }),
      })
    }
  }
  return citations
}

export function anthropicCitations(value: unknown): CanonicalAnnotation[] {
  if (!Array.isArray(value)) return []
  const citations: CanonicalAnnotation[] = []
  for (const citation of value) {
    if (!isJsonObject(citation)) continue
    const citedText = stringField(citation.cited_text)
    const quote = citedText === undefined ? {} : { citedText }
    if (
      citation.type === "web_search_result_location" ||
      citation.type === "search_result_location"
    ) {
      const title = stringField(citation.title)
      const url = stringField(citation.url ?? citation.source)
      const sourceLocation = documentLocation(
        "content_block",
        citation.start_block_index,
        citation.end_block_index,
      )
      citations.push({
        kind: "url",
        ...quote,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        ...(sourceLocation === undefined ? {} : { sourceLocation }),
      })
      continue
    }
    const title = stringField(citation.document_title)
    let sourceLocation: CanonicalAnnotation["sourceLocation"]
    switch (citation.type) {
      case "page_location":
        sourceLocation = documentLocation(
          "page",
          citation.start_page_number,
          citation.end_page_number,
        )
        break
      case "char_location":
        sourceLocation = documentLocation(
          "character",
          citation.start_char_index,
          citation.end_char_index,
        )
        break
      case "content_block_location":
        sourceLocation = documentLocation(
          "content_block",
          citation.start_block_index,
          citation.end_block_index,
        )
        break
      default:
        continue
    }
    citations.push({
      kind: "document",
      ...quote,
      ...(title === undefined ? {} : { title }),
      ...(sourceLocation === undefined ? {} : { sourceLocation }),
    })
  }
  return citations
}

function characterSpan(
  text: string,
  start: unknown,
  end: unknown,
): CitationRange | undefined {
  if (!isOffset(start) || !isOffset(end) || end <= start || end > text.length)
    return
  let offset = 0
  let startOffset = 0
  let index = 0
  for (const character of text) {
    if (index === start) startOffset = offset
    offset += character.length
    if (++index === end) return { start: startOffset, end: offset }
  }
}

function documentLocation(
  unit: NonNullable<CanonicalAnnotation["sourceLocation"]>["unit"],
  start: unknown,
  end: unknown,
): CanonicalAnnotation["sourceLocation"] {
  if (!isOffset(start) || (unit === "page" && start === 0)) return
  return isOffset(end) && end > start ? { unit, start, end } : { unit, start }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
