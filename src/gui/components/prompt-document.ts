import { type Node, Schema } from "prosemirror-model"
import type { InputDraft } from "../../core/user-input.ts"
import type { EditorPart } from "../../gui/input-draft.ts"
import type { UserAttachment } from "../../kernel/events.ts"
import { draftFromEditorParts, draftToEditorParts } from "../input-draft.ts"

export type SkillMention = Readonly<{ name: string; path: string }>
export type FileMention = Readonly<{ name: string; path: string }>

export function skillMentionText(mention: SkillMention): string {
  return `[$${mention.name}](${mention.path})`
}

export function fileMentionText(mention: FileMention): string {
  return `[@${mention.name}](${mention.path})`
}

function mentionText(node: Node): string {
  if (node.type.name === "image" || node.type.name === "document")
    return "\uFFFC"
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
    document: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { document: {} },
      // No parseDOM rule: external HTML cannot mint a local document reference.
      toDOM: (node) => [
        "button",
        {
          class: "prompt-skill prompt-document",
          type: "button",
          "data-prompt-document": "true",
          contenteditable: "false",
          "aria-label": `Open attached PDF ${node.attrs.document.name}`,
        },
        `PDF ${node.attrs.document.name}`,
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

// Attachments are editor atoms. Cursor and suggestion offsets use a one-character
// object representation; submission keeps readable markers in the authored text.
export function parsePromptParts(draft: InputDraft): Node {
  const parts = draftToEditorParts(draft)
  const paragraphs: Node[] = []
  let content: Node[] = []
  for (const part of parts) {
    if (part.type !== "text") {
      content.push(promptSchema.node(part.type, { [part.type]: part }))
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
  resolveAttachment: (attachment: UserAttachment) => UserAttachment = (
    attachment,
  ) => attachment,
): InputDraft {
  const parts: EditorPart[] = []
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
      if (node.type.name === "image" || node.type.name === "document") {
        const attachment = resolveAttachment(
          node.attrs[node.type.name] as UserAttachment,
        )
        parts.push(
          attachment.mediaType === "application/pdf"
            ? { ...attachment, type: "document" }
            : { ...attachment, type: "image" },
        )
      } else appendText(node.isText ? (node.text ?? "") : mentionText(node))
    })
  })
  return draftFromEditorParts(parts)
}

export function promptPartsText(draft: InputDraft): string {
  return draftToEditorParts(draft)
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
