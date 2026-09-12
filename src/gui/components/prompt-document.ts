import { type Node, Schema } from "prosemirror-model"

export type SkillMention = Readonly<{ name: string; path: string }>

export function skillMentionText(mention: SkillMention): string {
  return `[$${mention.name}](${mention.path})`
}

// The same path-qualified representation is understood by runtime/skills.ts.
// Atomic inline nodes are an editing concern, never a second submission format.
export const promptSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "inline*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
    skill: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { name: {}, path: {} },
      toDOM: (node) => [
        "span",
        {
          class: "prompt-skill",
          "data-skill-path": node.attrs.path,
          contenteditable: "false",
          title: node.attrs.path,
        },
        ["span", { "aria-hidden": "true", class: "prompt-skill-icon" }, "$"],
        node.attrs.name,
      ],
    },
  },
})

export function parsePrompt(text: string): Node {
  return promptSchema.node(
    "doc",
    null,
    text.split("\n").map((line) => {
      const content: Node[] = []
      let offset = 0
      for (const match of line.matchAll(/\[\$([^\]\n]+)\]\(([^)\n]+)\)/g)) {
        if (match.index > offset)
          content.push(promptSchema.text(line.slice(offset, match.index)))
        content.push(
          promptSchema.node("skill", { name: match[1], path: match[2] }),
        )
        offset = match.index + match[0].length
      }
      if (offset < line.length)
        content.push(promptSchema.text(line.slice(offset)))
      return promptSchema.node("paragraph", null, content)
    }),
  )
}

export function serializePrompt(doc: Node): string {
  const paragraphs: string[] = []
  doc.forEach((paragraph) => {
    let text = ""
    paragraph.forEach((node) => {
      text +=
        node.type.name === "skill"
          ? skillMentionText({ name: node.attrs.name, path: node.attrs.path })
          : (node.text ?? "")
    })
    paragraphs.push(text)
  })
  return paragraphs.join("\n")
}

export function promptOffset(doc: Node, position: number): number {
  let offset = 0
  doc.forEach((paragraph, start, index) => {
    if (position <= start) return
    if (index > 0) offset++
    paragraph.forEach((node, childStart) => {
      const from = start + childStart + 1
      if (position <= from) return
      offset +=
        node.type.name === "skill"
          ? skillMentionText({ name: node.attrs.name, path: node.attrs.path })
              .length
          : Math.min(position - from, node.nodeSize)
    })
  })
  return offset
}

export function promptPosition(doc: Node, offset: number): number {
  let position = 1
  let consumed = 0
  doc.forEach((paragraph, start, index) => {
    if (index > 0) consumed++
    if (consumed <= offset) position = start + 1
    paragraph.forEach((node, childStart) => {
      if (consumed > offset) return
      const length =
        node.type.name === "skill"
          ? skillMentionText({ name: node.attrs.name, path: node.attrs.path })
              .length
          : node.nodeSize
      const delta = Math.min(offset - consumed, length)
      position =
        start + childStart + 1 + (node.isText ? delta : delta === 0 ? 0 : 1)
      consumed += length
    })
  })
  return position
}
