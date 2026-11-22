import { realpath as filesystemRealpath } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { promisify } from "node:util"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"

const realpath = promisify(filesystemRealpath.native)

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
      readonly requestedDisplayPath: string
      readonly exists: boolean
      readonly kind: "file" | "directory"
    }
  | {
      readonly ok: false
      readonly error: PathPolicyError
    }

export type ResolvedWriteTarget = Extract<ResolvedFileTarget, { ok: true }> & {
  readonly missingParents: readonly string[]
}

class InvalidWorkspaceRootError extends Error {}

export async function resolveWorkspaceRoot(workspace: string): Promise<string> {
  const resolved = await realpath(workspace)
  const stats = await lstat(resolved)
  if (!stats.isDirectory()) {
    throw new InvalidWorkspaceRootError(
      `Workspace is not a directory: ${workspace}`,
    )
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
    const stats = await lstat(absolutePath)
    if (!stats.isDirectory()) {
      return pathError("invalid_cwd", "Command cwd must be a directory.")
    }
    return {
      ok: true,
      absolutePath,
      displayPath: toRelativePath(canonicalRoot, absolutePath) || ".",
      requestedDisplayPath: displayPath(canonicalRoot, candidate) || ".",
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
        requestedDisplayPath: displayPath(canonicalRoot, candidate) || ".",
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
      requestedDisplayPath: displayPath(canonicalRoot, candidate),
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
  allowMissingParents = false,
): Promise<ResolvedWriteTarget | Extract<ResolvedFileTarget, { ok: false }>> {
  const validated = validatePathInput(requestedPath)
  if (!validated.ok) return validated
  let canonicalRoot: string
  try {
    canonicalRoot = await resolveWorkspaceRoot(workspaceRoot)
  } catch (error) {
    if (
      !(error instanceof InvalidWorkspaceRootError) &&
      !(error instanceof Error && "code" in error)
    )
      throw error
    return pathError(
      "workspace_unavailable",
      "The workspace directory could not be resolved.",
    )
  }
  const candidate = pathCandidate(canonicalRoot, validated.path)
  const suffix: string[] = []
  let ancestor = candidate
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      const stats = await lstat(canonical)
      if (suffix.length > 0 ? !stats.isDirectory() : !stats.isFile()) {
        return pathDenied(
          suffix.length > 0
            ? "Parent path is not a directory."
            : "Path must be a regular file.",
        )
      }
      const absolutePath = join(canonical, ...suffix)
      return {
        ok: true,
        absolutePath,
        displayPath: displayPath(canonicalRoot, absolutePath),
        requestedDisplayPath: displayPath(canonicalRoot, candidate),
        exists: suffix.length === 0,
        kind: "file",
        missingParents: suffix
          .slice(0, -1)
          .map((_, index) => join(canonical, ...suffix.slice(0, index + 1))),
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
        if (!(error instanceof Error && "code" in error)) throw error
        return pathDenied("File path could not be resolved.")
      }
      // A dangling link occupies its path and cannot serve as a parent.
      try {
        await lstat(ancestor)
        return pathDenied("Path contains an invalid symbolic link.")
      } catch (cause) {
        if (!hasErrorCode(cause, "ENOENT") && !hasErrorCode(cause, "ENOTDIR")) {
          if (!(cause instanceof Error && "code" in cause)) throw cause
          return pathDenied("File path could not be resolved.")
        }
      }
      const parent = dirname(ancestor)
      if (parent === ancestor || (!allowMissingParents && suffix.length > 0)) {
        return pathDenied("Parent directory does not exist.")
      }
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export async function conflictingFileTargets(
  targets: readonly ResolvedWriteTarget[],
): Promise<{ kind: "parent" | "alias"; path: string } | undefined> {
  const paths = new Set(targets.map((target) => target.absolutePath))
  const missing = new Map<string, string[]>()
  const caseProbes = new Map<string, Promise<boolean>>()
  const mayAlias = async (first: string, second: string) => {
    // Darwin volumes can match Unicode normalization variants even when
    // letter case stays significant. Missing entries have no native identity.
    if (
      process.platform === "darwin" &&
      first.normalize("NFC") === second.normalize("NFC")
    )
      return true
    const directory = dirname(second)
    const probe =
      caseProbes.get(directory) ?? hasCaseInsensitiveAncestor(directory)
    caseProbes.set(directory, probe)
    return probe
  }
  for (const target of targets) {
    if (target.exists) continue
    const path = target.absolutePath
    const folded = fileNameComparisonKey(path)
    const others = missing.get(folded) ?? []
    for (const other of others) {
      if (other !== path && (await mayAlias(other, path)))
        return { kind: "alias", path }
    }
    others.push(path)
    missing.set(folded, others)
  }
  for (const { missingParents } of targets) {
    for (const parent of missingParents) {
      if (paths.has(parent)) return { kind: "parent", path: parent }
      for (const file of missing.get(fileNameComparisonKey(parent)) ?? []) {
        if (await mayAlias(file, parent))
          return { kind: "parent", path: parent }
      }
    }
  }
}

function fileNameComparisonKey(path: string): string {
  return path
    .toLowerCase()
    .replaceAll("ς", "σ")
    .replaceAll("ß", "ss")
    .normalize("NFC")
}

// Lock conservatively across filesystem-specific spellings. Actual identity
// still comes from the filesystem, including on a case-sensitive volume.
export function fileWriteLockKey(path: string): string {
  return fileNameComparisonKey(path.toUpperCase())
}

export async function isSameWriteTarget(
  workspaceRoot: string,
  plannedPath: string,
  resolvedPath: string,
  allowCreatedParentSpelling = false,
): Promise<boolean> {
  if (plannedPath === resolvedPath) return true
  if (
    !allowCreatedParentSpelling ||
    basename(plannedPath) !== basename(resolvedPath) ||
    fileWriteLockKey(plannedPath) !== fileWriteLockKey(resolvedPath)
  )
    return false
  const planned = await resolveWritePath(workspaceRoot, plannedPath, true)
  if (!planned.ok || planned.exists || planned.absolutePath !== resolvedPath)
    return false

  // A sibling creation can establish the spelling of a shared directory.
  // A new symbolic link in the previously canonical path is a retarget.
  for (
    let parent = dirname(plannedPath);
    parent !== dirname(parent);
    parent = dirname(parent)
  ) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) return false
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue
      if (!(error instanceof Error && "code" in error)) throw error
      return false
    }
  }
  return true
}

