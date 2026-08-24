import type {
  CommandResult,
  ExecutionEntry,
  ToolDiff,
} from "./execution-view.ts"
import type { ToolExecutionItem } from "../kernel/events.ts"
import type { FileChange } from "../kernel/events.ts"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>
type ExecutionOf<Type extends ToolExecutionItem["type"]> = Extract<
  ToolExecutionItem,
  { readonly type: Type }
>

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
      readonly kind: "file_changes"
      readonly changes: readonly FileChange[]
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
      readonly kind: "collaboration"
      readonly text?: string
      readonly receivers: readonly {
        readonly sessionId: string
        readonly path: string
      }[]
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

export function presentTool(
  entry: ToolEntry,
  workspaceRoot?: string,
): ToolPresentation {
  switch (entry.execution.type) {
    case "command_execution":
      return presentRunCommand(entry, entry.execution, workspaceRoot)
    case "file_change":
      return presentDiff(entry, entry.execution)
    case "file_read":
      return presentReadFile(entry, entry.execution)
    case "file_search":
      return entry.execution.operation === "glob"
        ? presentGlob(entry, entry.execution)
        : presentGrep(entry, entry.execution)
    case "web_fetch":
      return presentWebFetch(entry, entry.execution)
    case "web_search":
      return presentWebSearch(entry, entry.execution)
    case "collaboration_tool_call":
      return presentCollaboration(entry, entry.execution)
    case "mcp_tool_call":
      return presentMcpToolCall(entry, entry.execution)
    case "dynamic_tool_call":
      return presentUnknown(entry, entry.execution)
  }
}

function presentReadFile(
  entry: ToolEntry,
  execution: ExecutionOf<"file_read">,
): ToolPresentation {
  const result = execution.result
  const path = result?.path ?? execution.path
  const resultText = entry.resultText
  const isDirectory = result?.kind === "directory"
  const offset = result?.range?.offset ?? execution.offset
  const length = result?.range?.limit ?? execution.limit
  const meta = [
    offset !== undefined && length !== undefined && length > 0
      ? `lines ${offset}–${offset + length - 1}`
      : undefined,
    result?.empty === true ? "empty" : undefined,
    result?.truncated === true ? "partial" : undefined,
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
              paths: directoryPaths(path, result?.entries ?? []),
              truncated: result?.truncated === true,
            },
          }
        : {
            detail: {
              kind: "file_excerpt" as const,
              path,
              content: resultText,
              ...(offset === undefined ? {} : { startLine: offset }),
              truncated: result?.truncated === true,
            },
          }),
  }
}

function presentGrep(
  entry: ToolEntry,
  execution: ExecutionOf<"file_search">,
): ToolPresentation {
  const result = execution.result
  const pattern = execution.pattern || "pattern"
  const path = result?.path ?? execution.path ?? "."
  const mode =
    result?.outputMode ?? execution.outputMode ?? "files_with_matches"
  const count = result?.count
  const parsed = fileSearchPresentation(result, mode)
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
    result?.timedOut === true ? "timed out" : undefined,
    result?.truncated === true ? "partial" : undefined,
  ].filter(isString)

  return {
    verb: "Search",
    activeVerb: "Searching",
    subject: `“${truncateLine(pattern, 96)}” in ${path}`,
    subjectTone: "code",
    meta,
    ...grepDetail(entry, parsed, result?.truncated === true),
  }
}

function presentGlob(
  entry: ToolEntry,
  execution: ExecutionOf<"file_search">,
): ToolPresentation {
  const result = execution.result
  const pattern = execution.pattern || "files"
  const path = result?.path ?? execution.path
  const count = result?.count
  const paths = result?.paths ?? []
  return {
    verb: "Find",
    activeVerb: "Finding",
    subject: `“${truncateLine(pattern, 96)}”${path === undefined || path === "." ? "" : ` in ${path}`}`,
    subjectTone: "code",
    meta: [
      count === undefined
        ? undefined
        : `${count} ${count === 1 ? "file" : "files"}`,
      result?.truncated === true ? "partial" : undefined,
    ].filter(isString),
    ...(entry.resultText === undefined
      ? {}
      : entry.resultError === true || paths.length === 0
        ? { detail: { kind: "text" as const, text: entry.resultText } }
        : {
            detail: {
              kind: "file_list" as const,
              paths,
              truncated: result?.truncated === true,
            },
          }),
  }
}

