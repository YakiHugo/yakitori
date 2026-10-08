import {
  isImageAttachment,
  isPdfAttachment,
  type UserAttachment,
} from "./asset-types.ts"
import type { ModelDeveloperMessage, ModelUserMessage } from "./conversation.ts"
import { type ContextExcerpt, isContextExcerpts } from "./input-context.ts"

// JavaScript and renderer selections use UTF-16 offsets (Codex uses UTF-8 byte
// ranges). Elements mark editor atoms in one text, never model content ordering.
export type InputTextElement = Readonly<{
  startOffset: number
  endOffset: number
  attachmentIndex: number
}>
export type InputDraft = Readonly<{
  kind: "input"
  text: string
  elements: readonly InputTextElement[]
  attachments: readonly UserAttachment[]
}>
export type InputContent = Readonly<
  InputDraft & { kind: "input"; references?: readonly ContextExcerpt[] }
>

export function createUserInput(
  text: string,
  attachments: readonly UserAttachment[] = [],
  elements: readonly InputTextElement[] = [],
  references?: readonly ContextExcerpt[],
): InputContent {
  return {
    kind: "input",
    text,
    elements,
    attachments,
    ...(references === undefined ? {} : { references }),
  }
}
// Plain-text commands and hooks exclude attachment marker atoms. The authored
// text, including those markers, remains intact for persistence and model input.
export function inputContentText(content: InputDraft): string {
  let text = "",
    offset = 0
  for (const element of content.elements) {
    text += content.text.slice(offset, element.startOffset)
    offset = element.endOffset
  }
  return text + content.text.slice(offset)
}
export function inputContentAttachments(
  content: InputDraft,
): readonly UserAttachment[] {
  return content.attachments
}
export function replaceInputAttachments(
  content: InputContent,
  attachments: readonly UserAttachment[],
): InputContent {
  if (
    attachments.length !== content.attachments.length ||
    attachments.some(
      (attachment, index) =>
        attachment.mediaType !== content.attachments[index]?.mediaType,
    )
  )
    throw new Error(
      "Replacement input attachments do not match submitted content.",
    )
  return { ...content, attachments }
}
export function inputContentToModelMessage(
  content: InputContent,
  goalId?: string,
): ModelUserMessage | ModelDeveloperMessage {
  if (goalId !== undefined) {
    if (content.attachments.length || content.references?.length)
      throw new TypeError("Goal input must contain only text.")
    return {
      role: "developer",
      content: [{ type: "text", text: content.text }],
      context: { type: "goal", goalId },
    }
  }
  return {
    role: "user",
    content: [
      ...content.attachments.map((attachment) =>
        attachment.mediaType === "application/pdf"
          ? { type: "document" as const, ...attachment }
          : {
              type: "image" as const,
              ...attachment,
              detail: attachment.detail ?? "high",
            },
      ),
      ...(content.text === ""
        ? []
        : [{ type: "text" as const, text: content.text }]),
    ],
    ...(content.references === undefined
      ? {}
      : { contextAttachments: content.references }),
  }
}
export function isInputContent(value: unknown): value is InputContent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const input = value as Record<string, unknown>
  if (
    input.kind !== "input" ||
    typeof input.text !== "string" ||
    Object.keys(input).some(
      (key) =>
        !["kind", "text", "elements", "attachments", "references"].includes(
          key,
        ),
    ) ||
    !Array.isArray(input.attachments) ||
    !input.attachments.every(
      (attachment) =>
        isImageAttachment(attachment) || isPdfAttachment(attachment),
    ) ||
    !Array.isArray(input.elements) ||
    (input.references !== undefined && !isContextExcerpts(input.references))
  )
    return false
  let end = 0
  const used = new Set<number>()
  for (const element of input.elements) {
    if (
      typeof element !== "object" ||
      element === null ||
      Array.isArray(element)
    )
      return false
    const marker = element as Record<string, unknown>
    if (
      Object.keys(marker).some(
        (key) => !["startOffset", "endOffset", "attachmentIndex"].includes(key),
      ) ||
      typeof marker.startOffset !== "number" ||
      typeof marker.endOffset !== "number" ||
      typeof marker.attachmentIndex !== "number" ||
      !Number.isSafeInteger(marker.startOffset) ||
      !Number.isSafeInteger(marker.endOffset) ||
      !Number.isSafeInteger(marker.attachmentIndex) ||
      marker.startOffset < end ||
      marker.endOffset <= marker.startOffset ||
      marker.endOffset > input.text.length ||
      marker.attachmentIndex < 0 ||
      marker.attachmentIndex >= input.attachments.length ||
      used.has(marker.attachmentIndex)
    )
      return false
    for (const offset of [marker.startOffset, marker.endOffset]) {
      const before = input.text.charCodeAt(offset - 1),
        after = input.text.charCodeAt(offset)
      if (
        before >= 0xd800 &&
        before <= 0xdbff &&
        after >= 0xdc00 &&
        after <= 0xdfff
      )
        return false
    }
    end = marker.endOffset
    used.add(marker.attachmentIndex)
  }
  return true
}
export function readStoredInputContent(value: unknown): InputContent {
  if (!isInputContent(value))
    throw new TypeError("Invalid stored input content.")
  return value
}

export function inputContent(
  draft: InputDraft,
  references?: readonly ContextExcerpt[],
): InputContent {
  return {
    ...draft,
    kind: "input",
    ...(references === undefined ? {} : { references }),
  }
}
