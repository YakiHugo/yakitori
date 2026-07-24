import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type PathPolicyError = {
  readonly code: string
  readonly message: string
}

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
      return pathDenied("Path is a directory; a file is required.")
    }
    return {
      ok: true,
      absolutePath,
      relativePath: toRelativePath(workspaceRoot, absolutePath),
      exists: true,
    }
  } catch {
    return pathDenied("Path does not exist.")
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
  return { ok: true, relativePath }
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
  return {
    ok: false,
    error: {
      code: "path_denied",
      message,
    },
  }
}
