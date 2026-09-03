import { open, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
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
  readonly homeDir?: string
}): Promise<ProjectInstructions | undefined> {
  const maxBytes = input.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES
  if (maxBytes <= 0) return undefined

  const workspaceRoot = await realpath(
    input.workspaceRoot ?? input.workingDirectory,
  )
  const workingDirectory = await realpath(input.workingDirectory)
  requireInsideWorkspace(workspaceRoot, workingDirectory)

  const userPath = await findUserInstructionsFile(
    input.homeDir ?? defaultHomeDir(),
  )
  const userKey = userPath === undefined ? undefined : await realpath(userPath)
  const projectDirectories = directoriesFromRoot(
    workspaceRoot,
    workingDirectory,
  )
  const projectPaths: string[] = []
  for (const directory of projectDirectories) {
    const path = await findInstructionFile(workspaceRoot, directory)
    if (path !== undefined && path !== userKey) projectPaths.push(path)
  }

  const sections: string[] = []
  if (userPath !== undefined) {
    // The user-level file has its own budget; project documents share the
    // configured limit below it.
    const user = await readPrefix(userPath, maxBytes)
    if (user.text.trim().length > 0) {
      const suffix = user.truncated
        ? "\n<User instructions were truncated at the configured byte limit.>"
        : ""
      sections.push(`${formatSection(userPath, user.text)}${suffix}`)
    }
  }
  let truncated = false
  let remainingBytes = maxBytes
  for (const path of projectPaths) {
    if (remainingBytes === 0) {
      truncated = true
      break
    }
    const result = await readPrefix(path, remainingBytes)
    if (result.text.trim().length === 0) continue
    sections.push(formatSection(path, result.text))
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

// Steps re-evaluate project instructions so mid-session edits flow through
// the world-state diff; this loader keeps that freshness while re-reading
// only files whose mtime or size changed since the previous Step.
export function createProjectInstructionsLoader(): (input: {
  readonly workspaceRoot?: string
  readonly workingDirectory: string
  readonly maxBytes?: number
  readonly homeDir?: string
}) => Promise<ProjectInstructions | undefined> {
  let cached:
    | {
        readonly key: string
        readonly signatures: string
        readonly result: ProjectInstructions | undefined
      }
    | undefined
  return async (input) => {
    const key = JSON.stringify([
      input.workspaceRoot,
      input.workingDirectory,
      input.maxBytes,
      input.homeDir,
    ])
    const signatures = await collectInstructionSignatures(input)
    if (
      cached !== undefined &&
      cached.key === key &&
      cached.signatures === signatures
    ) {
      return cached.result
    }
    const result = await loadProjectInstructions(input)
    cached = { key, signatures, result }
    return result
  }
}

async function collectInstructionSignatures(input: {
  readonly workspaceRoot?: string
  readonly workingDirectory: string
  readonly homeDir?: string
}): Promise<string> {
  const workspaceRoot = await realpath(
    input.workspaceRoot ?? input.workingDirectory,
  )
  const workingDirectory = await realpath(input.workingDirectory)
  requireInsideWorkspace(workspaceRoot, workingDirectory)

  const candidates = [
    await findUserInstructionsFile(input.homeDir ?? defaultHomeDir()),
  ]
  for (const directory of directoriesFromRoot(
    workspaceRoot,
    workingDirectory,
  )) {
    candidates.push(await findInstructionFile(workspaceRoot, directory))
  }
  const signatures = await Promise.all(
    candidates.map(async (path) => {
      if (path === undefined) return "-"
      const info = await stat(path).catch(() => undefined)
      return info === undefined ? "-" : `${path}:${info.mtimeMs}:${info.size}`
    }),
  )
  return signatures.join("\n")
}

function defaultHomeDir(): string {
  return process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori")
}

async function findUserInstructionsFile(
  homeDir: string,
): Promise<string | undefined> {
  for (const filename of instructionFilenames) {
    const candidate = join(homeDir, filename)
    // The first non-empty candidate wins: an empty override falls through to
    // AGENTS.md, and an unreadable user file is skipped rather than failing
    // the Step (the user home sits outside the workspace trust boundary).
    const probe = await readPrefix(
      candidate,
      PROJECT_INSTRUCTIONS_MAX_BYTES,
    ).catch(() => undefined)
    if (probe !== undefined && probe.text.trim().length > 0) return candidate
  }
  return undefined
}

function formatSection(path: string, text: string): string {
  const directory = dirname(path)
  return `# AGENTS.md instructions for ${directory}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`
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
