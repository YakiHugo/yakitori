import type { ImageAttachment, PdfAttachment } from "../core/asset-types.ts"
import type { ContextExcerpt } from "../core/input-context.ts"
import {
  createUserInput,
  type InputContent,
  type InputDraft,
} from "../core/user-input.ts"
export type EditorPart =
  | Readonly<{ type: "text"; text: string }>
  | (Readonly<{ type: "image" }> & ImageAttachment)
  | (Readonly<{ type: "document" }> & PdfAttachment)

export function draftFromEditorParts(
  parts: readonly EditorPart[],
  references?: readonly ContextExcerpt[],
): InputContent {
  let text = ""
  const elements: InputDraft["elements"][number][] = []
  const attachments: InputDraft["attachments"][number][] = []
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text
      continue
    }
    const { type, ...attachment } = part
    const index = attachments.length
    const marker = `[${type === "image" ? "Image" : "Document"} ${index + 1}]`
    elements.push({
      startOffset: text.length,
      endOffset: text.length + marker.length,
      attachmentIndex: index,
    })
    text += marker
    attachments.push(attachment)
  }
  return createUserInput(text, attachments, elements, references)
}

export function draftToEditorParts(draft: InputDraft): readonly EditorPart[] {
  const parts: EditorPart[] = []
  let offset = 0
  const included = new Set<number>()
  for (const element of draft.elements) {
    if (element.startOffset > offset)
      parts.push({
        type: "text",
        text: draft.text.slice(offset, element.startOffset),
      })
    const attachment = draft.attachments[element.attachmentIndex]
    if (!attachment) throw new Error("Input marker has no attachment.")
    parts.push(
      attachment.mediaType === "application/pdf"
        ? { type: "document", ...attachment }
        : { type: "image", ...attachment },
    )
    included.add(element.attachmentIndex)
    offset = element.endOffset
  }
  if (offset < draft.text.length)
    parts.push({ type: "text", text: draft.text.slice(offset) })
  for (const [index, attachment] of draft.attachments.entries())
    if (!included.has(index))
      parts.push(
        attachment.mediaType === "application/pdf"
          ? { type: "document", ...attachment }
          : { type: "image", ...attachment },
      )
  return parts
}

import { assetSourceKey } from "../core/asset-types.ts"

export function textInputDraft(text: string): InputDraft {
  return { kind: "input", text, elements: [], attachments: [] }
}
export function sameInputDraft(left: InputDraft, right: InputDraft): boolean {
  return (
    left.text === right.text &&
    JSON.stringify(left.elements) === JSON.stringify(right.elements) &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => {
      const other = right.attachments[index]
      return (
        other !== undefined &&
        attachment.name === other.name &&
        attachment.mediaType === other.mediaType &&
        attachment.sizeBytes === other.sizeBytes &&
        ("detail" in attachment ? attachment.detail : undefined) ===
          ("detail" in other ? other.detail : undefined) &&
        assetSourceKey(attachment.file) === assetSourceKey(other.file)
      )
    })
  )
}
export function trimInputDraft(draft: InputDraft): InputDraft {
  const text = draft.text.trim()
  const shift = draft.text.length - draft.text.trimStart().length
  return {
    ...draft,
    text,
    elements: draft.elements.map((element) => ({
      ...element,
      startOffset: element.startOffset - shift,
      endOffset: element.endOffset - shift,
    })),
  }
}
export function joinInputDrafts(
  drafts: readonly (InputDraft | undefined)[],
): InputDraft {
  let text = ""
  const attachments: InputDraft["attachments"][number][] = []
  const elements: InputDraft["elements"][number][] = []
  for (const draft of drafts) {
    if (!draft || (!draft.text && !draft.attachments.length)) continue
    if (text) text += "\n"
    const offset = text.length,
      attachmentOffset = attachments.length
    elements.push(
      ...draft.elements.map((element) => ({
        startOffset: element.startOffset + offset,
        endOffset: element.endOffset + offset,
        attachmentIndex: element.attachmentIndex + attachmentOffset,
      })),
    )
    text += draft.text
    attachments.push(...draft.attachments)
  }
  return { kind: "input", text, attachments, elements }
}
export function hasInputDraft(draft: InputDraft): boolean {
  return draft.text.length > 0 || draft.attachments.length > 0
}

// Transcript presentation has one text root. Wire/media ordering does not split
// selectable user text into unrelated coordinate systems.
export function inputDisplayParts(draft: InputDraft): readonly EditorPart[] {
  return [
    ...draft.attachments.map(
      (attachment): EditorPart =>
        attachment.mediaType === "application/pdf"
          ? { type: "document", ...attachment }
          : { type: "image", ...attachment },
    ),
    ...(draft.text ? [{ type: "text" as const, text: draft.text }] : []),
  ]
}
export function attachmentInputDraft(
  attachments: InputDraft["attachments"],
): InputDraft {
  return draftFromEditorParts(
    attachments.map(
      (attachment): EditorPart =>
        attachment.mediaType === "application/pdf"
          ? { type: "document", ...attachment }
          : { type: "image", ...attachment },
    ),
  )
}
