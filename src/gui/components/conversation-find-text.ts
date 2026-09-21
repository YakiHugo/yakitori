import { literalMatches } from "../../core/thread-search.ts"

// Search the logical message, keeping a map back to its rendered text nodes.
// Inline Markdown and syntax spans must not split a phrase into separate hits.
export function conversationFindRanges(
  root: HTMLElement,
  term: string,
): Range[] {
  if (term === "") return []
  const text: string[] = []
  const positions: Array<Readonly<{ node: Text; offset: number }> | undefined> =
    []
  const space = (position?: Readonly<{ node: Text; offset: number }>) => {
    if (text.length > 0 && text.at(-1) !== " ") {
      text.push(" ")
      positions.push(position)
    }
  }
  const visit = (node: Node) => {
    if (node instanceof Text) {
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const character = node.data[offset] ?? ""
        if (/\s/u.test(character)) space({ node, offset })
        else {
          text.push(character)
          positions.push({ node, offset })
        }
      }
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (
      node.matches("button,script,style,[aria-hidden=true],[data-find-ignore]")
    )
      return
    const block =
      /^(DIV|P|PRE|H[1-6]|LI|UL|OL|BLOCKQUOTE|TR|TD|TH|BR|HR)$/.test(
        node.tagName,
      )
    if (block) space()
    for (const child of node.childNodes) visit(child)
    if (block) space()
  }
  visit(root)
  return literalMatches(text.join("").trimEnd(), term).flatMap((match) => {
    const covered = positions.slice(match.start, match.end)
    const start = covered.find((point) => point !== undefined)
    const end = covered.reverse().find((point) => point !== undefined)
    if (!start || !end) return []
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset + 1)
    return [range]
  })
}
