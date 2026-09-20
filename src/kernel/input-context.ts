export type ContextSource = Readonly<{
  kind: "message" | "file" | "browser"
  label: string
  sessionId?: string
  messageId?: string
  path?: string
  url?: string
}>

export type SelectedTextAttachment = Readonly<{
  id: string
  kind: "selection"
  text: string
  source: ContextSource
}>

export type ResponseAnnotation = Readonly<{
  id: string
  kind: "annotation"
  text: string
  comment?: string
  source: ContextSource
  anchor: Readonly<{ startOffset: number; endOffset: number }>
}>

export type ContextExcerpt = SelectedTextAttachment | ResponseAnnotation

export function isContextExcerpt(value: unknown): value is ContextExcerpt {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  if (
    typeof entry.id !== "string" ||
    !entry.id.trim() ||
    typeof entry.text !== "string" ||
    !entry.text.trim() ||
    typeof entry.source !== "object" ||
    entry.source === null
  )
    return false
  const source = entry.source as Record<string, unknown>
  if (
    !["message", "file", "browser"].includes(String(source.kind)) ||
    typeof source.label !== "string" ||
    !source.label.trim() ||
    !["sessionId", "messageId", "path", "url"].every(
      (key) => source[key] === undefined || typeof source[key] === "string",
    )
  )
    return false
  if (entry.kind === "selection") return true
  if (
    entry.kind !== "annotation" ||
    (entry.comment !== undefined && typeof entry.comment !== "string") ||
    typeof entry.anchor !== "object" ||
    entry.anchor === null
  )
    return false
  const anchor = entry.anchor as Record<string, unknown>
  return (
    Number.isSafeInteger(anchor.startOffset) &&
    Number.isSafeInteger(anchor.endOffset) &&
    (anchor.startOffset as number) >= 0 &&
    (anchor.endOffset as number) > (anchor.startOffset as number)
  )
}

export function isContextExcerpts(
  value: unknown,
): value is readonly ContextExcerpt[] {
  return Array.isArray(value) && value.every(isContextExcerpt)
}
