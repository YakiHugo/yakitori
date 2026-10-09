export function literalMatches(
  text: string,
  searchTerm: string,
  limit = Number.POSITIVE_INFINITY,
): readonly Readonly<{ start: number; end: number }>[] {
  const matcher = new RegExp(escapeRegularExpression(searchTerm), "giu")
  const matches: Array<Readonly<{ start: number; end: number }>> = []
  for (const match of text.matchAll(matcher)) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
    })
    if (matches.length >= limit) break
  }
  return matches
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
