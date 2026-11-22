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
  allowFormattingEquivalence: boolean,
  replaceAll: boolean,
): { readonly mode: EditMatchMode; readonly matches: readonly TextMatch[] } {
  if (
    /[\r\n]/u.test(oldString) &&
    (oldString.includes("\r") || content.includes("\r"))
  ) {
    const equivalent = findLineEndingMatches(content, oldString, replaceAll)
    if (equivalent.length > 0) {
      const mode = equivalent.every(
        ({ start, end }) => content.slice(start, end) === oldString,
      )
        ? "exact"
        : "line_endings"
      return { mode, matches: equivalent }
    }
  } else {
    const exact = findExactMatches(content, oldString, replaceAll)
    if (exact.length > 0) return { mode: "exact", matches: exact }
  }
  if (allowFormattingEquivalence) {
    for (const mode of formattingMatchModes) {
      const matches = findFlexibleMatches(content, oldString, mode, replaceAll)
      if (matches.length > 0) return { mode, matches }
    }
  }
  return { mode: "exact", matches: [] }
}

type FormattingMatchMode = Exclude<EditMatchMode, "exact" | "line_endings">
const formattingMatchModes: readonly FormattingMatchMode[] = [
  "curly_quotes",
  "trailing_whitespace",
  "curly_quotes_and_trailing_whitespace",
]

function findExactMatches(
  content: string,
  oldString: string,
  replaceAll: boolean,
): readonly TextMatch[] {
  const matches: TextMatch[] = []
  let offset = 0
  while (offset <= content.length - oldString.length) {
    const start = content.indexOf(oldString, offset)
    if (start < 0) break
    matches.push({ start, end: start + oldString.length })
    offset = start + oldString.length
  }
  const first = matches[0]
  // Bulk replacements consume non-overlapping spans. A single anchor still
  // has to be unique, including overlaps the bulk scan would skip.
  if (!replaceAll && matches.length === 1 && first !== undefined) {
    const overlapping = content.indexOf(oldString, first.start + 1)
    if (overlapping !== -1)
      matches.push({ start: overlapping, end: overlapping + oldString.length })
  }
  return matches
}

function findLineEndingMatches(
  content: string,
  oldString: string,
  replaceAll: boolean,
): readonly TextMatch[] {
  const removed: number[] = []
  const normalized = content.replace(
    /\r\n|\r/g,
    (ending: string, offset: number) => {
      if (ending === "\r\n") removed.push(offset - removed.length)
      return "\n"
    },
  )
  const matches = findExactMatches(
    normalized,
    oldString.replace(/\r\n|\r/g, "\n"),
    replaceAll,
  )
  // Start and end offsets are independently ordered, even for overlapping spans.
  const mapOffsets = () => {
    let preceding = 0
    return (offset: number) => {
      while (
        preceding < removed.length &&
        (removed[preceding] ?? Infinity) < offset
      )
        preceding++
      return offset + preceding
    }
  }
  const originalStart = mapOffsets()
  const originalEnd = mapOffsets()
  return matches.map(({ start, end }) => ({
    start: originalStart(start),
    end: originalEnd(end),
  }))
}

function findFlexibleMatches(
  content: string,
  oldString: string,
  mode: FormattingMatchMode,
  replaceAll: boolean,
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
  try {
    const expression = new RegExp(pattern, "gu")
    const matches = [...content.matchAll(expression)]
    const first = matches[0]
    if (!replaceAll && matches.length === 1 && first !== undefined) {
      expression.lastIndex =
        first.index + ((first[0].codePointAt(0) ?? 0) > 0xffff ? 2 : 1)
      const overlapping = expression.exec(content)
      if (overlapping !== null) matches.push(overlapping)
    }
    return matches.map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }))
  } catch (error) {
    // Large escaped literals can exceed V8's regexp compiler capacity.
    if (
      error instanceof SyntaxError &&
      error.message.endsWith("Regular expression too large")
    )
      return []
    throw error
  }
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
      pattern += "(?:\\r\\n|(?<!\\r)\\n|\\r(?!\\n))"
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
