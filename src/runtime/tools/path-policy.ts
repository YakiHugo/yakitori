import { lstat, realpath } from "node:fs/promises"
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { runRipgrep } from "./ripgrep.ts"

export type PathPolicyError = {
  readonly code: string
  readonly message: string
}

export const SensitivePathGlobs = [
  "!**/.env*",
  "!**/.ssh/**",
  "!**/.git-credentials",
  "!**/.netrc",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/.aws/credentials",
  "!**/.docker/config.json",
  "!**/.kube/config",
  "!**/*.key",
  "!**/*.pem",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/credentials.json",
  "!**/secrets.json",
  "!**/service-account*.json",
] as const

export type ResolvedWorkspacePath =
  | {
      readonly ok: true
      readonly absolutePath: string
      readonly relativePath: string
      readonly exists: boolean
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

export async function resolveReadPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const validated = validateRelativePathInput(relativePath)
  if (!validated.ok) return validated

  const candidate = resolve(workspaceRoot, validated.relativePath)
  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    return pathDenied("Path escapes the workspace.")
  }

  try {
    const absolutePath = await realpath(candidate)
    if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
      return pathDenied("Path escapes the workspace via symlink.")
    }
    const stats = await lstat(absolutePath)
    if (stats.isDirectory()) {
      return pathError(
        "directory_not_supported",
        "read_file does not read directories. Use glob to list matching files.",
      )
    }
    return {
      ok: true,
      absolutePath,
      relativePath: toRelativePath(workspaceRoot, absolutePath),
      exists: true,
    }
  } catch {
    const suggestion = await suggestWorkspacePath(workspaceRoot, relativePath)
    return pathError(
      "path_not_found",
      suggestion === undefined
        ? "Path does not exist."
        : `Path does not exist. Did you mean "${suggestion}"?`,
    )
  }
}

export async function resolveWritePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const validated = validateRelativePathInput(relativePath)
  if (!validated.ok) return validated

  const candidate = resolve(workspaceRoot, validated.relativePath)
  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    return pathDenied("Path escapes the workspace.")
  }

  try {
    const absolutePath = await realpath(candidate)
    if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
      return pathDenied("Path escapes the workspace via symlink.")
    }
    const stats = await lstat(absolutePath)
    if (stats.isDirectory()) {
      return pathDenied("Path is a directory; a file is required.")
    }
    return {
      ok: true,
      absolutePath,
      relativePath: toRelativePath(workspaceRoot, absolutePath),
      exists: true,
    }
  } catch {
    // New file: parent must exist and stay inside the workspace.
    const parentCandidate = dirname(candidate)
    try {
      const parentPath = await realpath(parentCandidate)
      if (!isInsideWorkspace(workspaceRoot, parentPath)) {
        return pathDenied("Parent path escapes the workspace.")
      }
      const parentStats = await lstat(parentPath)
      if (!parentStats.isDirectory()) {
        return pathDenied("Parent path is not a directory.")
      }
      return {
        ok: true,
        absolutePath: join(
          parentPath,
          validated.relativePath.split(/[/\\]/).at(-1) ??
            validated.relativePath,
        ),
        relativePath: validated.relativePath,
        exists: false,
      }
    } catch {
      return pathDenied("Parent directory does not exist.")
    }
  }
}

export async function resolveSearchPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const validated = validateRelativePathInput(relativePath)
  if (!validated.ok) return validated
  const candidate = resolve(workspaceRoot, validated.relativePath)
  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    return pathDenied("Path escapes the workspace.")
  }
  try {
    const absolutePath = await realpath(candidate)
    if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
      return pathDenied("Path escapes the workspace via symlink.")
    }
    return {
      ok: true,
      absolutePath,
      relativePath: toRelativePath(workspaceRoot, absolutePath) || ".",
      exists: true,
    }
  } catch {
    return pathDenied("Search path does not exist.")
  }
}

function validateRelativePathInput(
  relativePath: string,
):
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly error: PathPolicyError } {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return pathDenied("Path must be a non-empty relative string.")
  }
  if (relativePath.includes("\0")) {
    return pathDenied("Path must not contain NUL bytes.")
  }
  if (isAbsolute(relativePath)) {
    return pathDenied("Path must be relative to the workspace.")
  }
  if (relativePath.split(/[/\\]/).includes("..")) {
    return pathDenied("Path must not contain parent directory segments.")
  }
  if (isSensitiveWorkspacePath(relativePath)) {
    return pathError(
      "sensitive_path",
      "Access to credential and secret-bearing paths is not allowed.",
    )
  }
  return { ok: true, relativePath }
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  const name = segments.at(-1) ?? ""
  if (name.startsWith(".env")) return true
  if (segments.includes(".ssh")) return true
  if ([".git-credentials", ".netrc", ".npmrc", ".pypirc"].includes(name)) {
    return true
  }
  if (
    normalized.endsWith("/.aws/credentials") ||
    normalized.endsWith("/.docker/config.json") ||
    normalized.endsWith("/.kube/config")
  ) {
    return true
  }
  if ([".key", ".p12", ".pem", ".pfx"].includes(extname(name))) return true
  return (
    name === "application_default_credentials.json" ||
    name === "credentials.json" ||
    name === "secrets.json" ||
    /^service-account.*\.json$/u.test(name)
  )
}

function isInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  if (absolutePath === workspaceRoot) return true
  const rel = relative(workspaceRoot, absolutePath)
  return (
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith("..") &&
    !isAbsolute(rel)
  )
}

function toRelativePath(workspaceRoot: string, absolutePath: string): string {
  return relative(workspaceRoot, absolutePath).split(sep).join("/")
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

async function suggestWorkspacePath(
  workspaceRoot: string,
  requested: string,
): Promise<string | undefined> {
  const listed = await runRipgrep(
    [
      "--files",
      "--hidden",
      "--no-require-git",
      "--glob",
      "!.git/**",
      ...SensitivePathGlobs.flatMap((glob) => ["--glob", glob]),
    ],
    { cwd: workspaceRoot },
  )
  if (!listed.ok) return undefined
  const requestedName = basename(requested).toLowerCase()
  let best: { readonly path: string; readonly distance: number } | undefined
  for (const candidate of listed.stdout.split("\n")) {
    if (candidate.length === 0 || isSensitiveWorkspacePath(candidate)) continue
    const distance = editDistance(
      requestedName,
      basename(candidate).toLowerCase(),
    )
    if (best === undefined || distance < best.distance) {
      best = { path: candidate.replaceAll("\\", "/"), distance }
    }
  }
  const threshold = Math.max(2, Math.floor(requestedName.length * 0.35))
  return best !== undefined && best.distance <= threshold
    ? best.path
    : undefined
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
