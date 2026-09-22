import { opendir, realpath, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  type InstructionDiagnostic,
  isFileSystemError,
} from "./instruction-files.ts"

// Per-root host safety boundaries bound directory enumeration and traversal
// memory without allowing a large repository root to starve user skills.
const MAX_SCAN_ENTRIES = 20_000
const MAX_SCAN_DEPTH = 32
export const MAX_CONCURRENT_SKILL_LOADS = 64

export async function discoverSkillFiles(root: string): Promise<{
  paths: string[]
  diagnostics: InstructionDiagnostic[]
}> {
  const paths: string[] = []
  const diagnostics: InstructionDiagnostic[] = []
  const visited = new Set<string>()
  let entries = 0
  let truncated = false
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || entries >= MAX_SCAN_ENTRIES) {
      truncated = true
      return
    }
    if (visited.has(path)) return
    visited.add(path)
    try {
      // Streaming enumeration avoids materializing arbitrarily large folders.
      // Dirent types mean unrelated ordinary files need no stat/realpath.
      const directory = await opendir(path)
      const children: string[] = []
      for await (const entry of directory) {
        if (entries++ >= MAX_SCAN_ENTRIES) {
          truncated = true
          break
        }
        const child = join(path, entry.name)
        if (entry.isFile()) {
          if (entry.name === "SKILL.md") paths.push(child)
        } else if (!entry.name.startsWith(".")) {
          if (entry.isDirectory()) children.push(child)
          else if (entry.isSymbolicLink()) {
            try {
              const canonical = await realpath(child)
              const info = await stat(canonical)
              if (info.isDirectory()) children.push(canonical)
              else if (info.isFile() && entry.name === "SKILL.md")
                paths.push(canonical)
            } catch (error) {
              if (!isFileSystemError(error)) throw error
              if (error.code !== "ENOENT")
                diagnostics.push({ path: child, message: error.message })
            }
          }
        }
      }
      children.sort()
      for (const child of children) {
        await visit(child, depth + 1)
        if (entries >= MAX_SCAN_ENTRIES) break
      }
    } catch (error) {
      if (!isFileSystemError(error)) throw error
      if (error.code !== "ENOENT")
        diagnostics.push({ path, message: error.message })
    }
  }
  try {
    const path = await realpath(root)
    const info = await stat(path)
    if (info.isDirectory()) await visit(path, 0)
    else if (info.isFile() && basename(root) === "SKILL.md") paths.push(path)
  } catch (error) {
    if (!isFileSystemError(error)) throw error
    if (error.code !== "ENOENT")
      diagnostics.push({ path: root, message: error.message })
  }
  if (truncated)
    diagnostics.push({
      path: root,
      message: "Skill discovery reached its host traversal safety boundary.",
    })
  return { paths: [...new Set(paths)].sort(), diagnostics }
}

export async function mapSkillFiles<T, R>(
  values: readonly T[],
  load: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_SKILL_LOADS, values.length) },
      async () => {
        for (;;) {
          const index = next++
          const value = values[index]
          if (index >= values.length) return
          results[index] = await load(value as T)
        }
      },
    ),
  )
  return results
}
