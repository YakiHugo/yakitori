export type EditMatchMode =
  | "exact"
  | "line_endings"
  | "curly_quotes"
  | "trailing_whitespace"
  | "curly_quotes_and_trailing_whitespace"

export type TextMatch = {
  readonly start: number
  readonly end: number
}

export function locateEditMatches(
  content: string,
  oldString: string,
): { readonly mode: EditMatchMode; readonly matches: readonly TextMatch[] } {
  const exact = findExactMatches(content, oldString)
  if (exact.length > 0) return { mode: "exact", matches: exact }

  for (const mode of flexibleMatchModes) {
    const matches = findFlexibleMatches(content, oldString, mode)
    if (matches.length > 0) return { mode, matches }
  }
  return { mode: "exact", matches: [] }
}

const flexibleMatchModes: readonly Exclude<EditMatchMode, "exact">[] = [
  "line_endings",
  "curly_quotes",
  "trailing_whitespace",
  "curly_quotes_and_trailing_whitespace",
]

function findExactMatches(
  content: string,
  oldString: string,
): readonly TextMatch[] {
  const matches: TextMatch[] = []
  let offset = 0
  while (offset <= content.length - oldString.length) {
    const start = content.indexOf(oldString, offset)
    if (start < 0) break
    matches.push({ start, end: start + oldString.length })
    offset = start + oldString.length
  }
  return matches
}

function findFlexibleMatches(
  content: string,
  oldString: string,
  mode: Exclude<EditMatchMode, "exact">,
): readonly TextMatch[] {
  const trailingWhitespace =
    mode === "trailing_whitespace" ||
    mode === "curly_quotes_and_trailing_whitespace"
  const curlyQuotes =
    mode === "curly_quotes" || mode === "curly_quotes_and_trailing_whitespace"
  const pattern = buildFlexiblePattern(oldString, {
    trailingWhitespace,
    curlyQuotes,
  })
  if (new RegExp(`^(?:${pattern})$`, "u").test("")) return []
  const expression = new RegExp(pattern, "gu")
  return [...content.matchAll(expression)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function buildFlexiblePattern(
  value: string,
  options: {
    readonly trailingWhitespace: boolean
    readonly curlyQuotes: boolean
  },
): string {
  let pattern = ""
  let index = 0
  while (index < value.length) {
    const char = value.charAt(index)

    if (char === "\r" || char === "\n") {
      if (
        options.trailingWhitespace &&
        value[index - 1] !== " " &&
        value[index - 1] !== "\t"
      ) {
        pattern += "[ \\t]*"
      }
      pattern += "(?:\\r\\n|\\n|\\r)"
      index += char === "\r" && value[index + 1] === "\n" ? 2 : 1
      continue
    }

    if (char === " " || char === "\t") {
      const start = index
      while (value[index] === " " || value[index] === "\t") index += 1
      const beforeLineEnding = value[index] === "\r" || value[index] === "\n"
      pattern +=
        options.trailingWhitespace && beforeLineEnding
          ? "[ \\t]*"
          : escapeRegExp(value.slice(start, index))
      continue
    }

    if (options.curlyQuotes && isSingleQuote(char)) {
      pattern += "['‘’]"
      index += 1
      continue
    }
    if (options.curlyQuotes && isDoubleQuote(char)) {
      pattern += '["“”]'
      index += 1
      continue
    }

    pattern += escapeRegExp(char)
    index += 1
  }
  return pattern
}

function isSingleQuote(value: string): boolean {
  return value === "'" || value === "‘" || value === "’"
}

function isDoubleQuote(value: string): boolean {
  return value === '"' || value === "“" || value === "”"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
