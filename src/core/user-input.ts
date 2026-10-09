import type {
  InputContent,
  InputDraft,
  InputTextElement,
} from "../protocol/user-input.ts"

export type {
  InputContent,
  InputDraft,
  InputTextElement,
} from "../protocol/user-input.ts"

import {
  isImageAttachment,
  isPdfAttachment,
  type UserAttachment,
} from "./asset-types.ts"
import type { ModelDeveloperMessage, ModelUserMessage } from "./conversation.ts"
import { type ContextExcerpt, isContextExcerpts } from "./input-context.ts"

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
  if (isInputContent(value)) return value
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid stored input content.")
  const stored = value as Record<string, unknown>
  if (
    stored.contextAttachments !== undefined &&
    !isContextExcerpts(stored.contextAttachments)
  )
    throw new TypeError("Invalid stored input references.")
  const references = stored.contextAttachments
  if (
    stored.kind === "parts" &&
    Object.keys(stored).every((key) =>
      ["kind", "parts", "contextAttachments"].includes(key),
    ) &&
    Array.isArray(stored.parts)
  )
    return inputFromStoredParts(stored.parts, references)
  if (
    stored.kind === "text" &&
    Object.keys(stored).every((key) =>
      ["kind", "text", "attachments", "contextAttachments"].includes(key),
    ) &&
    typeof stored.text === "string" &&
    (stored.attachments === undefined ||
      (Array.isArray(stored.attachments) &&
        stored.attachments.every(isImageAttachment)))
  )
    return inputFromStoredParts(
      [
        { type: "text", text: stored.text },
        ...(stored.attachments ?? []).map((image) => ({
          type: "image",
          ...image,
        })),
      ],
      references,
    )
  throw new TypeError("Invalid stored input content.")
}

// Old rollouts have model blocks but no authored draft. Reconstruct attachment
// atoms in their recorded positions; inline request media has no editable source.
export function inputContentFromModelMessage(
  message: ModelUserMessage,
): InputContent | undefined {
  const parts: unknown[] = []
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text })
    } else {
      if (block.file === undefined) return undefined
      parts.push({
        type: block.type,
        name:
          block.name ??
          ("path" in block.file
            ? block.file.path.split("/").at(-1)
            : undefined) ??
          "image",
        mediaType: block.mediaType,
        sizeBytes: block.sizeBytes,
        file: block.file,
        ...(block.type === "image" ? { detail: block.detail ?? "high" } : {}),
      })
    }
  }
  return inputFromStoredParts(parts, message.contextAttachments)
}

// Only storage reads accept the retired shapes. Live requests and every new
// write use InputContent; no ordered input-parts contract escapes this adapter.
function inputFromStoredParts(
  parts: readonly unknown[],
  references?: readonly ContextExcerpt[],
): InputContent {
  let text = ""
  const attachments: UserAttachment[] = []
  const elements: InputTextElement[] = []
  for (const value of parts) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Invalid stored input part.")
    const part = value as Record<string, unknown>
    if (part.type === "text") {
      if (
        typeof part.text !== "string" ||
        Object.keys(part).some((key) => !["type", "text"].includes(key))
      )
        throw new TypeError("Invalid stored input text.")
      text += part.text
      continue
    }
    const { type, ...attachment } = part
    if (
      !(type === "image" && isImageAttachment(attachment)) &&
      !(type === "document" && isPdfAttachment(attachment))
    )
      throw new TypeError("Invalid stored input attachment.")
    const marker = `[${type === "image" ? "Image" : "Document"} ${attachments.length + 1}]`
    elements.push({
      startOffset: text.length,
      endOffset: text.length + marker.length,
      attachmentIndex: attachments.length,
    })
    text += marker
    attachments.push(
      isImageAttachment(attachment)
        ? { ...attachment, detail: attachment.detail ?? "high" }
        : attachment,
    )
  }
  return createUserInput(text, attachments, elements, references)
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
