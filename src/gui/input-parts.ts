import type { InputPart } from "../kernel/events.ts"

export function textInputParts(text: string): readonly InputPart[] {
  return text === "" ? [] : [{ type: "text", text }]
}

export function sameInputParts(
  left: readonly InputPart[],
  right: readonly InputPart[],
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => {
      const other = right[index]
      if (part.type === "text")
        return other?.type === "text" && part.text === other.text
      return (
        other?.type === "image" &&
        part.name === other.name &&
        part.mediaType === other.mediaType &&
        part.sizeBytes === other.sizeBytes &&
        part.detail === other.detail &&
        part.file.rolloutId === other.file.rolloutId &&
        part.file.path === other.file.path
      )
    })
  )
}

export function trimInputParts(
  parts: readonly InputPart[],
): readonly InputPart[] {
  const result = [...parts]
  for (;;) {
    const first = result[0]
    if (first?.type !== "text") break
    const text = first.text.trimStart()
    if (text !== "") {
      result[0] = { type: "text", text }
      break
    }
    result.shift()
  }
  for (;;) {
    const last = result.at(-1)
    if (last?.type !== "text") break
    const text = last.text.trimEnd()
    if (text !== "") {
      result[result.length - 1] = { type: "text", text }
      break
    }
    result.pop()
  }
  return result
}

export function joinInputDrafts(
  drafts: readonly (readonly InputPart[] | undefined)[],
): readonly InputPart[] {
  const parts: InputPart[] = []
  for (const draft of drafts) {
    if (!draft?.length) continue
    if (parts.length) parts.push({ type: "text", text: "\n" })
    parts.push(...draft)
  }
  return parts
}
