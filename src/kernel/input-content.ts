import {
  type ImageAttachment,
  type InputContent,
  type UserAttachment,
  isImageAttachment,
  isInputContent,
  type ModelDeveloperMessage,
  type ModelUserMessage,
} from "./events.ts"
import { isContextExcerpts } from "./input-context.ts"

// Derived views for text-only hooks, budgets, and asset storage. Never persist
// these beside parts or use them to reconstruct authored input.
export function inputContentText(content: InputContent): string {
  return content.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
}

export function inputContentAttachments(
  content: InputContent,
): readonly UserAttachment[] {
  return content.parts.flatMap((part): UserAttachment[] => {
    if (part.type === "text") return []
    const { type: _type, ...attachment } = part
    return [attachment]
  })
}

export function replaceInputAttachments(
  content: InputContent,
  attachments: readonly UserAttachment[],
): InputContent {
  let index = 0
  const parts = content.parts.map((part) => {
    if (part.type === "text") return part
    const attachment = attachments[index++]
    if (attachment === undefined)
      throw new Error("Missing replacement input attachment.")
    if (
      (part.type === "document") !==
      (attachment.mediaType === "application/pdf")
    )
      throw new Error(
        "Replacement input attachment type does not match its slot.",
      )
    return attachment.mediaType === "application/pdf"
      ? { type: "document" as const, ...attachment }
      : { type: "image" as const, ...attachment }
  })
  if (index !== attachments.length)
    throw new Error("Unexpected replacement input attachment.")
  return { ...content, parts }
}

export function inputContentToModelMessage(
  content: InputContent,
  goalId?: string,
): ModelUserMessage | ModelDeveloperMessage {
  if (goalId !== undefined) {
    if (
      content.parts.some((part) => part.type !== "text") ||
      (content.contextAttachments?.length ?? 0) !== 0
    )
      throw new TypeError("Goal input must contain only text.")
    return {
      role: "developer",
      content: content.parts.map((part) => {
        if (part.type !== "text")
          throw new TypeError("Goal input must contain only text.")
        return part
      }),
      context: { type: "goal", goalId },
    }
  }
  return {
    role: "user",
    content: content.parts.map((part) =>
      part.type === "image" ? { ...part, detail: part.detail ?? "high" } : part,
    ),
    ...(content.contextAttachments === undefined
      ? {}
      : { contextAttachments: content.contextAttachments }),
  }
}

// Only shipped queue/recovery records need this old text-then-images shape.
// Callers must use it at storage reads, never to admit a legacy live request.
export function readStoredInputContent(value: unknown): InputContent {
  if (isInputContent(value)) return value
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid stored input content.")
  const record = value as Record<string, unknown>
  if (
    record.kind !== "text" ||
    typeof record.text !== "string" ||
    Object.keys(record).some(
      (key) =>
        !["kind", "text", "attachments", "contextAttachments"].includes(key),
    ) ||
    (record.attachments !== undefined &&
      (!Array.isArray(record.attachments) ||
        !record.attachments.every(isImageAttachment))) ||
    (record.contextAttachments !== undefined &&
      !isContextExcerpts(record.contextAttachments))
  )
    throw new TypeError("Invalid stored input content.")
  return {
    kind: "parts",
    parts: [
      ...(record.text === ""
        ? []
        : [{ type: "text" as const, text: record.text }]),
      ...((record.attachments ?? []) as readonly ImageAttachment[]).map(
        (image) => ({ type: "image" as const, ...image }),
      ),
    ],
    ...(record.contextAttachments === undefined
      ? {}
      : { contextAttachments: record.contextAttachments }),
  }
}
