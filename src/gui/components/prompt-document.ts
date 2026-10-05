import type { InputPart, ImageAttachment } from "../../kernel/events.ts"
import { type Node, Schema } from "prosemirror-model"

export type SkillMention = Readonly<{ name: string; path: string }>
export type FileMention = Readonly<{ name: string; path: string }>

export function skillMentionText(mention: SkillMention): string {
  return `[$${mention.name}](${mention.path})`
}

export function fileMentionText(mention: FileMention): string {
  return `[@${mention.name}](${mention.path})`
}

function mentionText(node: Node): string {
  if (node.type.name === "image") return "\uFFFC"
  return node.type.name === "skill"
    ? skillMentionText({ name: node.attrs.name, path: node.attrs.path })
    : fileMentionText({ name: node.attrs.name, path: node.attrs.path })
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
    image: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { image: {} },
      // No parseDOM rule: pasted HTML must never mint a local asset reference.
      toDOM: (node) => [
        "button",
        {
          class: "prompt-skill prompt-image",
          type: "button",
          "data-prompt-image": "true",
          "aria-label": `Preview attached image ${node.attrs.image.name}`,
          contenteditable: "false",
        },
        `▧ ${node.attrs.image.name}`,
      ],
    },
    skill: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { name: {}, path: {} },
      toDOM: (node) => [
        "button",
        {
          class: "prompt-skill",
          type: "button",
          "data-skill-path": node.attrs.path,
          "data-skill-name": node.attrs.name,
          contenteditable: "false",
          title: node.attrs.path,
        },
        node.attrs.name,
      ],
    },
    file: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { name: {}, path: {} },
      toDOM: (node) => [
        "span",
        {
          class: "prompt-skill prompt-file",
          "data-file-path": node.attrs.path,
          contenteditable: "false",
          title: node.attrs.path,
        },
        ["span", { "aria-hidden": "true", class: "prompt-skill-icon" }, "@"],
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
      for (const match of line.matchAll(/\[([$@])([^\]\n]+)\]\(([^)\n]+)\)/g)) {
        if (match.index > offset)
          content.push(promptSchema.text(line.slice(offset, match.index)))
        content.push(
          promptSchema.node(match[1] === "$" ? "skill" : "file", {
            name: match[2],
            path: match[3],
          }),
        )
        offset = match.index + match[0].length
      }
      if (offset < line.length)
        content.push(promptSchema.text(line.slice(offset)))
      return promptSchema.node("paragraph", null, content)
    }),
  )
}

// Images are editor atoms, not textual placeholders in a submitted request.
// Only cursor/suggestion offsets use the one-character object representation.
export function parsePromptParts(parts: readonly InputPart[]): Node {
  const paragraphs: Node[] = []
  let content: Node[] = []
  for (const part of parts) {
    if (part.type === "image") {
      content.push(promptSchema.node("image", { image: part }))
      continue
    }
    parsePrompt(part.text).forEach((paragraph, _offset, index) => {
      if (index > 0) {
        paragraphs.push(promptSchema.node("paragraph", null, content))
        content = []
      }
      paragraph.forEach((node) => {
        content.push(node)
      })
    })
  }
  paragraphs.push(promptSchema.node("paragraph", null, content))
  return promptSchema.node("doc", null, paragraphs)
}

export function serializePromptParts(
  doc: Node,
  resolveImage: (image: ImageAttachment) => ImageAttachment = (image) => image,
): readonly InputPart[] {
  const parts: InputPart[] = []
  const appendText = (text: string) => {
    if (text === "") return
    const last = parts.at(-1)
    if (last?.type === "text")
      parts[parts.length - 1] = { type: "text", text: last.text + text }
    else parts.push({ type: "text", text })
  }
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) appendText("\n")
    paragraph.forEach((node) => {
      if (node.type.name === "image")
        parts.push({
          ...resolveImage(node.attrs.image as ImageAttachment),
          type: "image",
        })
      else appendText(node.isText ? (node.text ?? "") : mentionText(node))
    })
  })
  return parts
}

export function promptPartsText(parts: readonly InputPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : "\uFFFC"))
    .join("")
}

export function serializePrompt(doc: Node): string {
  const paragraphs: string[] = []
  doc.forEach((paragraph) => {
    let text = ""
    paragraph.forEach((node) => {
      text += node.isText ? (node.text ?? "") : mentionText(node)
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
      offset += node.isText
        ? Math.min(position - from, node.nodeSize)
        : mentionText(node).length
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
      const length = node.isText ? node.nodeSize : mentionText(node).length
      const delta = Math.min(offset - consumed, length)
      position =
        start + childStart + 1 + (node.isText ? delta : delta === 0 ? 0 : 1)
      consumed += length
    })
  })
  return position
}
