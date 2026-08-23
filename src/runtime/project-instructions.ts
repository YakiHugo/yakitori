import { open, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024

const instructionFilenames = ["AGENTS.override.md", "AGENTS.md"] as const

export type ProjectInstructions = {
  readonly directory: string
  readonly text: string
}

export async function loadProjectInstructions(input: {
  readonly workspaceRoot?: string
  readonly workingDirectory: string
  readonly maxBytes?: number
}): Promise<ProjectInstructions | undefined> {
  const maxBytes = input.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES
  if (maxBytes <= 0) return undefined

  const workspaceRoot = await realpath(
    input.workspaceRoot ?? input.workingDirectory,
  )
  const workingDirectory = await realpath(input.workingDirectory)
  requireInsideWorkspace(workspaceRoot, workingDirectory)

  const sections: string[] = []
  let remainingBytes = maxBytes
  let truncated = false

  for (const directory of directoriesFromRoot(
    workspaceRoot,
    workingDirectory,
  )) {
    const path = await findInstructionFile(workspaceRoot, directory)
    if (path === undefined) continue
    if (remainingBytes === 0) {
      truncated = true
      break
    }

    const result = await readPrefix(path, remainingBytes)
    if (result.text.trim().length === 0) continue
    sections.push(
      `# AGENTS.md instructions for ${directory}\n\n<INSTRUCTIONS>\n${result.text}\n</INSTRUCTIONS>`,
    )
    remainingBytes -= result.byteCount
    truncated = result.truncated
    if (truncated) break
  }

  if (sections.length === 0) return undefined
  const suffix = truncated
    ? "\n\n<Project instructions were truncated at the configured byte limit.>"
    : ""
  const text = `${sections.join("\n\n")}${suffix}`
  return {
    directory: workingDirectory,
    text,
  }
}

function directoriesFromRoot(root: string, directory: string): string[] {
  const directories = [directory]
  let current = directory
  while (current !== root) {
    current = dirname(current)
    directories.push(current)
  }
  return directories.reverse()
}

async function findInstructionFile(
  workspaceRoot: string,
  directory: string,
): Promise<string | undefined> {
  for (const filename of instructionFilenames) {
    const candidate = join(directory, filename)
    if (!(await fileExists(candidate))) continue
    const path = await realpath(candidate)
    requireInsideWorkspace(workspaceRoot, path)
    return path
  }
  return undefined
}

function requireInsideWorkspace(workspaceRoot: string, path: string): void {
  const child = relative(workspaceRoot, path)
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== "..")) {
    return
  }
  throw new Error(`Project instruction path escapes the workspace: ${path}`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false
    }
    throw error
  }
}

async function readPrefix(
  path: string,
  maxBytes: number,
): Promise<{
  readonly byteCount: number
  readonly text: string
  readonly truncated: boolean
}> {
  const file = await open(path, "r")
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const byteCount = Math.min(bytesRead, maxBytes)
    return {
      byteCount,
      text: buffer.subarray(0, byteCount).toString("utf8"),
      truncated: bytesRead > maxBytes,
    }
  } finally {
    await file.close()
  }
}
