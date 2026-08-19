import type {
  CommandResult,
  ExecutionEntry,
  ToolDiff,
} from "./execution-view.ts"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>

export type FileTarget = {
  readonly kind: "file"
  readonly path: string
  readonly line?: number
}

export type UrlTarget = {
  readonly kind: "url"
  readonly url: string
}

export type SessionTarget = {
  readonly kind: "session"
  readonly sessionId: string
}

export type ToolTarget = FileTarget | UrlTarget | SessionTarget

export type FileMatch = {
  readonly line?: number
  readonly text?: string
}

export type FileMatchGroup = {
  readonly path: string
  readonly matches: readonly FileMatch[]
}

export type WebLink = {
  readonly title: string
  readonly url: string
}

export type ToolDetail =
  | {
      readonly kind: "file_excerpt"
      readonly path: string
      readonly content: string
      readonly startLine?: number
      readonly truncated: boolean
    }
  | {
      readonly kind: "file_matches"
      readonly groups: readonly FileMatchGroup[]
      readonly truncated: boolean
    }
  | {
      readonly kind: "file_list"
      readonly paths: readonly string[]
      readonly truncated: boolean
    }
  | {
      readonly kind: "diff"
      readonly path?: string
      readonly diff: ToolDiff
    }
  | {
      readonly kind: "command"
      readonly command: string
      readonly result?: CommandResult
      readonly resultText?: string
      readonly errorMessage?: string
    }
  | {
      readonly kind: "links"
      readonly links: readonly WebLink[]
      readonly fallbackText?: string
    }
  | {
      readonly kind: "task"
      readonly text?: string
      readonly sessionId?: string
    }
  | { readonly kind: "text"; readonly text: string }

export type ToolPresentation = {
  readonly verb: string
  readonly activeVerb: string
  readonly subject: string
  readonly subjectTone: "code" | "text"
  readonly meta: readonly string[]
  readonly target?: ToolTarget
  readonly detail?: ToolDetail
}

type ToolAdapter = (entry: ToolEntry) => ToolPresentation

const adapters: Readonly<Record<string, ToolAdapter>> = {
  read_file: presentReadFile,
  grep: presentGrep,
  glob: presentGlob,
  edit_file: (entry) => presentDiff(entry, "Edit", "Editing"),
  write_file: (entry) => presentDiff(entry, "Write", "Writing"),
  run_command: presentRunCommand,
  web_fetch: presentWebFetch,
  web_search: presentWebSearch,
  task: presentTask,
}

export function presentTool(entry: ToolEntry): ToolPresentation {
  return (adapters[entry.name] ?? presentUnknown)(entry)
}

function presentReadFile(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const path = stringOf(output?.path) ?? stringOf(input?.path) ?? entry.summary
  const resultText = entry.resultText
  const isDirectory =
    output?.kind === "directory" || resultText?.startsWith("Listed ") === true
  const range = recordOf(output?.range)
  const offset = numberOf(range?.offset) ?? numberOf(input?.offset)
  const length = numberOf(range?.limit)
  const meta = [
    offset !== undefined && length !== undefined && length > 0
      ? `lines ${offset}–${offset + length - 1}`
      : undefined,
    output?.empty === true ? "empty" : undefined,
    output?.truncated === true ? "partial" : undefined,
  ].filter(isString)
  return {
    verb: isDirectory ? "List" : "Read",
    activeVerb: isDirectory ? "Listing" : "Reading",
    subject: path,
    subjectTone: "code",
    meta,
    target: {
      kind: "file",
      path,
      ...(offset === undefined ? {} : { line: offset }),
    },
    ...(resultText === undefined
      ? {}
      : isDirectory
        ? {
            detail: {
              kind: "file_list" as const,
              paths: directoryPaths(path, resultText),
              truncated: output?.truncated === true,
            },
          }
        : {
            detail: {
              kind: "file_excerpt" as const,
              path,
              content: resultText,
              ...(offset === undefined ? {} : { startLine: offset }),
              truncated: output?.truncated === true,
            },
          }),
  }
}

