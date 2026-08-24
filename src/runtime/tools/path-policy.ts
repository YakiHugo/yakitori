import { lstat, readdir, realpath } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"

const SUGGESTION_TIMEOUT_MS = 1_000
const MAX_PATH_SUGGESTIONS = 3

export type PathPolicyError = {
  readonly code: string
  readonly message: string
}

export type ResolvedFileTarget =
  | {
      readonly ok: true
      readonly absolutePath: string
      readonly displayPath: string
      readonly exists: boolean
      readonly kind: "file" | "directory"
    }
  | {
      readonly ok: false
      readonly error: PathPolicyError
    }

export async function resolveWorkspaceRoot(workspace: string): Promise<string> {
  const resolved = await realpath(workspace)
  const stats = await lstat(resolved)
  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`)
  }
  return resolved
}

export async function resolveCommandCwd(
  workspaceRoot: string,
  cwd?: string,
): Promise<ResolvedFileTarget> {
  const canonicalRoot = await resolveWorkspaceRoot(workspaceRoot)
  if (cwd !== undefined && (cwd.length === 0 || cwd.includes("\0"))) {
    return pathError("invalid_cwd", "Command cwd must be a non-empty path.")
  }
  const candidate =
    cwd === undefined
      ? canonicalRoot
      : isAbsolute(cwd)
        ? resolve(cwd)
        : resolve(canonicalRoot, cwd)
  try {
    const absolutePath = await realpath(candidate)
    if (!isInsideWorkspace(canonicalRoot, absolutePath)) {
      return pathError(
        "invalid_cwd",
        "Command cwd escapes the workspace via symlink.",
      )
    }
    const stats = await lstat(absolutePath)
    if (!stats.isDirectory()) {
      return pathError("invalid_cwd", "Command cwd must be a directory.")
    }
    return {
      ok: true,
      absolutePath,
      displayPath: toRelativePath(canonicalRoot, absolutePath) || ".",
      exists: true,
      kind: "directory",
    }
  } catch {
    return pathError("invalid_cwd", "Command cwd does not exist.")
  }
}

export async function resolveReadPath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<ResolvedFileTarget> {
  const validated = validatePathInput(requestedPath)
  if (!validated.ok) return validated
  const canonicalRoot = await resolveWorkspaceRoot(workspaceRoot)
  const candidate = pathCandidate(canonicalRoot, validated.path)
  try {
    const absolutePath = await realpath(candidate)
    const stats = await lstat(absolutePath)
    if (stats.isDirectory()) {
      return {
        ok: true,
        absolutePath,
        displayPath: displayPath(canonicalRoot, absolutePath) || ".",
        exists: true,
        kind: "directory",
      }
    }
    if (!stats.isFile()) {
      return pathError(
        "unsupported_file_type",
        "read_file only reads regular files; streams and device files require a bounded command.",
      )
    }
    return {
      ok: true,
      absolutePath,
      displayPath: displayPath(canonicalRoot, absolutePath),
      exists: true,
      kind: "file",
    }
  } catch {
    const suggestion = isInsideWorkspace(canonicalRoot, candidate)
      ? await formatPathSuggestions(canonicalRoot, requestedPath)
      : undefined
    return pathError(
      "path_not_found",
      suggestion === undefined
        ? "Path does not exist."
        : `Path does not exist. ${suggestion}`,
    )
  }
}

export async function resolveWritePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<ResolvedFileTarget> {
  const validated = validatePathInput(requestedPath)
  if (!validated.ok) return validated
  const canonicalRoot = await resolveWorkspaceRoot(workspaceRoot)
  const candidate = pathCandidate(canonicalRoot, validated.path)
  try {
    const absolutePath = await realpath(candidate)
    const stats = await lstat(absolutePath)
    if (stats.isDirectory()) {
      return pathDenied("Path is a directory; a file is required.")
    }
    return {
      ok: true,
      absolutePath,
      displayPath: displayPath(canonicalRoot, absolutePath),
      exists: true,
      kind: "file",
    }
  } catch {
    // New file: parent must exist and stay inside the workspace.
    const parentCandidate = dirname(candidate)
    try {
      const parentPath = await realpath(parentCandidate)
      const parentStats = await lstat(parentPath)
      if (!parentStats.isDirectory()) {
        return pathDenied("Parent path is not a directory.")
      }
      const absolutePath = join(
        parentPath,
        validated.path.split(/[/\\]/).at(-1) ?? validated.path,
      )
      return {
        ok: true,
        absolutePath,
        displayPath: displayPath(canonicalRoot, absolutePath),
        exists: false,
        kind: "file",
      }
    } catch {
      return pathDenied("Parent directory does not exist.")
    }
  }
}

export async function resolveSearchPath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<ResolvedFileTarget> {
  const validated = validatePathInput(requestedPath)
  if (!validated.ok) return validated
  const canonicalRoot = await resolveWorkspaceRoot(workspaceRoot)
  const candidate = pathCandidate(canonicalRoot, validated.path)
  try {
    const absolutePath = await realpath(candidate)
    const stats = await lstat(absolutePath)
    return {
      ok: true,
      absolutePath,
      displayPath: displayPath(canonicalRoot, absolutePath) || ".",
      exists: true,
      kind: stats.isDirectory() ? "directory" : "file",
    }
  } catch {
    return pathDenied("Search path does not exist.")
  }
}

function validatePathInput(
  requestedPath: string,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: PathPolicyError } {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return pathDenied("Path must be a non-empty string.")
  }
  if (requestedPath.includes("\0")) {
    return pathDenied("Path must not contain NUL bytes.")
  }
  return { ok: true, path: requestedPath }
}

function pathCandidate(workspaceRoot: string, requestedPath: string): string {
  return resolve(
    isAbsolute(requestedPath)
      ? requestedPath
      : resolve(workspaceRoot, requestedPath),
  )
}

export function isInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  const rel = relative(workspaceRoot, absolutePath)
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  )
}

function toRelativePath(workspaceRoot: string, absolutePath: string): string {
  return relative(workspaceRoot, absolutePath).split(sep).join("/")
}

function displayPath(workspaceRoot: string, absolutePath: string): string {
  return isInsideWorkspace(workspaceRoot, absolutePath)
    ? toRelativePath(workspaceRoot, absolutePath)
    : absolutePath
}

function pathDenied(message: string): {
  readonly ok: false
  readonly error: PathPolicyError
} {
  return pathError("path_denied", message)
}

function pathError(
  code: string,
  message: string,
): {
  readonly ok: false
  readonly error: PathPolicyError
} {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  }
}

async function formatPathSuggestions(
  workspaceRoot: string,
  requested: string,
): Promise<string | undefined> {
  let suggestions: readonly string[]
  try {
    suggestions = await withTimeout(
      suggestWorkspacePaths(workspaceRoot, requested),
      SUGGESTION_TIMEOUT_MS,
    )
  } catch {
    return undefined
  }
  if (suggestions.length === 0) return undefined
  if (suggestions.length === 1) return `Did you mean "${suggestions[0]}"?`
  return `Did you mean one of these?\n${suggestions.join("\n")}`
}

async function suggestWorkspacePaths(
  workspaceRoot: string,
  requested: string,
): Promise<readonly string[]> {
  const normalized = requested.replaceAll("\\", "/")
  const parentRel = dirname(normalized)
  const parentCandidate =
    parentRel === "." ? workspaceRoot : resolve(workspaceRoot, parentRel)
  if (!isInsideWorkspace(workspaceRoot, parentCandidate)) return []

  let parentPath: string
  try {
    parentPath = await realpath(parentCandidate)
  } catch {
    return []
  }
  if (!isInsideWorkspace(workspaceRoot, parentPath)) return []

  let names: string[]
  try {
    names = await readdir(parentPath)
  } catch {
    return []
  }

  const requestedName = basename(normalized).toLowerCase()
  if (requestedName.length === 0) return []
  const threshold = Math.max(2, Math.floor(requestedName.length * 0.35))
  const ranked: { readonly path: string; readonly distance: number }[] = []
  for (const name of names) {
    const distance = editDistance(requestedName, name.toLowerCase())
    if (distance > threshold) continue
    const relativePath =
      parentRel === "." ? name : `${parentRel}/${name}`.replaceAll("\\", "/")
    ranked.push({ path: relativePath, distance })
  }
  ranked.sort((left, right) => left.distance - right.distance)
  return ranked.slice(0, MAX_PATH_SUGGESTIONS).map((entry) => entry.path)
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("path suggestion timed out"))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void task.catch(() => undefined)
  }
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length] ?? left.length
}
