export type BoundedUnifiedDiff = {
  readonly format: "unified"
  readonly text: string
  readonly truncated: boolean
}

export function createBoundedUnifiedDiff(input: {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
  readonly maxBytes: number
}): BoundedUnifiedDiff {
  const before = splitLines(input.before ?? "")
  const after = splitLines(input.after ?? "")
  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before, after, prefix)
  const oldChangeEnd = before.length - suffix
  const newChangeEnd = after.length - suffix
  const oldStart = Math.max(0, prefix - 3)
  const newStart = oldStart
  const oldEnd = Math.min(before.length, oldChangeEnd + 3)
  const newEnd = Math.min(after.length, newChangeEnd + 3)
  const oldLabel = input.before === null ? "/dev/null" : `a/${input.path}`
  const lines = [
    `--- ${oldLabel}`,
    `+++ ${input.after === null ? "/dev/null" : `b/${input.path}`}`,
    `@@ -${rangeStart(oldStart, oldEnd)},${oldEnd - oldStart} +${rangeStart(newStart, newEnd)},${newEnd - newStart} @@`,
    ...before.slice(oldStart, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
    ...after.slice(prefix, newChangeEnd).map((line) => `+${line}`),
    ...after.slice(newChangeEnd, newEnd).map((line) => ` ${line}`),
  ]
  const text = lines.join("\n")
  const bounded = truncateUtf8(text, input.maxBytes)
  return {
    format: "unified",
    text: bounded.text,
    truncated: bounded.truncated,
  }
}

function splitLines(value: string): readonly string[] {
  if (value.length === 0) return []
  const lines = value.replace(/\r\n|\r/gu, "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function commonPrefix(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index += 1
  return index
}

function commonSuffix(
  left: readonly string[],
  right: readonly string[],
  prefix: number,
): number {
  const length = Math.min(left.length, right.length) - prefix
  let offset = 0
  while (
    offset < length &&
    left[left.length - offset - 1] === right[right.length - offset - 1]
  ) {
    offset += 1
  }
  return offset
}

function rangeStart(start: number, end: number): number {
  return start === end ? start : start + 1
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false }
  }
  const marker = "\n...[diff truncated]"
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"))
  let text = ""
  let bytes = 0
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8")
    if (bytes + width > budget) break
    text += character
    bytes += width
  }
  return { text: `${text}${marker}`, truncated: true }
}
