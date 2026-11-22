export type LineEnding = "\n" | "\r\n" | "\r"

export function decodeTextFile(bytes: Buffer): string | undefined {
  const content = bytes.toString("utf8")
  return content.includes("\0") || !Buffer.from(content, "utf8").equals(bytes)
    ? undefined
    : content
}

export function preserveReplacementLineEndings(
  replacement: string,
  matchedText: string,
  adjacentEnding: LineEnding,
): string {
  const endings = matchedText.match(/\r\n|\r|\n/g) ?? []
  let index = 0
  return replacement.replace(
    /\r\n|\r|\n/g,
    () => endings[index++] ?? endings.at(-1) ?? adjacentEnding,
  )
}

export function normalizeUnicodePunctuation(value: string): string {
  return value
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ")
}

export function preserveCurlyQuoteStyle(
  matchedText: string,
  replacement: string,
): string {
  const preserveSingle = /[‘’]/u.test(matchedText)
  const preserveDouble = /[“”]/u.test(matchedText)
  if (!preserveSingle && !preserveDouble) return replacement

  return [...replacement]
    .map((character, index, characters) => {
      if (character === '"' && preserveDouble) {
        return isOpeningQuote(characters[index - 1]) ? "“" : "”"
      }
      if (character === "'" && preserveSingle) {
        if (
          isWordCharacter(characters[index - 1]) &&
          isWordCharacter(characters[index + 1])
        ) {
          return "’"
        }
        return isOpeningQuote(characters[index - 1]) ? "‘" : "’"
      }
      return character
    })
    .join("")
}

function isOpeningQuote(previous: string | undefined): boolean {
  return previous === undefined || /[\s([{<\u2014\u2013]/u.test(previous)
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value)
}
