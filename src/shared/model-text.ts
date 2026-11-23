import type { CitationRange } from "../protocol/conversation.ts"

const citationStart = "\uE200cite\uE202"
const citationEnd = "\uE201"
const citation =
  /\uE200cite\uE202[^\uE200\uE201\r\n]*(?:\uE201|(?=[\uE200\r\n]|$))/gu
const endTokens = ["<|eos|>", "<|endoftext|>", "<|im_end|>", "<|eot_id|>"]

export function scanModelText(input: string, complete: boolean) {
  const removed: CitationRange[] = []
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
    lastCitationStart > input.length - citationStart.length &&
    citationStart.startsWith(input.slice(lastCitationStart))
  ) {
    if (complete) removed.push({ start: lastCitationStart, end: input.length })
    else boundary = lastCitationStart
  }
  if (boundary === input.length) {
    const lastStart = input.lastIndexOf("<")
    if (!complete && lastStart >= 0) {
      const candidate = input.slice(lastStart)
      if (endTokens.some((token) => token.startsWith(candidate)))
        boundary = lastStart
    }
    const endRanges: CitationRange[] = []
    let end = boundary
    for (;;) {
      end = input.slice(0, end).trimEnd().length
      const token = endTokens.find((value) => input.endsWith(value, end))
      if (token === undefined) break
      const start = end - token.length
      if (start < (removed.at(-1)?.end ?? 0)) break
      if (complete) endRanges.push({ start, end })
      else boundary = start
      end = start
    }
    removed.push(...endRanges.reverse())
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
