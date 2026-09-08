import { join } from "node:path"
import {
  fileSignature,
  type InstructionDiagnostic,
  type InstructionPrefix,
  instructionDirectories,
  instructionHome,
  isFileSystemError,
  readInstructionPrefix,
} from "./instruction-files.ts"

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024
export type ProjectInstructions = Readonly<{ directory: string; text: string }>
export type ProjectInstructionInput = Readonly<{
  workspaceRoot?: string
  workingDirectory: string
  maxBytes?: number
  homeDir?: string
  projectRootMarkers?: readonly string[]
  fallbackFilenames?: readonly string[]
  onDiagnostic?: (diagnostic: InstructionDiagnostic) => void
}>

export async function loadProjectInstructions(
  input: ProjectInstructionInput,
): Promise<ProjectInstructions | undefined> {
  return createProjectInstructionsLoader()(input)
}

export function createProjectInstructionsLoader(): (
  input: ProjectInstructionInput,
) => Promise<ProjectInstructions | undefined> {
  const files = new Map<
    string,
    {
      signature: string
      maxBytes: number
      result: InstructionPrefix
    }
  >()
  return async (input) => {
    const maxBytes = input.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES
    if (maxBytes <= 0) return undefined
    const directories = await instructionDirectories(
      input.workingDirectory,
      input.projectRootMarkers,
      input.workspaceRoot,
    )
    const names = [
      ...new Set([
        "AGENTS.override.md",
        "AGENTS.md",
        ...(input.fallbackFilenames ?? []),
      ]),
    ]
    const sections: string[] = []
    const seen = new Set<string>()
    const readCachedFile = async (path: string, limit: number) => {
      const signature = await fileSignature(path)
      if (signature === undefined) {
        files.delete(path)
        return undefined
      }
      seen.add(path)
      const cached = files.get(path)
      if (cached?.signature === signature && cached.maxBytes === limit)
        return cached.result
      const result = await readInstructionPrefix(path, limit)
      files.set(path, { signature, maxBytes: limit, result })
      return result
    }
    const append = (directory: string, result: InstructionPrefix) => {
      sections.push(
        `# AGENTS.md instructions for ${directory}\n\n<INSTRUCTIONS>\n${result.text}\n</INSTRUCTIONS>${result.truncated ? "\n<Project instructions were truncated at the configured byte limit.>" : ""}`,
      )
    }
    const home = input.homeDir ?? instructionHome()
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const path = join(home, name)
      try {
        const result = await readCachedFile(path, maxBytes)
        if (result?.text.trim()) {
          append(home, result)
          break
        }
      } catch (error) {
        if (!isFileSystemError(error)) throw error
        if (error.code !== "ENOENT")
          input.onDiagnostic?.({ path, message: error.message })
      }
    }
    let remaining = maxBytes
    const userSectionCount = sections.length
    project: for (const directory of directories) {
      if (directory === home || remaining === 0) continue
      for (const name of names) {
        const path = join(directory, name)
        try {
          const result = await readCachedFile(path, remaining)
          if (result === undefined) continue
          if (result.text.trim()) {
            append(directory, result)
            remaining -= result.byteCount
          }
          break
        } catch (error) {
          if (!isFileSystemError(error)) throw error
          if (error.code === "ENOENT") continue
          // This host has no read sandbox. Report the failed project load at
          // the runtime boundary, matching Codex's unrestricted host behavior.
          input.onDiagnostic?.({ path, message: error.message })
          sections.length = userSectionCount
          break project
        }
      }
    }
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path)
    return sections.length === 0
      ? undefined
      : { directory: input.workingDirectory, text: sections.join("\n\n") }
  }
}