function presentGrep(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const pattern = stringOf(input?.pattern) ?? "pattern"
  const path = stringOf(input?.path) ?? stringOf(output?.path) ?? "."
  const mode = normalizeGrepMode(
    stringOf(output?.outputMode) ?? stringOf(input?.output_mode),
  )
  const count = numberOf(output?.count)
  const parsed = parseGrepResult(
    entry.resultText,
    mode,
    input?.["-n"] !== false,
    output?.locations,
  )
  const fileCount = parsed.groups.length
  const meta = [
    count === undefined
      ? undefined
      : mode === "content"
        ? `${count} ${count === 1 ? "match" : "matches"}`
        : `${count} ${count === 1 ? "file" : "files"}`,
    mode === "content" && fileCount > 0
      ? `${fileCount} ${fileCount === 1 ? "file" : "files"}`
      : undefined,
    output?.timedOut === true ? "timed out" : undefined,
    output?.truncated === true ? "partial" : undefined,
  ].filter(isString)

  return {
    verb: "Search",
    activeVerb: "Searching",
    subject: `“${truncateLine(pattern, 96)}” in ${path}`,
    subjectTone: "code",
    meta,
    ...grepDetail(entry, parsed, output?.truncated === true),
  }
}

function presentGlob(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const pattern =
    stringOf(input?.pattern) ?? stringOf(output?.pattern) ?? "files"
  const path = stringOf(input?.path) ?? stringOf(output?.path)
  const count = numberOf(output?.count)
  const paths =
    stringArrayOf(output?.paths) ??
    parseListedPaths(entry.resultText, "Glob returned")
  return {
    verb: "Find",
    activeVerb: "Finding",
    subject: `“${truncateLine(pattern, 96)}”${path === undefined || path === "." ? "" : ` in ${path}`}`,
    subjectTone: "code",
    meta: [
      count === undefined
        ? undefined
        : `${count} ${count === 1 ? "file" : "files"}`,
      output?.truncated === true ? "partial" : undefined,
    ].filter(isString),
    ...(entry.resultText === undefined
      ? {}
      : entry.resultError === true || paths.length === 0
        ? { detail: { kind: "text" as const, text: entry.resultText } }
        : {
            detail: {
              kind: "file_list" as const,
              paths,
              truncated: output?.truncated === true,
            },
          }),
  }
}

function presentDiff(
  entry: ToolEntry,
  verb: string,
  activeVerb: string,
): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const path = stringOf(output?.path) ?? stringOf(input?.path) ?? entry.summary
  const counts =
    entry.diff === undefined ? undefined : diffCounts(entry.diff.text)
  const created = output?.created === true
  return {
    verb: created ? "Create" : verb,
    activeVerb: created ? "Creating" : activeVerb,
    subject: path,
    subjectTone: "code",
    meta: [
      counts === undefined ? undefined : `+${counts.added} −${counts.deleted}`,
      entry.diff?.truncated === true ? "partial" : undefined,
    ].filter(isString),
    target: { kind: "file", path },
    ...(entry.diff === undefined
      ? entry.resultText === undefined
        ? {}
        : { detail: { kind: "text" as const, text: entry.resultText } }
      : { detail: { kind: "diff" as const, path, diff: entry.diff } }),
  }
}

function presentRunCommand(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const command = stringOf(input?.command) ?? entry.summary
  const description = stringOf(input?.description)
  const result = entry.commandResult
  return {
    verb: "Run",
    activeVerb: "Running",
    subject: truncateLine(description ?? command, 120),
    subjectTone: description === undefined ? "code" : "text",
    meta: [
      result?.exitCode === null || result?.exitCode === undefined
        ? undefined
        : `exit ${result.exitCode}`,
      result?.timedOut === true ? "timed out" : undefined,
      result?.durationMs === undefined
        ? undefined
        : formatDuration(result.durationMs),
    ].filter(isString),
    detail: {
      kind: "command",
      command,
      ...(result === undefined ? {} : { result }),
      ...(entry.resultText === undefined
        ? {}
        : { resultText: entry.resultText }),
      ...(entry.resultErrorMessage === undefined
        ? {}
        : { errorMessage: entry.resultErrorMessage }),
    },
  }
}

