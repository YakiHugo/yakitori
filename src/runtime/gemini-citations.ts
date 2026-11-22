import { isJsonObject, type JsonObject } from "../kernel/index.ts"
import type { CitationRange, ModelCitation } from "../protocol/conversation.ts"
import type { ModelContentBlock } from "./model.ts"

export function geminiInteractionCitations(
  parts: readonly JsonObject[],
): ModelCitation[] {
  const citations: ModelCitation[] = []
  let offset = 0
  for (const part of parts) {
    if (typeof part.text !== "string") continue
    if (Array.isArray(part.annotations)) {
      for (const annotation of part.annotations) {
        if (!isJsonObject(annotation)) continue
        const source =
          annotation.type === "url_citation"
            ? citationSource("url", annotation.title, annotation.url)
            : annotation.type === "place_citation"
              ? citationSource("url", annotation.name, annotation.url)
              : annotation.type === "file_citation"
                ? citationSource(
                    "file",
                    annotation.file_name,
                    annotation.document_uri,
                  )
                : undefined
        if (source === undefined) continue
        const span = utf8Span(
          part.text,
          annotation.start_index,
          annotation.end_index,
        )
        const page = annotation.page_number
        citations.push({
          ...source,
          ...(annotation.type === "file_citation" && isOffset(page) && page > 0
            ? { sourceLocation: { unit: "page", start: page } }
            : {}),
          ...(span === undefined
            ? {}
            : {
                responseSpan: {
                  start: offset + span.start,
                  end: offset + span.end,
                },
              }),
        })
      }
    }
    offset += part.text.length
  }
  return citations
}

export function createGeminiGrounding() {
  const sources: (ModelCitation | undefined)[] = []
  const supports: {
    support: JsonObject
    firstPart: number
    partCount: number
  }[] = []
  const textParts = new Map<number, GroundedTextPart>()
  return {
    accept(metadata: unknown, firstPart: number, partCount: number): void {
      if (!isJsonObject(metadata)) return
      // Grounding indices count every chunk across SSE events, including kinds
      // that do not have a source we can show.
      if (Array.isArray(metadata.groundingChunks)) {
        for (const chunk of metadata.groundingChunks) {
          const source = !isJsonObject(chunk)
            ? undefined
            : isJsonObject(chunk.web)
              ? citationSource("url", chunk.web.title, chunk.web.uri)
              : isJsonObject(chunk.retrievedContext)
                ? citationSource(
                    "document",
                    chunk.retrievedContext.title,
                    chunk.retrievedContext.uri,
                    chunk.retrievedContext.text,
                  )
                : isJsonObject(chunk.maps)
                  ? citationSource("url", chunk.maps.title, chunk.maps.uri)
                  : undefined
          sources.push(source)
        }
      }
      if (Array.isArray(metadata.groundingSupports)) {
        for (const support of metadata.groundingSupports)
          if (isJsonObject(support))
            supports.push({ support, firstPart, partCount })
      }
    },
    noteTextPart(
      partIndex: number,
      blockIndex: number,
      offset: number,
      text: string,
    ): void {
      textParts.set(partIndex, { blockIndex, offset, text })
    },
    annotate(content: ModelContentBlock[]): void {
      if (sources.length === 0) return
      const lastText = content.findLastIndex((block) => block.type === "text")
      if (lastText < 0) return
      const annotations = new Map<number, ModelCitation[]>()
      for (const { support, firstPart, partCount } of supports) {
        if (!Array.isArray(support.groundingChunkIndices)) continue
        const segment = isJsonObject(support.segment)
          ? support.segment
          : undefined
        const partIndex = segment?.partIndex ?? 0
        const localPart =
          isOffset(partIndex) && partIndex < partCount
            ? textParts.get(firstPart + partIndex)
            : undefined
        const streamedPart = isOffset(partIndex)
          ? textParts.get(partIndex)
          : undefined
        const match =
          segment === undefined
            ? undefined
            : (matchGroundingSegment(segment, localPart, content) ??
              matchGroundingSegment(segment, streamedPart, content))
        const blockIndex =
          match?.blockIndex ??
          localPart?.blockIndex ??
          streamedPart?.blockIndex ??
          lastText
        for (const index of support.groundingChunkIndices) {
          const source = isOffset(index) ? sources[index] : undefined
          if (source === undefined) continue
          let citations = annotations.get(blockIndex)
          if (citations === undefined) {
            citations = []
            annotations.set(blockIndex, citations)
          }
          citations.push(
            match === undefined
              ? source
              : { ...source, responseSpan: match.responseSpan },
          )
        }
      }
      if (annotations.size === 0) {
        const available = sources.filter((source) => source !== undefined)
        if (available.length > 0) annotations.set(lastText, available)
      }
      for (const [index, citations] of annotations) {
        const block = content[index]
        if (block?.type === "text")
          content[index] = { ...block, annotations: citations }
      }
    },
  }
}

type GroundedTextPart = { blockIndex: number; offset: number; text: string }

function matchGroundingSegment(
  segment: JsonObject,
  part: GroundedTextPart | undefined,
  content: readonly ModelContentBlock[],
): { blockIndex: number; responseSpan: CitationRange } | undefined {
  if (part === undefined) return
  const span = utf8Span(
    part.text,
    segment.startIndex,
    segment.endIndex,
    segment.text,
  )
  if (span !== undefined)
    return {
      blockIndex: part.blockIndex,
      responseSpan: {
        start: part.offset + span.start,
        end: part.offset + span.end,
      },
    }
  const block = content[part.blockIndex]
  if (
    part.offset !== 0 ||
    block?.type !== "text" ||
    typeof segment.text !== "string"
  )
    return
  // A terminal grounding segment can span multiple streamed text fragments.
  const responseSpan = utf8Span(
    block.text,
    segment.startIndex,
    segment.endIndex,
    segment.text,
  )
  if (responseSpan !== undefined)
    return { blockIndex: part.blockIndex, responseSpan }
}

function citationSource(
  kind: ModelCitation["kind"],
  title: unknown,
  url: unknown,
  retrievedText?: unknown,
): ModelCitation | undefined {
  const label = typeof title === "string" && title.trim() ? title : undefined
  const uri = typeof url === "string" && url.trim() ? url : undefined
  const citedText =
    typeof retrievedText === "string" && retrievedText.trim()
      ? retrievedText
      : undefined
  if (
    label === undefined &&
    uri === undefined &&
    citedText === undefined &&
    kind !== "file"
  )
    return
  return {
    kind,
    ...(label === undefined ? {} : { title: label }),
    ...(uri === undefined ? {} : { url: uri }),
    ...(citedText === undefined ? {} : { citedText }),
  }
}

function utf8Span(
  text: string,
  start: unknown,
  end: unknown,
  segmentText?: unknown,
): CitationRange | undefined {
  start ??= 0
  if (!isOffset(start) || !isOffset(end) || end <= start) return
  const bytes = Buffer.from(text, "utf8")
  if (
    end > bytes.length ||
    ((bytes[start] ?? 0) & 0xc0) === 0x80 ||
    ((bytes[end] ?? 0) & 0xc0) === 0x80
  )
    return
  const match = bytes.toString("utf8", start, end)
  if (typeof segmentText === "string" && match !== segmentText) return
  const offset = bytes.toString("utf8", 0, start).length
  return { start: offset, end: offset + match.length }
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