function presentDiff(
  entry: ToolEntry,
  execution: ExecutionOf<"file_change">,
): ToolPresentation {
  const change = execution.changes[0]
  const sourcePath = change?.path ?? execution.request.paths[0] ?? "file"
  const movePath = change?.kind === "update" ? change.movePath : undefined
  const targetPath = movePath ?? sourcePath
  const operation = execution.request.operation
  const verb = operation === "write" ? "Write" : "Edit"
  const activeVerb = operation === "write" ? "Writing" : "Editing"
  const diff = change?.diff
  const counts = execution.changes.reduce(
    (total, current) => {
      const next =
        current.diff === undefined ? undefined : diffCounts(current.diff.text)
      return next === undefined
        ? total
        : {
            added: total.added + next.added,
            deleted: total.deleted + next.deleted,
          }
    },
    { added: 0, deleted: 0 },
  )
  const hasDiff = execution.changes.some(
    (current) => current.diff !== undefined,
  )
  const created = change?.kind === "add"
  const multiple = execution.changes.length > 1
  return {
    verb: multiple ? "Change" : created ? "Create" : verb,
    activeVerb: multiple ? "Changing" : created ? "Creating" : activeVerb,
    subject: multiple
      ? `${execution.changes.length} files`
      : movePath === undefined
        ? sourcePath
        : `${sourcePath} → ${movePath}`,
    subjectTone: "code",
    meta: [
      hasDiff ? `+${counts.added} −${counts.deleted}` : undefined,
      execution.changes.some((current) => current.diff?.truncated === true)
        ? "partial"
        : undefined,
    ].filter(isString),
    ...(multiple
      ? {}
      : { target: { kind: "file" as const, path: targetPath } }),
    ...(multiple
      ? {
          detail: {
            kind: "file_changes" as const,
            changes: execution.changes,
          },
        }
      : diff === undefined
        ? entry.resultText === undefined
          ? {}
          : { detail: { kind: "text" as const, text: entry.resultText } }
        : { detail: { kind: "diff" as const, path: targetPath, diff } }),
  }
}

