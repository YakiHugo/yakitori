import { realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { RebuildOptions } from "@electron/rebuild"

const addonNames = ["fs-ext", "node-pty"]

export function electronAddonRebuildOptions(
  project: string,
  electronVersion: string,
): RebuildOptions {
  const directory = resolve(project)
  return {
    buildPath: directory,
    // The CLI derives this from cwd even with --module-dir. Its walker then
    // queues matching addons in *every* ancestor node_modules up to that root.
    projectRootPath: directory,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    onlyModules: addonNames,
    force: true,
    buildFromSource: true,
  }
}

if (import.meta.main) {
  const [project, version] = process.argv.slice(2)
  if (!project || !version)
    throw new Error("Expected isolated addon project and Electron version.")
  const directory = await realpath(project)
  for (const name of addonNames) {
    const path = await realpath(join(directory, "node_modules", name))
    if (relative(directory, path).startsWith(".."))
      throw new Error(`Staged addon escapes the isolated project: ${name}`)
  }
  const { rebuild } = await import("@electron/rebuild")
  const task = rebuild(electronAddonRebuildOptions(directory, version))
  task.lifecycle.on("modules-found", (names: string[]) => {
    if (
      names.length !== addonNames.length ||
      addonNames.some((name) => !names.includes(name))
    )
      throw new Error(
        `Unexpected isolated addon rebuild set: ${names.join(", ")}`,
      )
    console.log(
      `[electron-addons] Rebuilding ${names.join(", ")} inside ${directory}`,
    )
  })
  await task
}
