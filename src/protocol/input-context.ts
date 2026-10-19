export type ContextSource =
  | Readonly<{
      kind: "message"
      label: string
      sessionId: string
      messageId: string
    }>
  | Readonly<{
      kind: "file"
      label: string
      path: string
      sessionId?: string
    }>
  | Readonly<{
      kind: "browser"
      label: string
      url: string
    }>

// Coordinates address rendered DOM text, never Markdown or file byte offsets.
export type RenderedTextAnchor = Readonly<{
  startOffset: number
  endOffset: number
}>

export type ContextExcerpt = Readonly<{
  id: string
  text: string
  source: ContextSource
  comment?: string
  anchor?: RenderedTextAnchor
}>

export function isContextSource(value: unknown): value is ContextSource {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const source = value as Record<string, unknown>
  const required =
    source.kind === "message"
      ? ["sessionId", "messageId"]
      : source.kind === "file"
        ? ["path"]
        : source.kind === "browser"
          ? ["url"]
          : undefined
  if (!required) return false
  const allowed = ["kind", "label", ...required]
  if (source.kind === "file") allowed.push("sessionId")
  return (
    ["label", ...required].every(
      (key) => typeof source[key] === "string" && source[key].trim().length > 0,
    ) &&
    Object.keys(source).every((key) => allowed.includes(key)) &&
    (source.kind !== "file" ||
      source.sessionId === undefined ||
      (typeof source.sessionId === "string" && !!source.sessionId.trim()))
  )
}

export function isContextExcerpt(value: unknown): value is ContextExcerpt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const entry = value as Record<string, unknown>
  if (
    typeof entry.id !== "string" ||
    !entry.id.trim() ||
    typeof entry.text !== "string" ||
    !entry.text.trim() ||
    !isContextSource(entry.source) ||
    (entry.comment !== undefined && typeof entry.comment !== "string") ||
    Object.keys(entry).some(
      (key) => !["id", "text", "source", "comment", "anchor"].includes(key),
    )
  )
    return false
  if (entry.anchor === undefined) return true
  if (
    typeof entry.anchor !== "object" ||
    entry.anchor === null ||
    Array.isArray(entry.anchor)
  )
    return false
  const anchor = entry.anchor as Record<string, unknown>
  return (
    Object.keys(anchor).every((key) =>
      ["startOffset", "endOffset"].includes(key),
    ) &&
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
