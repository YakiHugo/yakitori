import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProjectRegistry } from "../../src/server/project-registry.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

describe("project registry", () => {
  it("always includes the default project", async () => {
    await withRegistry(async ({ registry, defaultProject }) => {
      expect(await registry.list()).toEqual([defaultProject])
    })
  })

  it("prepends the default project to a stored list that lacks it", async () => {
    await withRegistry(async ({ registryPath, defaultProject }) => {
      await writeFile(
        registryPath,
        JSON.stringify({ projects: ["/somewhere/else"] }),
      )
      const registry = createProjectRegistry({ registryPath, defaultProject })
      expect(await registry.list()).toEqual([defaultProject, "/somewhere/else"])
    })
  })

  it("starts from the default project when the file is corrupt", async () => {
    await withRegistry(async ({ registryPath, defaultProject }) => {
      await writeFile(registryPath, "{not json")
      const registry = createProjectRegistry({ registryPath, defaultProject })
      expect(await registry.list()).toEqual([defaultProject])
    })
  })

  it("adds resolved directories, dedupes, and persists across instances", async () => {
    await withRegistry(async ({ registryPath, defaultProject, rootDir }) => {
      const added = join(rootDir, "added")
      await mkdir(added)
      const registry = createProjectRegistry({ registryPath, defaultProject })

      const resolved = await realpath(added)
      expect(await registry.add(added)).toEqual([defaultProject, resolved])
      expect(await registry.add(added)).toEqual([defaultProject, resolved])
      expect(await registry.list()).toEqual([defaultProject, resolved])

      const reopened = createProjectRegistry({ registryPath, defaultProject })
      expect(await reopened.list()).toEqual([defaultProject, resolved])
    })
  })

  it("rejects nonexistent paths and files", async () => {
    await withRegistry(async ({ registry, rootDir, defaultProject }) => {
      await expect(registry.add(join(rootDir, "missing"))).rejects.toThrow(
        "Workspace path does not exist",
      )
      const file = join(rootDir, "file.txt")
      await writeFile(file, "x")
      await expect(registry.add(file)).rejects.toThrow(
        "Workspace path is not a directory",
      )
      expect(await registry.list()).toEqual([defaultProject])
    })
  })
})

async function withRegistry(
  run: (context: {
    readonly registryPath: string
    readonly defaultProject: string
    readonly rootDir: string
    readonly registry: ReturnType<typeof createProjectRegistry>
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-projects-"))
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }))
  const defaultProject = join(rootDir, "default")
  await mkdir(defaultProject)
  const registryPath = join(rootDir, "projects.json")
  const registry = createProjectRegistry({
    registryPath,
    defaultProject: await realpath(defaultProject),
  })
  await run({
    registryPath,
    defaultProject: await realpath(defaultProject),
    rootDir,
    registry,
  })
}
