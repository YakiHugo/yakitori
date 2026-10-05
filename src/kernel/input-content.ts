import {
  type ImageAttachment,
  type InputContent,
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

export function inputContentImages(
  content: InputContent,
): readonly ImageAttachment[] {
  return content.parts.flatMap((part) => {
    if (part.type !== "image") return []
    const { type: _type, ...attachment } = part
    return [attachment]
  })
}

export function replaceInputImages(
  content: InputContent,
  images: readonly ImageAttachment[],
): InputContent {
  let index = 0
  const parts = content.parts.map((part) => {
    if (part.type !== "image") return part
    const image = images[index++]
    if (image === undefined) throw new Error("Missing replacement input image.")
    return { type: "image" as const, ...image }
  })
  if (index !== images.length)
    throw new Error("Unexpected replacement input image.")
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
