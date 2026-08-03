import { createHash } from "node:crypto"
import type { JsonObject } from "../../kernel/index.ts"
import { SensitivePathGlobs } from "./path-policy.ts"

export type GrepOutputMode = "content" | "count" | "files_with_matches"

export type GrepInput = {
  readonly pattern: string
  readonly path: string
  readonly glob?: string
  readonly outputMode: GrepOutputMode
  readonly caseInsensitive: boolean
  readonly lineNumbers: boolean
  readonly beforeContext: number
  readonly afterContext: number
  readonly headLimit: number
  readonly offset: number
  readonly type?: string
  readonly multiline: boolean
  readonly onlyMatching: boolean
  readonly expectedRevision?: string
}

const VCS_DIRECTORIES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]

export const GrepInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    pattern: {
      type: "string",
      description: "The regular expression pattern to search for.",
    },
    path: {
      type: "string",
      description:
        'Workspace-relative file or directory to search. Defaults to ".".',
    },
    glob: {
      type: "string",
      description: 'Filter files with a glob such as "*.ts".',
    },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count", "count_matches"],
      default: "files_with_matches",
    },
    "-B": { type: "integer", minimum: 0, maximum: 20 },
    "-A": { type: "integer", minimum: 0, maximum: 20 },
    "-C": { type: "integer", minimum: 0, maximum: 20 },
    context: { type: "integer", minimum: 0, maximum: 20 },
    "-n": { type: "boolean" },
    "-i": { type: "boolean" },
    "-o": { type: "boolean" },
    type: { type: "string" },
    head_limit: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
    multiline: { type: "boolean" },
    expected_revision: { type: "string" },
  },
  required: ["pattern"],
}

export function parseGrepInput(
  input: unknown,
  maxResults: number,
):
  | ({ readonly ok: true } & GrepInput)
  | { readonly ok: false; readonly message: string } {
  if (
    !isRecord(input) ||
    typeof input.pattern !== "string" ||
    input.pattern.length === 0
  ) {
    return { ok: false, message: "grep pattern must be a non-empty string." }
  }
  const allowed = new Set([
    "pattern",
    "path",
    "glob",
    "output_mode",
    "-B",
    "-A",
    "-C",
    "context",
    "-n",
    "-i",
    "-o",
    "type",
    "head_limit",
    "offset",
    "multiline",
    "expected_revision",
  ])
  const unsupported = Object.keys(input).find((key) => !allowed.has(key))
  if (unsupported !== undefined) {
    return {
      ok: false,
      message: `grep does not accept the ${unsupported} argument.`,
    }
  }
  for (const key of ["path", "glob", "type", "expected_revision"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      return { ok: false, message: `grep ${key} must be a string.` }
    }
  }
  const mode = input.output_mode ?? "files_with_matches"
  if (
    !(
      mode === "content" ||
      mode === "files_with_matches" ||
      mode === "count" ||
      mode === "count_matches"
    )
  ) {
    return { ok: false, message: "grep output_mode is invalid." }
  }
  for (const key of ["-i", "-n", "-o", "multiline"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      return { ok: false, message: `grep ${key} must be a boolean.` }
    }
  }
  for (const key of ["-B", "-A", "-C", "context"] as const) {
    if (input[key] !== undefined && !boundedInteger(input[key], 0, 20)) {
      return {
        ok: false,
        message: `grep ${key} must be an integer from 0 to 20.`,
      }
    }
  }
  if (input.head_limit !== undefined && !boundedInteger(input.head_limit, 0)) {
    return {
      ok: false,
      message: "grep head_limit must be a non-negative integer.",
    }
  }
  if (input.offset !== undefined && !boundedInteger(input.offset, 0)) {
    return {
      ok: false,
      message: "grep offset must be a non-negative integer.",
    }
  }

  const sharedContext =
    typeof input.context === "number"
      ? input.context
      : typeof input["-C"] === "number"
        ? input["-C"]
        : undefined
  const requestedLimit =
    typeof input.head_limit === "number" && input.head_limit > 0
      ? input.head_limit
      : maxResults
  return {
    ok: true,
    pattern: input.pattern,
    path: typeof input.path === "string" ? input.path : ".",
    ...(typeof input.glob === "string" ? { glob: input.glob } : {}),
    outputMode: mode === "count_matches" ? "count" : mode,
    caseInsensitive: input["-i"] === true,
    lineNumbers: input["-n"] !== false,
    beforeContext:
      sharedContext ?? (typeof input["-B"] === "number" ? input["-B"] : 0),
    afterContext:
      sharedContext ?? (typeof input["-A"] === "number" ? input["-A"] : 0),
    headLimit: Math.min(requestedLimit, maxResults),
    offset: typeof input.offset === "number" ? input.offset : 0,
    ...(typeof input.type === "string" ? { type: input.type } : {}),
    multiline: input.multiline === true,
    onlyMatching: input["-o"] === true,
    ...(typeof input.expected_revision === "string"
      ? { expectedRevision: input.expected_revision }
      : {}),
  }
}

export function buildGrepArguments(
  input: GrepInput,
  path: string,
  includeIgnored: boolean,
): readonly string[] {
  const common = [
    "--hidden",
    "--no-require-git",
    ...VCS_DIRECTORIES.flatMap((directory) => ["--glob", `!${directory}`]),
    ...SensitivePathGlobs.flatMap((glob) => ["--glob", glob]),
    ...(includeIgnored ? ["--no-ignore"] : []),
    ...(input.caseInsensitive ? ["-i"] : []),
    ...(input.glob === undefined ? [] : ["--glob", input.glob]),
    ...(input.type === undefined ? [] : ["--type", input.type]),
    ...(input.multiline ? ["--multiline"] : []),
  ]
  if (input.outputMode === "files_with_matches") {
    return [
      "--files-with-matches",
      "--null",
      "--sortr=modified",
      ...common,
      "--",
      input.pattern,
      path,
    ]
  }
  if (input.outputMode === "count") {
    return [
      "--count-matches",
      "--with-filename",
      "--null",
      "--sort=path",
      ...common,
      "--",
      input.pattern,
      path,
    ]
  }
  return [
    "--json",
    "--sort=path",
    "--max-columns",
    "500",
    ...common,
    ...(input.beforeContext > 0 ? ["-B", String(input.beforeContext)] : []),
    ...(input.afterContext > 0 ? ["-A", String(input.afterContext)] : []),
    ...(input.onlyMatching ? ["--only-matching"] : []),
    "--",
    input.pattern,
    path,
  ]
}

export function grepRevision(
  input: GrepInput,
  path: string,
  includeIgnored: boolean,
  checkpoint: string,
): string {
  const query = {
    pattern: input.pattern,
    path,
    ...(input.glob === undefined ? {} : { glob: input.glob }),
    outputMode: input.outputMode,
    caseInsensitive: input.caseInsensitive,
    lineNumbers: input.lineNumbers,
    beforeContext: input.beforeContext,
    afterContext: input.afterContext,
    ...(input.type === undefined ? {} : { type: input.type }),
    multiline: input.multiline,
    onlyMatching: input.onlyMatching,
    includeIgnored,
  }
  return createHash("sha256")
    .update(JSON.stringify({ query, checkpoint }))
    .digest("hex")
}

function boundedInteger(value: unknown, minimum: number, maximum = Infinity) {
  return (
    Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