function presentWebFetch(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const url = stringOf(output?.url) ?? stringOf(input?.url) ?? entry.summary
  return {
    verb: "Fetch",
    activeVerb: "Fetching",
    subject: displayUrl(url),
    subjectTone: "code",
    meta: [
      numberOf(output?.status)?.toString(),
      output?.truncated === true ? "partial" : undefined,
    ].filter(isString),
    ...(isHttpUrl(url) ? { target: { kind: "url" as const, url } } : {}),
    ...(entry.resultText === undefined
      ? {}
      : { detail: { kind: "text" as const, text: entry.resultText } }),
  }
}

function presentWebSearch(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const query = stringOf(input?.query) ?? entry.summary
  const links = extractLinks(entry.resultText ?? "")
  return {
    verb: "Search web",
    activeVerb: "Searching web",
    subject: `“${truncateLine(query, 110)}”`,
    subjectTone: "text",
    meta:
      links.length === 0
        ? []
        : [`${links.length} ${links.length === 1 ? "result" : "results"}`],
    ...(entry.resultText === undefined
      ? {}
      : {
          detail: {
            kind: "links" as const,
            links,
            ...(links.length === 0 ? { fallbackText: entry.resultText } : {}),
          },
        }),
  }
}

function presentTask(entry: ToolEntry): ToolPresentation {
  const input = recordOf(entry.input)
  const output = recordOf(entry.output)
  const description = stringOf(input?.description) ?? entry.summary
  const sessionId = stringOf(output?.sessionId)
  const agent = stringOf(output?.agent) ?? stringOf(input?.agent)
  return {
    verb: "Delegate",
    activeVerb: "Delegating",
    subject: `“${truncateLine(description, 110)}”`,
    subjectTone: "text",
    meta: agent === undefined ? [] : [agent],
    ...(sessionId === undefined
      ? {}
      : { target: { kind: "session" as const, sessionId } }),
    detail: {
      kind: "task",
      ...(entry.resultText === undefined ? {} : { text: entry.resultText }),
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  }
}

function presentUnknown(entry: ToolEntry): ToolPresentation {
  return {
    verb: humanize(entry.name),
    activeVerb: `${humanize(entry.name)}…`,
    subject: entry.summary === entry.name ? "" : entry.summary,
    subjectTone: "text",
    meta: [],
    ...(entry.resultText === undefined
      ? {}
      : { detail: { kind: "text" as const, text: entry.resultText } }),
  }
}

function parseGrepResult(
  text: string | undefined,
  mode: string,
  lineNumbers: boolean,
  locations: unknown,
):
  | { readonly kind: "matches"; readonly groups: readonly FileMatchGroup[] }
  | {
      readonly kind: "files"
      readonly paths: readonly string[]
      readonly groups: readonly []
    } {
  const lines = resultLines(text, "Grep returned")
  const structured = searchLocationsOf(locations)
  if (mode !== "content") {
    const paths =
      structured.length > 0
        ? structured.map((location) => location.path)
        : lines.map((line) =>
            mode === "count" ? line.replace(/:\d+$/, "") : line,
          )
    return { kind: "files", paths, groups: [] }
  }
  const parsedLines = lines.flatMap((line) => {
    const parsed = parseGrepContentLine(line, lineNumbers)
    return parsed === undefined ? [] : [parsed]
  })
  const textByLocation = new Map<string, string[]>()
  for (const parsed of parsedLines) {
    const key = grepLocationKey(parsed.path, parsed.line)
    textByLocation.set(key, [...(textByLocation.get(key) ?? []), parsed.text])
  }
  const groups = new Map<string, FileMatch[]>()
  if (structured.length > 0) {
    for (const location of structured) {
      const entries = groups.get(location.path) ?? []
      const candidates = textByLocation.get(
        grepLocationKey(location.path, lineNumbers ? location.line : undefined),
      )
      const text = candidates?.shift()
      entries.push({
        ...(location.line === undefined ? {} : { line: location.line }),
        ...(text === undefined ? {} : { text }),
      })
      groups.set(location.path, entries)
    }
    return {
      kind: "matches",
      groups: [...groups].map(([path, matches]) => ({ path, matches })),
    }
  }
  for (const parsed of parsedLines) {
    const entries = groups.get(parsed.path) ?? []
    entries.push({
      ...(parsed.line === undefined ? {} : { line: parsed.line }),
      text: parsed.text,
    })
    groups.set(parsed.path, entries)
  }
  return {
    kind: "matches",
    groups: [...groups].map(([path, matches]) => ({ path, matches })),
  }
}

function grepDetail(
  entry: ToolEntry,
  parsed: ReturnType<typeof parseGrepResult>,
  truncated: boolean,
): Pick<ToolPresentation, "detail"> | Record<string, never> {
  if (entry.resultText === undefined) return {}
  if (
    entry.resultError === true ||
    (parsed.kind === "matches"
      ? parsed.groups.length === 0
      : parsed.paths.length === 0)
  ) {
    return { detail: { kind: "text", text: entry.resultText } }
  }
  return parsed.kind === "matches"
    ? {
        detail: {
          kind: "file_matches",
          groups: parsed.groups,
          truncated,
        },
      }
    : {
        detail: { kind: "file_list", paths: parsed.paths, truncated },
      }
}

function parseGrepContentLine(
  line: string,
  lineNumbers: boolean,
):
  | { readonly path: string; readonly line?: number; readonly text: string }
  | undefined {
  const match = lineNumbers
    ? /^(.*?):(\d+):(.*)$/u.exec(line)
    : /^(.*?):(.*)$/u.exec(line)
  if (match === null || match[1] === undefined) return undefined
  const lineNumber = lineNumbers ? Number(match[2]) : undefined
  if (lineNumbers && !Number.isFinite(lineNumber)) return undefined
  return {
    path: match[1],
    ...(lineNumber === undefined ? {} : { line: lineNumber }),
    text: (lineNumbers ? match[3] : match[2]) ?? "",
  }
}

function grepLocationKey(path: string, line: number | undefined): string {
  return line === undefined ? path : `${path}:${line}`
}

function normalizeGrepMode(value: string | undefined): string {
  if (value === "count_matches") return "count"
  return value ?? "files_with_matches"
}

function searchLocationsOf(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const location = recordOf(item)
    const path = stringOf(location?.path)
    const line = numberOf(location?.line)
    return path === undefined
      ? []
      : [{ path, ...(line === undefined ? {} : { line }) }]
  })
}

