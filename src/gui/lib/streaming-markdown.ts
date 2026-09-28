import type { Root, RootContent } from "mdast"
import type { Plugin, Parser as UnifiedParser } from "unified"

type MarkdownParser = UnifiedParser<Root>

type CachedPrefix = {
  source: string
  offset: number
  lineOffset: number
  children: RootContent[]
}

function containsDefinition(node: Root | RootContent): boolean {
  if (node.type === "definition" || node.type === "footnoteDefinition")
    return true
  return "children" in node && node.children.some(containsDefinition)
}

function movePositions(
  node: Root | RootContent,
  offset: number,
  lines: number,
) {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset
      point.line += lines
    }
  }
  if ("children" in node)
    for (const child of node.children) movePositions(child, offset, lines)
}

// A finished top-level fenced block followed by a blank line is a safe
// parsing boundary for appended output. Definitions can refer backward or
// forward across that boundary, so they fall back to a full parse.
export function createStreamingMarkdownPlugin(): Plugin<[], Root> {
  let cached: CachedPrefix | undefined
  return function () {
    const original = this.parser
    if (original === undefined) return
    const parse: MarkdownParser = (source, file) =>
      original(source, file) as Root
    let parsedDocument = false
    this.parser = (source, file) => {
      if (parsedDocument) return original(source, file)
      parsedDocument = true
      if (source.includes("\r") || source.includes("\uFEFF"))
        return parse(source, file)

      const prefix =
        cached && source.startsWith(cached.source) ? cached : undefined
      const root = prefix
        ? parse(source.slice(prefix.offset), file)
        : parse(source, file)
      if (containsDefinition(root)) return parse(source, file)
      if (prefix) {
        movePositions(root, prefix.offset, prefix.lineOffset)
        if (root.position)
          root.position.start = { line: 1, column: 1, offset: 0 }
        root.children.unshift(...structuredClone(prefix.children))
      }

      for (let index = root.children.length - 1; index >= 0; index--) {
        const node = root.children[index]
        if (node?.type !== "code") continue
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start === undefined || end === undefined) continue
        if (prefix && end < prefix.offset) break
        const block = source.slice(start, end)
        const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(block)?.[1]
        if (fence === undefined) continue
        const close = block.slice(block.lastIndexOf("\n") + 1)
        const closingFence = new RegExp(
          `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`,
        )
        const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0]
        if (!closingFence.test(close) || separator === undefined) continue
        const offset = end + separator.length
        cached = {
          source: source.slice(0, offset),
          offset,
          lineOffset: (node.position?.end.line ?? 1) + 1,
          children: structuredClone(root.children.slice(0, index + 1)),
        }
        break
      }
      return root
    }
  }
}
