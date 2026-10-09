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
  // UTF-16 offsets in the rendered source text, independent of provider citations.
  anchor: Readonly<{ startOffset: number; endOffset: number }>
}>

export type ContextExcerpt = SelectedTextAttachment | ResponseAnnotation
