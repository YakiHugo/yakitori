import type { Link, Root, Strong, Text } from "mdast"
import type { Node, Parent } from "unist"
import type { Plugin } from "unified"

const urlTerminators = new Set([
  "。",
  "，",
  "、",
  "；",
  "：",
  "？",
  "！",
  "…",
  "【",
  "】",
  "《",
  "》",
  "「",
  "」",
  "『",
  "』",
  "“",
  "”",
  "‘",
  "’",
  "〈",
  "〉",
  "～",
])

export function cjkAutolinkUrlEnd(url: string): number {
  let depth = 0
  let firstUnmatchedOpen = -1
  for (let index = 0; index < url.length; index++) {
    const char = url[index] ?? ""
    if (char === "（") {
      if (depth === 0) firstUnmatchedOpen = index
      depth++
    } else if (char === "）") {
      if (depth === 0) return index
      depth--
    } else if (depth === 0 && urlTerminators.has(char)) {
      return index
    }
  }
  return depth > 0 ? firstUnmatchedOpen : url.length
}

function isText(node: Node | undefined): node is Text {
  return node?.type === "text"
}

function isLink(node: Node | undefined): node is Link {
  return node?.type === "link"
}

function isStrong(node: Node | undefined): node is Strong {
  return node?.type === "strong"
}

function isAutolinkLiteral(
  node: Node | undefined,
  source: string,
): node is Link {
  if (!isLink(node) || node.children.length !== 1) return false
  const label = node.children[0]
  if (!isText(label) || !node.url.endsWith(label.value)) return false
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return (
    start !== undefined &&
    end !== undefined &&
    source.slice(start, end) === label.value
  )
}

function trimAutolink(link: Link): string {
  const label = link.children[0]
  if (!isText(label)) return ""
  const end = cjkAutolinkUrlEnd(label.value)
  if (end >= label.value.length) return ""
  const tail = label.value.slice(end)
  label.value = label.value.slice(0, end)
  link.url = link.url.slice(0, link.url.length - tail.length)
  return tail
}

const boldLabel = /(^|\s)\*\*([^\s*][^*]*?)(?:\*\*)?$/u

function repairBoldLabel(
  children: Node[],
  index: number,
  source: string,
): Array<Text | Strong | Link> | undefined {
  const text = children[index]
  if (!isText(text)) return undefined
  const match = boldLabel.exec(text.value)
  const label = match?.[2]
  if (!match || !label) return undefined

  const next = children[index + 1]
  const bareLink = isAutolinkLiteral(next, source) ? next : undefined
  const wrappedLink =
    isStrong(next) &&
    next.children.length === 1 &&
    isAutolinkLiteral(next.children[0], source)
      ? next.children[0]
      : undefined
  const link = bareLink ?? wrappedLink
  if (!link) return undefined

  const prefix = text.value.slice(0, match.index + (match[1]?.length ?? 0))
  return [
    ...(prefix ? [{ type: "text", value: prefix } satisfies Text] : []),
    {
      type: "strong",
      children: [{ type: "text", value: label } satisfies Text],
    } satisfies Strong,
    link,
  ]
}

function visit(parent: Parent, source: string): void {
  for (let index = 0; index < parent.children.length; index++) {
    const node = parent.children[index]
    if (!node) continue
    if (isAutolinkLiteral(node, source)) {
      const tail = trimAutolink(node)
      if (tail) {
        const tailNode: Text = { type: "text", value: tail }
        parent.children.splice(index + 1, 0, tailNode)
        index++
        continue
      }
    }
    const repaired = repairBoldLabel(parent.children, index, source)
    if (repaired) {
      parent.children.splice(index, 2, ...repaired)
      index += repaired.length - 1
      continue
    }
    if ("children" in node) visit(node as Parent, source)
  }
}

export function createCjkAutolinkPlugin(): Plugin<[], Root> {
  return () => (tree, file) => {
    if (typeof file.value === "string") visit(tree, file.value)
  }
}
