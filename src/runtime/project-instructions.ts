import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import type { ModelUserMessage } from "./model.ts"

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024

const instructionFilenames = ["AGENTS.override.md", "AGENTS.md"] as const

export type ProjectInstructions = {
  readonly files: readonly string[]
  readonly message: ModelUserMessage
  readonly truncated: boolean
}

export async function loadProjectInstructions(input: {
  readonly workingDirectory: string
  readonly maxBytes?: number
}): Promise<ProjectInstructions | undefined> {
  const maxBytes = input.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES
  if (maxBytes <= 0) return undefined

  // Discovery is intentionally limited to the working directory: the
  // workspace root is the tool path-policy root, so this loader must not
  // read instruction files outside it either.
  const path = await findInstructionFile(input.workingDirectory)
  if (path === undefined) return undefined

  const result = await readPrefix(path, maxBytes)
  if (result.text.trim().length === 0) return undefined

  const suffix = result.truncated
    ? "\n\n<Project instructions were truncated at the configured byte limit.>"
    : ""
  return {
    files: [path],
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `# AGENTS.md instructions for ${input.workingDirectory}\n\n<INSTRUCTIONS>\n${result.text}\n</INSTRUCTIONS>${suffix}`,
        },
      ],
    },
    truncated: result.truncated,
  }
}

async function findInstructionFile(
  directory: string,
): Promise<string | undefined> {
  for (const filename of instructionFilenames) {
    const path = join(directory, filename)
    if (await fileExists(path)) return path
  }
  return undefined
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