function directoryPaths(directory: string, text: string): string[] {
  return parseListedPaths(text, "Listed").map((name) =>
    directory === "." ? name : `${directory.replace(/\/$/, "")}/${name}`,
  )
}

function parseListedPaths(text: string | undefined, prefix: string): string[] {
  return resultLines(text, prefix)
}

function resultLines(text: string | undefined, prefix: string): string[] {
  if (text === undefined) return []
  return text
    .split("\n")
    .filter((line, index) => index > 0 || !line.startsWith(prefix))
    .filter(
      (line) =>
        line !== "" &&
        line !== "No files found." &&
        line !== "No matches found." &&
        !line.startsWith("("),
    )
}

function extractLinks(text: string): WebLink[] {
  const links: WebLink[] = []
  const seen = new Set<string>()
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/https?:\/\/[^\s)>\]}]+/gu)) {
      const url = match[0].replace(/[.,;:]$/, "")
      if (seen.has(url)) continue
      seen.add(url)
      const before = line.slice(0, match.index).replace(/^\s*\d+[.)]\s*/, "")
      const title = before.replace(/[\s—–:-]+$/, "").trim()
      links.push({ title: title === "" ? displayUrl(url) : title, url })
    }
  }
  return links
}

function diffCounts(text: string): {
  readonly added: number
  readonly deleted: number
} {
  let added = 0
  let deleted = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added += 1
    if (line.startsWith("-")) deleted += 1
  }
  return { added, deleted }
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return value
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function humanize(value: string): string {
  const words = value.replaceAll("_", " ")
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length <= max
    ? singleLine
    : `${singleLine.slice(0, max - 1)}…`
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function stringArrayOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