// Probe an existing name on the target volume without creating an entry.
async function hasCaseInsensitiveAncestor(path: string): Promise<boolean> {
  for (
    let candidate = path;
    candidate !== dirname(candidate);
    candidate = dirname(candidate)
  ) {
    try {
      const existing = await realpath(candidate)
      const parent = dirname(existing)
      if ((await lstat(existing)).dev !== (await lstat(parent)).dev)
        return process.platform === "win32"
      const name = basename(existing)
      const alternate = name.replace(/[a-z]/iu, (letter) =>
        letter === letter.toLowerCase()
          ? letter.toUpperCase()
          : letter.toLowerCase(),
      )
      if (name === alternate) continue
      const alias = join(parent, alternate)
      return (
        !(await lstat(alias)).isSymbolicLink() &&
        (await realpath(alias)) === existing
      )
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR"))
        throw error
      // Walk up only when the candidate itself is missing. An existing name
      // without a case variant establishes a case-sensitive lookup.
      try {
        await lstat(candidate)
        return false
      } catch (cause) {
        if (!hasErrorCode(cause, "ENOENT") && !hasErrorCode(cause, "ENOTDIR"))
          throw cause
      }
    }
  }
  return process.platform === "win32"
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
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
      requestedDisplayPath: displayPath(canonicalRoot, candidate) || ".",
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

function isInsideWorkspace(
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
