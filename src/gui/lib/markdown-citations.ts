import type { Root, RootContent, Text } from "mdast"
import { decodeString } from "micromark-util-decode-string"
import type { Parent } from "unist"
import type { Plugin } from "unified"
import type {
  CitationMention,
  CitationSource,
} from "../../protocol/execution-view.ts"

export type InlineCitation = CitationMention &
  Readonly<{ source: CitationSource; number: number }>

const inlineAtoms = new Set([
  "inlineCode",
  "inlineMath",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "footnoteReference",
])

type Insertion = { offset: number; citationIndex: number }

type Target = {
  parent: Parent
  index: number
  start: number
  end: number
  text?: Text
  insertions?: Map<string, Insertion>
}

export function createMarkdownCitationPlugin(
  citations: readonly InlineCitation[],
): Plugin<[], Root> {
  return () => (tree, file) => {
    if (typeof file.value !== "string") return
    const targets: Target[] = []
    collectTargets(tree, targets)
    for (const [citationIndex, citation] of citations.entries()) {
      const { start, end: spanEnd } = citation.responseSpan
      const end = start + file.value.slice(start, spanEnd).trimEnd().length
      if (end === start) continue
      const target = targetBefore(targets, end)
      if (target === undefined || target.end <= start) continue
      const offset = textOffset(file.value, target, end)
      if (offset === undefined) continue
      target.insertions ??= new Map()
      const key = `${offset}:${citation.number}`
      const previous = target.insertions.get(key)
      if (
        previous !== undefined &&
        (citations[previous.citationIndex]?.citedText || !citation.citedText)
      )
        continue
      target.insertions.set(key, { offset, citationIndex })
    }
    // Replace children from right to left so their recorded indices stay valid.
    for (const target of targets.reverse()) {
      if (target.insertions === undefined) continue
      const insertions = [...target.insertions.values()].sort(
        (left, right) =>
          left.offset - right.offset ||
          left.citationIndex - right.citationIndex,
      )
      const nodes: Text[] = []
      const text = target.text?.value ?? ""
      let offset = 0
      for (const insertion of insertions) {
        if (insertion.offset > offset)
          nodes.push({
            type: "text",
            value: text.slice(offset, insertion.offset),
          })
        nodes.push({
          type: "text",
          value: "",
          data: {
            hName: "sup",
            hProperties: { dataCitationIndex: insertion.citationIndex },
          },
        })
        offset = insertion.offset
      }
      if (offset < text.length)
        nodes.push({ type: "text", value: text.slice(offset) })
      target.parent.children.splice(
        target.index + (target.text === undefined ? 1 : 0),
        target.text === undefined ? 0 : 1,
        ...nodes,
      )
    }
  }
}

function collectTargets(node: Root | RootContent, targets: Target[]): void {
  if (!("children" in node)) return
  for (const [index, child] of node.children.entries()) {
    if (child.type === "text" || inlineAtoms.has(child.type)) {
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (start !== undefined && end !== undefined && end > start)
        targets.push({
          parent: node,
          index,
          start,
          end,
          ...(child.type === "text" ? { text: child } : {}),
        })
      // Insert after links and inline code instead of nesting a link in them.
    } else if (child.type !== "footnoteDefinition")
      collectTargets(child, targets)
  }
}

function targetBefore(
  targets: readonly Target[],
  end: number,
): Target | undefined {
  let low = 0
  let high = targets.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((targets[mid]?.start ?? end) < end) low = mid + 1
    else high = mid
  }
  return targets[low - 1]
}

function textOffset(
  source: string,
  target: Target,
  end: number,
): number | undefined {
  const value = target.text?.value
  if (value === undefined) return 0
  if (end >= target.end) return value.length
  const raw = source.slice(target.start, target.end)
  const offset = end - target.start
  if (raw === value) return offset
  // Markdown escapes and entities can occupy more source characters than
  // their rendered text. Either side can also contain container indentation.
  const prefix = decodeString(raw.slice(0, offset))
  if (value.startsWith(prefix)) return prefix.length
  const suffix = decodeString(raw.slice(offset))
  if (value.endsWith(suffix)) return value.length - suffix.length
}
