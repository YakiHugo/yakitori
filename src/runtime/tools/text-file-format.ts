export type LineEnding = "\n" | "\r\n" | "\r"

export function dominantLineEnding(content: string): LineEnding {
  const crlf = content.match(/\r\n/g)?.length ?? 0
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf
  const cr = (content.match(/\r/g)?.length ?? 0) - crlf
  if (crlf > lf && crlf >= cr) return "\r\n"
  if (cr > lf && cr > crlf) return "\r"
  return "\n"
}

export function normalizeReplacementLineEndings(
  replacement: string,
  lineEnding: LineEnding,
): string {
  const normalized = replacement.replace(/\r\n|\r/g, "\n")
  return lineEnding === "\n"
    ? normalized
    : normalized.replace(/\n/g, lineEnding)
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
