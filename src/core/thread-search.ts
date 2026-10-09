export { literalMatches } from "../shared/literal-matches.ts"

import type { Nodes } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import type { ThreadSummary } from "./rollout.ts"

export type ThreadSearchOccurrence = Readonly<{
  turnId: string
  itemId: string
  snippet: string
  snippetMatchRange: Readonly<{ start: number; end: number }>
}>

export function compareThreadSummaries(
  left: ThreadSummary,
  right: ThreadSummary,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id)
  )
}

export function threadCursor(summary: ThreadSummary): string {
  return JSON.stringify({ updatedAt: summary.updatedAt, id: summary.id })
}

export function startAfterThreadCursor(
  summaries: readonly ThreadSummary[],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 0
  const anchor = parseThreadCursor(cursor)
  const index = summaries.findIndex(
    (summary) =>
      summary.updatedAt < anchor.updatedAt ||
      (summary.updatedAt === anchor.updatedAt && summary.id < anchor.id),
  )
  return index < 0 ? summaries.length : index
}

// Match the GUI's existing CommonMark/GFM parser. Regex removal cannot
// distinguish literal punctuation, code, escaped text and table delimiters.
const markdownParser = unified().use(remarkParse).use(remarkGfm)

export function markdownVisibleText(markdown: string): string {
  const document = markdownParser.parse(markdown)
  const footnotes = new Map<
    string,
    Extract<Nodes, { type: "footnoteDefinition" }>
  >()
  const collectFootnotes = (node: Nodes): void => {
    // Definitions can occur in containers. Like the GUI's mdast-to-hast
    // conversion, the first definition owns an identifier throughout the tree.
    if (node.type === "footnoteDefinition" && !footnotes.has(node.identifier))
      footnotes.set(node.identifier, node)
    if ("children" in node) node.children.forEach(collectFootnotes)
  }
  collectFootnotes(document)
  const referencedFootnotes: string[] = []
  const visible = (node: Nodes): string => {
    switch (node.type) {
      case "text":
      case "inlineCode":
      case "code":
      // react-markdown's default skipHtml=false displays raw HTML as text;
      // it does not interpret markup or decode entities within that markup.
      case "html":
        return node.type === "code" ? ` ${node.value} ` : node.value
      case "break":
      case "thematicBreak":
        return " "
      case "definition":
      case "footnoteDefinition":
      case "image":
      case "imageReference":
        return ""
      case "footnoteReference": {
        let index = referencedFootnotes.indexOf(node.identifier)
        if (index === -1) index = referencedFootnotes.push(node.identifier) - 1
        return String(index + 1)
      }
      default: {
        if (!("children" in node)) return ""
        const phrasing =
          node.type === "paragraph" ||
          node.type === "heading" ||
          node.type === "tableCell" ||
          node.type === "emphasis" ||
          node.type === "strong" ||
          node.type === "delete" ||
          node.type === "link" ||
          node.type === "linkReference"
        const content = node.children.map(visible).join(phrasing ? "" : " ")
        return node.type === "emphasis" ||
          node.type === "strong" ||
          node.type === "delete" ||
          node.type === "link" ||
          node.type === "linkReference"
          ? content
          : ` ${content} `
      }
    }
  }
  let text = visible(document)
  // Footnote definitions are rendered after the body in first-reference order.
  // Iteration also visits definitions referenced from another footnote.
  for (const identifier of referencedFootnotes) {
    const definition = footnotes.get(identifier)
    if (definition) text += ` ${definition.children.map(visible).join("")} `
  }
  return text.replace(/\s+/gu, " ").trim()
}

export function snippetForMatch(
  text: string,
  match: Readonly<{ start: number; end: number }>,
): Readonly<{
  snippet: string
  snippetMatchRange: Readonly<{ start: number; end: number }>
}> {
  const start = Math.max(0, match.start - 48)
  const end = Math.min(text.length, match.end + 96)
  return {
    snippet: text.slice(start, end),
    snippetMatchRange: {
      start: match.start - start,
      end: match.end - start,
    },
  }
}

export function parseThreadCursor(cursor: string): Readonly<{
  updatedAt: string
  id: string
}> {
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch (cause) {
    throw new Error("Thread cursor is invalid.", { cause })
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Thread cursor is invalid.")
  }
  return { updatedAt: value.updatedAt, id: value.id }
}
