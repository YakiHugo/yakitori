import { stat } from "node:fs/promises"
import {
  isSensitiveWorkspacePath,
  resolveSearchPath,
  SensitivePathGlobs,
} from "./path-policy.ts"
import { runRipgrepRecords, type RipgrepRecordStopReason } from "./ripgrep.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const DEFAULT_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RAW_BYTES = 5 * 1024 * 1024
const MAX_RECORD_BYTES = 256 * 1024
const VCS_DIRECTORIES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]

type GlobRunner = typeof runRipgrepRecords
type GlobTruncationReason = "result_limit" | "timeout" | "output_byte_limit"

export type GlobToolOptions = {
  // TODO(glob-limit): Consider a model-requested max_results bounded by the
  // Runtime hard cap if usage shows repeated broad searches followed by manual
  // narrowing or substantial unused result output.
  readonly limit?: number
  // Deliberately construction-time state. A later startup setting may enable
  // ignored-file discovery without exposing the switch to the model.
  readonly includeIgnored?: boolean
  readonly timeoutMs?: number
  readonly maxRawBytes?: number
}

export function createGlobTool(
  options: GlobToolOptions = {},
  runRecords: GlobRunner = runRipgrepRecords,
): RuntimeTool {
  const limit = options.limit ?? DEFAULT_LIMIT
  const includeIgnored = options.includeIgnored ?? false
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRawBytes = options.maxRawBytes ?? DEFAULT_RAW_BYTES
  return {
    name: "glob",
    description:
      "Fast file pattern matching that works with any codebase size. Supports patterns such as **/*.js and src/**/*.ts, returns workspace-relative file paths sorted lexicographically, and caps results at 100 files. Use glob to find files by name pattern or wildcard.",
    autoAllow: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against.",
        },
        path: {
          type: "string",
          description:
            'The workspace-relative directory to search in. If not specified, the current working directory is used. Omit this field for the default; do not pass "undefined" or null. Must be a valid directory if provided.',
        },
      },
      required: ["pattern"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseGlobInput(input)
      if (!parsed.ok) return parsed.result

      // TODO(external-roots): Allow absolute paths under user-authorized
      // additional roots, following Claude Code's add-dir model. Keep arbitrary
      // external paths denied until Runtime permission decisions can authorize
      // and record them.
      const resolved = await resolveSearchPath(
        context.workspaceRoot,
        parsed.path ?? ".",
      )
      if (!resolved.ok) {
        return failure(resolved.error.code, resolved.error.message)
      }
      let searchRoot: Awaited<ReturnType<typeof stat>>
      try {
        searchRoot = await stat(resolved.absolutePath)
      } catch {
        return failure(
          "path_not_found",
          `Glob path does not exist: ${resolved.relativePath}`,
        )
      }
      if (!searchRoot.isDirectory()) {
        return failure(
          "path_not_directory",
          `Glob path is not a directory: ${resolved.relativePath}`,
        )
      }

      const paths: string[] = []
      const result = await runRecords(
        buildRipgrepArguments(parsed.pattern, includeIgnored),
        {
          cwd: resolved.absolutePath,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          timeoutMs,
          maxBytes: maxRawBytes,
          maxRecordBytes: MAX_RECORD_BYTES,
          delimiter: "null",
          onRecord(record) {
            const path = workspaceRelativePath(
              resolved.relativePath,
              normalizePath(record),
            )
            if (isVcsWorkspacePath(path) || isSensitiveWorkspacePath(path)) {
              return true
            }
            if (paths.length >= limit) {
              return false
            }
            paths.push(path)
            return true
          },
        },
      )
      if (!result.ok) return failure("search_failed", result.message)
      if (result.stopReason === "aborted") {
        return failure("search_aborted", "Glob search was aborted.")
      }
      if (result.stopReason === "timeout" && paths.length === 0) {
        return failure(
          "search_timeout",
          "Glob search timed out after returning 0 files.",
        )
      }

      paths.sort()
      const truncationReason = publicTruncationReason(result.stopReason)
      const content = renderGlobContent(paths, truncationReason)
      const output = {
        pattern: parsed.pattern,
        path: resolved.relativePath,
        count: paths.length,
        truncated: truncationReason !== undefined,
        ...(truncationReason === undefined ? {} : { truncationReason }),
        content,
      }
      return { ok: true, output, content }
    },
  }
}

function buildRipgrepArguments(
  pattern: string,
  includeIgnored: boolean,
): readonly string[] {
  return [
    "--files",
    "--null",
    "--hidden",
    "--no-require-git",
    ...VCS_DIRECTORIES.flatMap((directory) => ["--glob", `!${directory}`]),
    "--glob",
    pattern,
    ...SensitivePathGlobs.flatMap((glob) => ["--glob", glob]),
    ...(includeIgnored ? ["--no-ignore"] : []),
    "--",
    ".",
  ]
}

// TODO(search-truncation): Align grep with glob's public
// truncated/truncationReason protocol after the glob behavior is validated.
function publicTruncationReason(
  stopReason: RipgrepRecordStopReason | undefined,
): GlobTruncationReason | undefined {
  if (stopReason === "consumer_limit") return "result_limit"
  if (stopReason === "timeout") return "timeout"
  if (stopReason === "raw_byte_limit" || stopReason === "record_byte_limit") {
    return "output_byte_limit"
  }
  return undefined
}

function renderGlobContent(
  paths: readonly string[],
  truncationReason: GlobTruncationReason | undefined,
): string {
  if (paths.length === 0 && truncationReason === undefined) {
    return "No files found."
  }
  const noun = paths.length === 1 ? "file" : "files"
  const summary =
    truncationReason === "timeout"
      ? `Glob returned ${paths.length} ${noun} before timing out.`
      : `Glob returned ${paths.length} ${noun}.`
  const footer =
    truncationReason === "result_limit"
      ? "(Results truncated at the result limit.)"
      : truncationReason === "timeout"
        ? "(Search timed out; partial results shown.)"
        : truncationReason === "output_byte_limit"
          ? paths.length === 0
            ? "(Search output exceeded the byte limit before a complete file path was returned.)"
            : "(Search output exceeded the byte limit; partial results shown.)"
          : undefined
  return [summary, ...paths, ...(footer === undefined ? [] : [footer])].join(
    "\n",
  )
}

function parseGlobInput(input: unknown):
  | {
      readonly ok: true
      readonly pattern: string
      readonly path?: string
    }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  if (!isRecord(input) || typeof input.pattern !== "string") {
    return {
      ok: false,
      result: failure("invalid_tool_input", "glob pattern must be a string."),
    }
  }
  const unsupported = Object.keys(input).find(
    (key) => key !== "pattern" && key !== "path",
  )
  if (unsupported !== undefined) {
    return {
      ok: false,
      result: failure(
        "invalid_tool_input",
        `glob does not accept the ${unsupported} argument.`,
      ),
    }
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return {
      ok: false,
      result: failure("invalid_tool_input", "glob path must be a string."),
    }
  }
  return {
    ok: true,
    pattern: input.pattern,
    ...(typeof input.path === "string" ? { path: input.path } : {}),
  }
}

function workspaceRelativePath(searchPath: string, listedPath: string): string {
  return searchPath === "." ? listedPath : `${searchPath}/${listedPath}`
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "")
}

function isVcsWorkspacePath(path: string): boolean {
  return path.split("/").some((part) => VCS_DIRECTORIES.includes(part))
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: `${code}: ${message}`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
