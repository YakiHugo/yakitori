import { realpath, stat } from "node:fs/promises"
import path from "node:path"

const executableExtensions = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".command",
  ".desktop",
  ".dmg",
  ".exe",
  ".msi",
  ".pkg",
  ".ps1",
  ".scr",
])

export async function resolveOpenableWorkspaceFile(
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const workspacePath = await realpath(workspace)
  const targetPath = await realpath(
    path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(workspacePath, requestedPath),
  )
  const relative = path.relative(workspacePath, targetPath)
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("File open requests must stay within the workspace.")
  }

  const metadata = await stat(targetPath)
  if (!metadata.isFile()) {
    throw new Error("File open requests require a regular file.")
  }

  // shell.openPath delegates to the OS default handler. Keep this bridge a
  // file-viewing boundary instead of allowing model-authored links to launch
  // executable files or installers.
  if (
    (metadata.mode & 0o111) !== 0 ||
    executableExtensions.has(path.extname(targetPath).toLowerCase())
  ) {
    throw new Error("Executable files cannot be opened from the transcript.")
  }
  return targetPath
}
