export type DiffRow = Readonly<{
  index: number
  kind: "hunk" | "context" | "addition" | "deletion" | "note"
  text: string
  oldLine?: number
  newLine?: number
}>

export type DiffFile = Readonly<{
  index: number
  oldPath: string
  newPath: string
  additions: number
  deletions: number
  rows: readonly DiffRow[]
}>

export type DiffModel =
  | Readonly<{ kind: "unified"; files: readonly DiffFile[] }>
  | Readonly<{ kind: "raw"; reason: "unsupported" | "incomplete" }>

// Only assign line numbers when every hunk matches its declared ranges.
// Unknown patch formats and cut-off results retain their original text instead.
export function parseDiff(text: string): DiffModel {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const files: DiffFile[] = []
  let pendingGitFile = false
  let file:
    | {
        index: number
        oldPath: string
        newPath: string
        additions: number
        deletions: number
        rows: DiffRow[]
      }
    | undefined
  let hunk:
    | {
        oldLine: number
        newLine: number
        oldRemaining: number
        newRemaining: number
      }
    | undefined
  const incomplete = { kind: "raw", reason: "incomplete" } as const
  const unsupported = { kind: "raw", reason: "unsupported" } as const
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (hunk && (hunk.oldRemaining > 0 || hunk.newRemaining > 0)) {
      if (!file) return unsupported
      if (line === "\\ No newline at end of file") {
        file.rows.push({ index, kind: "note", text: line })
        continue
      }
      const sign = line[0]
      if (sign !== " " && sign !== "+" && sign !== "-") return incomplete
      const oldLine = sign === "+" ? undefined : hunk.oldLine++
      const newLine = sign === "-" ? undefined : hunk.newLine++
      if (oldLine !== undefined) hunk.oldRemaining -= 1
      if (newLine !== undefined) hunk.newRemaining -= 1
      if (hunk.oldRemaining < 0 || hunk.newRemaining < 0) return incomplete
      if (sign === "+") file.additions += 1
      if (sign === "-") file.deletions += 1
      file.rows.push({
        index,
        kind: sign === "+" ? "addition" : sign === "-" ? "deletion" : "context",
        text: line,
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
      })
      continue
    }
    if (line === "\\ No newline at end of file" && file && hunk) {
      file.rows.push({ index, kind: "note", text: line })
      continue
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const oldPath = patchPath(line.slice(4))
      const newPath = patchPath(lines[index + 1]?.slice(4) ?? "")
      if (oldPath === undefined || newPath === undefined) return unsupported
      if (file) {
        if (file.rows.length === 0) return incomplete
        files.push(file)
      }
      file = {
        index,
        oldPath,
        newPath,
        additions: 0,
        deletions: 0,
        rows: [],
      }
      hunk = undefined
      pendingGitFile = false
      index += 1
      continue
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(
      line,
    )
    if (header) {
      if (!file) {
        file = {
          index,
          oldPath: "",
          newPath: "",
          additions: 0,
          deletions: 0,
          rows: [],
        }
      }
      hunk = {
        oldLine: Number(header[1]),
        newLine: Number(header[3]),
        oldRemaining: Number(header[2] ?? 1),
        newRemaining: Number(header[4] ?? 1),
      }
      if (
        !Object.values(hunk).every(Number.isSafeInteger) ||
        (hunk.oldLine === 0 && hunk.oldRemaining > 0) ||
        (hunk.newLine === 0 && hunk.newRemaining > 0)
      )
        return unsupported
      file.rows.push({ index, kind: "hunk", text: line })
      continue
    }
    if (line.startsWith("diff --git ")) {
      if (pendingGitFile) return unsupported
      pendingGitFile = true
      continue
    }
    if (
      line === "" ||
      /^(index |(?:new|deleted) file mode |(?:old|new) mode |(?:dis)?similarity index |rename (?:from|to) |copy (?:from|to) )/.test(
        line,
      )
    )
      continue
    return line.startsWith("@@") ||
      line.startsWith("--- ") ||
      /^[ +-]/.test(line)
      ? incomplete
      : unsupported
  }
  if (hunk && (hunk.oldRemaining > 0 || hunk.newRemaining > 0))
    return incomplete
  if (pendingGitFile) return unsupported
  if (file) {
    if (file.rows.length === 0) return incomplete
    files.push(file)
  }
  return files.length > 0 ? { kind: "unified", files } : unsupported
}

function patchPath(value: string): string | undefined {
  let path = value.split("\t")[0] ?? value
  if (path.startsWith('"')) {
    if (!path.endsWith('"')) return undefined
    const source = path.slice(1, -1)
    const escapes: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
    }
    path = ""
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index]
      if (character === '"') return undefined
      if (character !== "\\") {
        path += character
        continue
      }
      // Git emits non-ASCII filename bytes as consecutive three-digit octals.
      const octals = /^(?:\\[0-7]{3})+/.exec(source.slice(index))?.[0]
      if (octals) {
        const bytes = octals
          .split("\\")
          .slice(1)
          .map((byte) => Number.parseInt(byte, 8))
        if (bytes.some((byte) => byte > 255)) return undefined
        try {
          path += new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(bytes),
          )
        } catch (error) {
          if (error instanceof TypeError) return undefined
          throw error
        }
        index += octals.length - 1
        continue
      }
      const escaped = escapes[source[++index] ?? ""]
      if (escaped === undefined) return undefined
      path += escaped
    }
  }
  return path.replace(/^[ab]\//, "")
}
