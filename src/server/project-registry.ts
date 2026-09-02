import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { resolveWorkspaceDirectory } from "./application.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"

export type ProjectRegistry = {
  list(): Promise<string[]>
  add(path: string): Promise<string[]>
}

// The Codex GUI parallel: a projects table with per-project entries; threads
// record their own cwd and listings group or filter by it.
export function createProjectRegistry(options: {
  readonly registryPath?: string
  readonly defaultProject: string
  readonly reportOperationalFailure?: OperationalFailureReporter
}): ProjectRegistry {
  const registryPath =
    options.registryPath ??
    join(
      process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori"),
      "projects.json",
    )
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  let cached: string[] | undefined

  async function list(): Promise<string[]> {
    cached ??= await readProjects(
      registryPath,
      options.defaultProject,
      reporter,
    )
    return [...cached]
  }

  async function add(path: string): Promise<string[]> {
    const resolved = await resolveWorkspaceDirectory(path)
    const projects = await list()
    if (projects.includes(resolved)) return projects
    cached = [...projects, resolved]
    await writeProjects(registryPath, cached, reporter)
    return [...cached]
  }

  return { list, add }
}

async function readProjects(
  registryPath: string,
  defaultProject: string,
  reporter: OperationalFailureReporter,
): Promise<string[]> {
  let contents: string
  try {
    contents = await readFile(registryPath, "utf8")
  } catch (error) {
    if (isFileNotFound(error)) return [defaultProject]
    reportOperationalFailure(reporter, {
      component: "project-registry",
      operation: "read",
      cause: error,
    })
    return [defaultProject]
  }

  try {
    const parsed: unknown = JSON.parse(contents)
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Project registry must contain an object.")
    }
    if (!("projects" in parsed) || !Array.isArray(parsed.projects)) {
      throw new Error("Project registry must contain a projects array.")
    }
    const projects = parsed.projects
    if (
      !projects.every(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.length > 0 &&
          isAbsolute(entry) &&
          normalize(entry) === entry,
      ) ||
      new Set(projects).size !== projects.length
    ) {
      throw new Error(
        "Project registry entries must be unique normalized absolute paths.",
      )
    }
    return projects.includes(defaultProject)
      ? projects
      : [defaultProject, ...projects]
  } catch (error) {
    reportOperationalFailure(reporter, {
      component: "project-registry",
      operation: "parse",
      cause: error,
    })
    return [defaultProject]
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

async function writeProjects(
  registryPath: string,
  projects: readonly string[],
  reporter: OperationalFailureReporter,
): Promise<void> {
  try {
    await mkdir(dirname(registryPath), { recursive: true })
    await writeFile(
      registryPath,
      `${JSON.stringify({ projects }, null, 2)}\n`,
      "utf8",
    )
  } catch (error) {
    reportOperationalFailure(reporter, {
      component: "project-registry",
      operation: "persist",
      cause: error,
    })
  }
}
