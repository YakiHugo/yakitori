import type { CitationRange } from "../protocol/conversation.ts"
import type { ModelContentBlock, ModelStreamEvent } from "./model.ts"

const citationStart = "\uE200cite\uE202"
const citationEnd = "\uE201"
const citation =
  /\uE200cite\uE202[^\uE200\uE201\r\n]*(?:\uE201|(?=[\uE200\r\n]|$))/gu
const eos = "<|eos|>"

export function cleanModelText(text: string): string {
  return scanText(text, true).text
}

export async function* cleanModelTextStream(
  events: AsyncIterable<ModelStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const tails = new Map<string | undefined, Map<number, string>>()
  for await (const event of events) {
    if (event.type === "delta") {
      const part = event.partIndex ?? 0
      const parts = tails.get(event.itemId)
      const { text, tail } = scanText(
        (parts?.get(part) ?? "") + event.text,
        false,
      )
      if (tail !== "") {
        const next = parts ?? new Map<number, string>()
        next.set(part, tail)
        tails.set(event.itemId, next)
      } else if (parts !== undefined) {
        parts.delete(part)
        if (parts.size === 0) tails.delete(event.itemId)
      }
      if (text !== "") yield { ...event, text }
      continue
    }
    if (event.type === "output_item") {
      tails.delete(event.itemId)
      yield { ...event, content: cleanContent(event.content) }
    } else if (event.type === "response") {
      const { response } = event
      yield {
        ...event,
        response: { ...response, content: cleanContent(response.content) },
      }
    } else {
      if (event.type === "retry") tails.clear()
      yield event
    }
  }
}

function cleanContent(content: readonly ModelContentBlock[]) {
  return content.map((block) => {
    if (block.type !== "text") return block
    const { text, removed } = scanText(block.text, true)
    if (removed.length === 0) return block
    const mapOffset = (offset: number) =>
      removed.reduce(
        (mapped, { start, end }) =>
          mapped - Math.max(0, Math.min(offset, end) - start),
        offset,
      )
    const annotations = block.annotations?.map(
      ({ responseSpan, ...annotation }) => {
        if (responseSpan === undefined) return annotation
        const start = mapOffset(responseSpan.start)
        const end = mapOffset(responseSpan.end)
        return start < end
          ? { ...annotation, responseSpan: { start, end } }
          : annotation
      },
    )
    return {
      ...block,
      text,
      ...(annotations === undefined ? {} : { annotations }),
    }
  })
}

function scanText(input: string, complete: boolean) {
  const removed: CitationRange[] = []
  // Only a possible token at the fragment boundary should delay visible text.
  // A completed provider part supplies the authoritative text and offsets.
  let boundary = input.length
  for (const match of input.matchAll(citation)) {
    const { index: start } = match
    const token = match[0]
    const end = start + token.length
    if (complete || end < input.length || token.endsWith(citationEnd))
      removed.push({ start, end })
    else boundary = start
  }
  const lastCitationStart = input.lastIndexOf(citationStart.charAt(0))
  if (
    lastCitationStart >= 0 &&
    lastCitationStart > input.length - citationStart.length
  ) {
    if (citationStart.startsWith(input.slice(lastCitationStart))) {
      if (complete)
        removed.push({ start: lastCitationStart, end: input.length })
      else boundary = lastCitationStart
    }
  }
  const lastEosStart = input.lastIndexOf("<")
  const wireEnd = input.trimEnd().length
  if (lastEosStart >= 0 && lastEosStart < boundary) {
    const candidate = input.slice(lastEosStart, wireEnd)
    if (candidate === eos && !removed.some(({ end }) => end > lastEosStart)) {
      if (complete) removed.push({ start: lastEosStart, end: wireEnd })
      else boundary = lastEosStart
    } else if (
      !complete &&
      wireEnd === input.length &&
      eos.startsWith(candidate)
    ) {
      boundary = lastEosStart
    }
  }
  let text = ""
  let cursor = 0
  for (const { start, end } of removed) {
    text += input.slice(cursor, start)
    cursor = end
  }
  text += input.slice(cursor, boundary)
  return { text, tail: input.slice(boundary), removed }
}
