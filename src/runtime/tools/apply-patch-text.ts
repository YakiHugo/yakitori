import { normalizeUnicodePunctuation } from "./text-file-format.ts"

export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`

type PatchChunk = Readonly<{
  context?: string
  lines: readonly string[]
  endOfFile: boolean
}>

export type PatchAction =
  | Readonly<{ kind: "add"; path: string; content: string }>
  | Readonly<{ kind: "delete"; path: string }>
  | Readonly<{
      kind: "update"
      path: string
      movePath?: string
      chunks: readonly PatchChunk[]
    }>

export class PatchInputError extends Error {}

export function parsePatch(patch: string): readonly PatchAction[] {
  const normalized = patch.replace(/\r\n|\r/gu, "\n").trim()
  const lines = normalized.split("\n")
  if (
    /^(?:apply_patch\s+)?<<-?\s*(?:EOF|'EOF'|"EOF")$/u.test(lines[0] ?? "") &&
    lines.at(-1)?.trim() === "EOF"
  ) {
    lines.shift()
    lines.pop()
  }
  if (lines.shift()?.trim() !== "*** Begin Patch") {
    throw new PatchInputError("apply_patch must start with *** Begin Patch.")
  }
  if (lines.pop()?.trim() !== "*** End Patch") {
    throw new PatchInputError("apply_patch must end with *** End Patch.")
  }
  const actions: PatchAction[] = []
  for (let index = 0; index < lines.length; ) {
    const header = lines[index]?.trim()
    if (header?.startsWith("*** Add File: ")) {
      const path = patchPath(header.slice("*** Add File: ".length))
      index += 1
      const content: string[] = []
      while (index < lines.length && !isHunkHeader(lines[index])) {
        const line = lines[index]
        if (line?.startsWith("+") !== true) {
          throw new PatchInputError(
            `Add File lines must start with + (${path}).`,
          )
        }
        content.push(line.slice(1))
        index += 1
      }
      if (content.length === 0) {
        throw new PatchInputError(
          `Add File requires at least one + line (${path}).`,
        )
      }
      actions.push({ kind: "add", path, content: `${content.join("\n")}\n` })
      continue
    }
    if (header?.startsWith("*** Delete File: ")) {
      actions.push({
        kind: "delete",
        path: patchPath(header.slice("*** Delete File: ".length)),
      })
      index += 1
      continue
    }
    if (header?.startsWith("*** Update File: ")) {
      const path = patchPath(header.slice("*** Update File: ".length))
      index += 1
      let movePath: string | undefined
      const possibleMove = lines[index]?.trim()
      if (possibleMove?.startsWith("*** Move to: ")) {
        movePath = patchPath(possibleMove.slice("*** Move to: ".length))
        index += 1
      }
      const chunks: PatchChunk[] = []
      let context: string | undefined
      let changeLines: string[] = []
      let endOfFile = false
      const pushChunk = () => {
        if (changeLines.length === 0 && context === undefined) return
        chunks.push({
          ...(context === undefined ? {} : { context }),
          lines: changeLines,
          endOfFile,
        })
        context = undefined
        changeLines = []
        endOfFile = false
      }
      while (index < lines.length && !isHunkHeader(lines[index])) {
        const line = lines[index] as string
        const marker = line.trim()
        if (marker === "@@" || marker.startsWith("@@ ")) {
          pushChunk()
          context = marker === "@@" ? undefined : marker.slice(3)
        } else if (marker === "*** End of File") {
          endOfFile = true
        } else if (line.length === 0) {
          changeLines.push(" ")
        } else if (/^[ +-]/u.test(line)) {
          changeLines.push(line)
        } else {
          throw new PatchInputError(
            `Invalid Update File line (${path}): ${line}`,
          )
        }
        index += 1
      }
      pushChunk()
      if (movePath === undefined && chunks.length === 0) {
        throw new PatchInputError(`Update File has no changes (${path}).`)
      }
      actions.push({
        kind: "update",
        path,
        chunks,
        ...(movePath === undefined ? {} : { movePath }),
      })
      continue
    }
    throw new PatchInputError(
      `Unknown apply_patch hunk: ${header ?? "<missing>"}`,
    )
  }
  if (actions.length === 0)
    throw new PatchInputError("apply_patch has no hunks.")
  return actions
}

function patchPath(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new PatchInputError(
      "Patch paths must be non-empty and contain no NUL bytes.",
    )
  }
  return value
}

function isHunkHeader(line: string | undefined): boolean {
  const marker = line?.trim()
  return (
    marker?.startsWith("*** Add File: ") === true ||
    marker?.startsWith("*** Delete File: ") === true ||
    marker?.startsWith("*** Update File: ") === true
  )
}

export class PatchContextError extends Error {}

type SourceLine = { text: string; ending: "\r\n" | "\n" | "\r" | "" }

export function applyChunks(
  content: string,
  chunks: readonly PatchChunk[],
): string {
  const lines = parseSourceLines(content)
  const parts: SourceLine[][] = []
  const preferredEnding =
    lines.find((line) => line.ending !== "")?.ending ?? "\n"
  let cursor = 0
  let writtenThrough = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = findSequence(lines, [chunk.context], cursor, false)
      if (contextIndex < 0) {
        throw new PatchContextError(
          `Could not find @@ context: ${chunk.context}`,
        )
      }
      cursor = contextIndex + 1
    }
    let patchLines = chunk.lines
    let oldLines = patchLines
      .filter((line) => line[0] !== "+")
      .map((line) => line.slice(1))
    let index =
      oldLines.length === 0
        ? lines.length
        : findSequence(lines, oldLines, cursor, chunk.endOfFile)
    if (
      index < 0 &&
      oldLines.length > 1 &&
      oldLines.at(-1) === "" &&
      patchLines.at(-1) === " "
    ) {
      // A trailing blank context line can represent the final newline, which
      // is stored on the previous line instead of as a separate source line.
      oldLines = oldLines.slice(0, -1)
      patchLines = patchLines.slice(0, -1)
      index = findSequence(lines, oldLines, cursor, true)
    }
    if (index < 0) {
      throw new PatchContextError(
        `Could not find patch context: ${oldLines.slice(0, 3).join(" | ")}`,
      )
    }
    const replaced = lines.slice(index, index + oldLines.length)
    let oldOffset = 0
    const replacement: SourceLine[] = []
    for (const patchLine of patchLines) {
      const marker = patchLine[0]
      const text = patchLine.slice(1)
      if (marker === "-") {
        oldOffset += 1
        continue
      }
      if (marker === " ") {
        replacement.push(
          replaced[oldOffset] ?? { text, ending: preferredEnding },
        )
        oldOffset += 1
        continue
      }
      replacement.push({ text, ending: preferredEnding })
    }
    if (oldLines.length === 0) {
      const previous =
        index > writtenThrough ? lines.at(-1) : parts.at(-1)?.at(-1)
      if (previous !== undefined && previous.ending === "") {
        previous.ending = preferredEnding
      }
    } else if (
      index + oldLines.length === lines.length &&
      replacement.length > 0 &&
      patchLines.at(-1)?.startsWith("+") === true
    ) {
      const lastReplacement = replacement.at(-1)
      if (lastReplacement !== undefined) {
        lastReplacement.ending = replaced.at(-1)?.ending ?? preferredEnding
      }
    }
    parts.push(lines.slice(writtenThrough, index), replacement)
    cursor = index + oldLines.length
    writtenThrough = cursor
  }
  parts.push(lines.slice(writtenThrough))
  return parts
    .map((part) => part.map((line) => `${line.text}${line.ending}`).join(""))
    .join("")
}

function findSequence(
  lines: readonly SourceLine[],
  expected: readonly string[],
  from: number,
  endOfFile: boolean,
): number {
  const last = lines.length - expected.length
  const first = endOfFile ? Math.max(from, last) : from
  if (first > last) return -1
  for (const normalize of [
    identity,
    trimEnd,
    trim,
    normalizePatchPunctuation,
  ]) {
    const pattern = expected.map(normalize)
    for (let index = first; index <= last; index += 1) {
      if (
        pattern.every(
          (line, offset) =>
            normalize(lines[index + offset]?.text ?? "") === line,
        )
      ) {
        return index
      }
    }
  }
  return -1
}

function parseSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character !== "\r" && character !== "\n") continue
    const ending: SourceLine["ending"] =
      character === "\r" && content[index + 1] === "\n" ? "\r\n" : character
    lines.push({ text: content.slice(start, index), ending })
    if (ending === "\r\n") index += 1
    start = index + 1
  }
  if (start < content.length) {
    lines.push({ text: content.slice(start), ending: "" })
  }
  return lines
}

export function patchPaths(actions: readonly PatchAction[]): string[] {
  return actions.flatMap((action) => [
    action.path,
    ...(action.kind === "update" && action.movePath !== undefined
      ? [action.movePath]
      : []),
  ])
}

function normalizePatchPunctuation(value: string): string {
  return normalizeUnicodePunctuation(value.trim())
}

function identity(value: string): string {
  return value
}

function trimEnd(value: string): string {
  return value.trimEnd()
}

function trim(value: string): string {
  return value.trim()
}
