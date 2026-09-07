import type { Dirent } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, sep } from "node:path"

export const SKILLS_CATALOG_MAX_BYTES = 20 * 1024
const SKILL_DOCUMENT_MAX_BYTES = 256 * 1024

export type SkillMetadata = Readonly<{
  name: string
  description: string
  path: string
  scope: "user" | "repo"
}>

export type SkillsCatalog = Readonly<{
  skills: readonly SkillMetadata[]
  text: string
  truncated: boolean
}>

export async function loadSkillsCatalog(input: {
  workspaceRoot: string
  workingDirectory: string
  homeDir?: string
  maxBytes?: number
}): Promise<SkillsCatalog | undefined> {
  const workspaceRoot = await realpath(input.workspaceRoot)
  const workingDirectory = await realpath(input.workingDirectory)
  requireInside(workspaceRoot, workingDirectory)
  const roots: Array<Readonly<{ path: string; scope: "user" | "repo" }>> = [
    {
      path: join(input.homeDir ?? defaultHomeDir(), "skills"),
      scope: "user",
    },
  ]
  for (const directory of directoriesFromRoot(
    workspaceRoot,
    workingDirectory,
  )) {
    roots.push({ path: join(directory, ".agents", "skills"), scope: "repo" })
  }

  const byPath = new Map<string, SkillMetadata>()
  for (const root of roots) {
    for (const path of await findSkillDocuments(root.path)) {
      const skill = await readSkillMetadata(path, root.scope)
      if (skill !== undefined) byPath.set(skill.path, skill)
    }
  }
  const skills = [...byPath.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  )
  if (skills.length === 0) return undefined

  const maxBytes = input.maxBytes ?? SKILLS_CATALOG_MAX_BYTES
  const lines = [
    "## Skills",
    "A skill is a focused workflow stored in a SKILL.md file. Read a skill when the user names it or when its description directly matches the task.",
  ]
  let used = Buffer.byteLength(`${lines.join("\n")}\n`, "utf8")
  let truncated = false
  const visible: SkillMetadata[] = []
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description} (file: ${skill.path}; scope: ${skill.scope})`
    const bytes = Buffer.byteLength(`${line}\n`, "utf8")
    if (used + bytes > maxBytes) {
      truncated = true
      continue
    }
    lines.push(line)
    visible.push(skill)
    used += bytes
  }
  if (truncated)
    lines.push("- Additional skills were omitted by the catalog byte budget.")
  return { skills: visible, text: lines.join("\n"), truncated }
}

async function findSkillDocuments(root: string): Promise<readonly string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
      .map((entry) => realpath(join(entry.parentPath, entry.name))),
  )
  const canonicalRoot = await realpath(root)
  for (const path of paths) requireInside(canonicalRoot, path)
  return paths
}

async function readSkillMetadata(
  path: string,
  scope: SkillMetadata["scope"],
): Promise<SkillMetadata | undefined> {
  const info = await stat(path)
  if (info.size > SKILL_DOCUMENT_MAX_BYTES) return undefined
  const file = await open(path, "r")
  try {
    const buffer = Buffer.alloc(Math.min(info.size, 32 * 1024))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text)
    if (match === null) return undefined
    const fields = parseFrontmatter(match[1] ?? "")
    if (!fields.name || !fields.description) return undefined
    return { name: fields.name, description: fields.description, path, scope }
  } finally {
    await file.close()
  }
}

function parseFrontmatter(source: string): Readonly<Record<string, string>> {
  const lines = source.split("\n")
  const fields: Record<string, string> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(lines[index] ?? "")
    if (match === null) continue
    const key = match[1]
    if (key === undefined) continue
    const raw = match[2] ?? ""
    if (raw === "|" || raw === ">" || /^[|>][+-]$/.test(raw)) {
      const block: string[] = []
      while (index + 1 < lines.length) {
        const line = lines[index + 1] ?? ""
        if (line !== "" && !/^\s/.test(line)) break
        index += 1
        block.push(line)
      }
      const indentation = block
        .filter((line) => line.trim() !== "")
        .map((line) => /^\s*/.exec(line)?.[0].length ?? 0)
      const width = indentation.length === 0 ? 0 : Math.min(...indentation)
      const value = block.map((line) => line.slice(width))
      fields[key] = (raw.startsWith(">") ? value.join(" ") : value.join("\n"))
        .replace(/\s+/g, " ")
        .trim()
      continue
    }
    const value = parseFrontmatterScalar(raw)
    if (value !== undefined) fields[key] = value
  }
  return fields
}

function parseFrontmatterScalar(raw: string): string | undefined {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === "string" ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'")) {
    return value.endsWith("'")
      ? value.slice(1, -1).replaceAll("''", "'")
      : undefined
  }
  return value.replace(/\s+#.*$/, "").trim()
}

function directoriesFromRoot(
  root: string,
  directory: string,
): readonly string[] {
  const directories = [directory]
  let current = directory
  while (current !== root) {
    current = dirname(current)
    directories.push(current)
  }
  return directories.reverse()
}

function requireInside(root: string, path: string): void {
  const child = relative(root, path)
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== "..")) return
  throw new Error(`Skill path escapes its configured root: ${path}`)
}

function defaultHomeDir(): string {
  return process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori")
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
