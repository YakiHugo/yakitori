import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { resolveWorkspaceDirectory } from "./application.ts"

export type ProjectRegistry = {
  list(): Promise<string[]>
  add(path: string): Promise<string[]>
}

// The Codex GUI parallel: a projects table with per-project entries; threads
// record their own cwd and listings group or filter by it.
export function createProjectRegistry(options: {
  readonly registryPath?: string
  readonly defaultProject: string
}): ProjectRegistry {
  const registryPath =
    options.registryPath ??
    join(
      process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori"),
      "projects.json",
    )
  let cached: string[] | undefined

  async function list(): Promise<string[]> {
    cached ??= await readProjects(registryPath, options.defaultProject)
    return [...cached]
  }

  async function add(path: string): Promise<string[]> {
    const resolved = await resolveWorkspaceDirectory(path)
    const projects = await list()
    if (projects.includes(resolved)) return projects
    cached = [...projects, resolved]
    await writeProjects(registryPath, cached)
    return [...cached]
  }

  return { list, add }
}

async function readProjects(
  registryPath: string,
  defaultProject: string,
): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return [defaultProject]
    if (!("projects" in parsed) || !Array.isArray(parsed.projects)) {
      return [defaultProject]
    }
    const projects = parsed.projects.filter(
      (entry): entry is string => typeof entry === "string",
    )
    return projects.includes(defaultProject)
      ? projects
      : [defaultProject, ...projects]
  } catch {
    return [defaultProject]
  }
}

async function writeProjects(
  registryPath: string,
  projects: readonly string[],
): Promise<void> {
  try {
    await mkdir(dirname(registryPath), { recursive: true })
    await writeFile(
      registryPath,
      `${JSON.stringify({ projects }, null, 2)}\n`,
      "utf8",
    )
  } catch (error) {
    console.error("Failed to persist the project registry.", error)
  }
}
