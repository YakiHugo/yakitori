import type { InputContent } from "../../src/core/user-input.ts"

// Fixture construction accepts malformed fields for API validation tests. It is
// independent of the editor serializer; expectations use explicit record data.
export function inputFixture(
  parts: unknown,
  references?: unknown,
): InputContent {
  if (!Array.isArray(parts))
    return {
      ...(parts as InputContent),
      kind: "input",
      ...(references === undefined ? {} : { references }),
    } as unknown as InputContent
  let text = ""
  const attachments: Record<string, unknown>[] = []
  const elements: {
    startOffset: number
    endOffset: number
    attachmentIndex: number
  }[] = []
  for (const value of parts) {
    const part = value as Record<string, unknown>
    if (part.type === "text") {
      text += part.text as string
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
  return {
    kind: "input",
    text,
    attachments,
    elements,
    ...(references === undefined ? {} : { references }),
  } as unknown as InputContent
}