function presentRunCommand(
  entry: ToolEntry,
  execution: ExecutionOf<"command_execution">,
  workspaceRoot?: string,
): ToolPresentation {
  const command = execution.command
  const description = execution.description
  const result = displayCommandResult(execution.result, workspaceRoot)
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

function presentWebFetch(
  entry: ToolEntry,
  execution: ExecutionOf<"web_fetch">,
): ToolPresentation {
  const result = execution.result
  const url = result?.url ?? execution.url
  return {
    verb: "Fetch",
    activeVerb: "Fetching",
    subject: displayUrl(url),
    subjectTone: "code",
    meta: [
      result?.status.toString(),
      result?.truncated === true ? "partial" : undefined,
    ].filter(isString),
    ...(isHttpUrl(url) ? { target: { kind: "url" as const, url } } : {}),
    ...(entry.resultText === undefined
      ? {}
      : { detail: { kind: "text" as const, text: entry.resultText } }),
  }
}

function presentWebSearch(
  entry: ToolEntry,
  execution: ExecutionOf<"web_search">,
): ToolPresentation {
  const query = execution.query
  const links = execution.result?.links ?? []
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

function presentCollaboration(
  entry: ToolEntry,
  execution: ExecutionOf<"collaboration_tool_call">,
): ToolPresentation {
  const description = execution.description
  const receiver =
    execution.receivers.length === 1 ? execution.receivers[0] : undefined
  return {
    verb: "Collaborate",
    activeVerb: "Collaborating",
    subject: `“${truncateLine(description, 110)}”`,
    subjectTone: "text",
    meta:
      execution.receivers.length === 0
        ? []
        : execution.receivers.length === 1
          ? [execution.receivers[0]?.path ?? ""]
          : [`${execution.receivers.length} agents`],
    ...(receiver === undefined
      ? {}
      : {
          target: {
            kind: "session" as const,
            sessionId: receiver.sessionId,
          },
        }),
    detail: {
      kind: "collaboration",
      ...(entry.resultText === undefined ? {} : { text: entry.resultText }),
      receivers: execution.receivers,
    },
  }
}

function presentMcpToolCall(
  entry: ToolEntry,
  execution: ExecutionOf<"mcp_tool_call">,
): ToolPresentation {
  return {
    verb: humanize(execution.tool),
    activeVerb: `${humanize(execution.tool)}…`,
    subject: execution.server,
    subjectTone: "code",
    meta: ["MCP"],
    ...(entry.resultText === undefined
      ? {}
      : { detail: { kind: "text" as const, text: entry.resultText } }),
  }
}

function presentUnknown(
  entry: ToolEntry,
  execution: ExecutionOf<"dynamic_tool_call">,
): ToolPresentation {
  const subject = summarizeDynamicInput(execution.input)
  return {
    verb: humanize(execution.name),
    activeVerb: `${humanize(execution.name)}…`,
    subject,
    subjectTone: "text",
    meta: [],
    ...(entry.resultText === undefined
      ? {}
      : { detail: { kind: "text" as const, text: entry.resultText } }),
  }
}

function summarizeDynamicInput(input: unknown): string {
  const value = recordOf(input)
  const subject =
    stringOf(value?.description) ??
    stringOf(value?.path) ??
    stringOf(value?.query) ??
    stringOf(value?.message)
  return subject === undefined ? "" : truncateLine(subject, 120)
}

function fileSearchPresentation(
  result: ExecutionOf<"file_search">["result"],
  mode: string,
):
  | { readonly kind: "matches"; readonly groups: readonly FileMatchGroup[] }
  | {
      readonly kind: "files"
      readonly paths: readonly string[]
      readonly groups: readonly []
    } {
  if (mode !== "content") {
    const paths =
      result?.paths ?? result?.matches?.map((match) => match.path) ?? []
    return { kind: "files", paths, groups: [] }
  }
  const groups = new Map<string, FileMatch[]>()
  for (const match of result?.matches ?? []) {
    const entries = groups.get(match.path) ?? []
    entries.push({
      ...(match.line === undefined ? {} : { line: match.line }),
      ...(match.text === undefined ? {} : { text: match.text }),
    })
    groups.set(match.path, entries)
  }
  return {
    kind: "matches",
    groups: [...groups].map(([path, matches]) => ({ path, matches })),
  }
}

function grepDetail(
  entry: ToolEntry,
  parsed: ReturnType<typeof fileSearchPresentation>,
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

function directoryPaths(
  directory: string,
  entries: readonly string[],
): string[] {
  return entries.map((name) =>
    directory === "." ? name : `${directory.replace(/\/$/, "")}/${name}`,
  )
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

function displayCommandResult(
  result: ExecutionOf<"command_execution">["result"],
  workspaceRoot?: string,
): CommandResult | undefined {
  if (result === undefined) return undefined
  return {
    ...result,
    ...(result.cwd === undefined
      ? {}
      : { cwd: workspaceRelativePath(workspaceRoot, result.cwd) }),
  }
}

function workspaceRelativePath(
  workspaceRoot: string | undefined,
  cwd: string,
): string {
  if (workspaceRoot === undefined) return cwd
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "")
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/$/, "")
  if (normalizedCwd === normalizedRoot) return "."
  return normalizedCwd.startsWith(`${normalizedRoot}/`)
    ? normalizedCwd.slice(normalizedRoot.length + 1)
    : cwd
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

function isString(value: string | undefined): value is string {
  return value !== undefined
}
