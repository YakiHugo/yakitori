import { cp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { isMissing } from "./build-cache.ts"

type InstalledPackage = {
  source: string
  name: string
  version: string
  dependencies: InstalledPackage[]
}

export const runtimePackages = [
  "fs-ext",
  "node-pty",
  "sharp",
  "@vscode/ripgrep",
  "pdfjs-dist",
  "@napi-rs/canvas",
]

/** Resolve from the package's own location, including pnpm's isolated layout. */
export async function installedPackages(
  project: string,
  names: string[],
): Promise<InstalledPackage[]> {
  const seen = new Map<string, InstalledPackage>()
  async function find(
    name: string,
    parent: string,
    optional = false,
  ): Promise<InstalledPackage | undefined> {
    const candidates =
      createRequire(join(parent, "package.json")).resolve.paths(
        `${name}/package.json`,
      ) ?? []
    let source: string | undefined
    for (const candidate of candidates) {
      source = await realpath(join(candidate, name)).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (source !== undefined) break
    }
    if (source === undefined) {
      if (optional) return undefined
      throw new Error(`Cannot stage required package ${name} from ${parent}.`)
    }
    const existing = seen.get(source)
    if (existing) return existing
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    ) as {
      name: string
      version: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const pkg: InstalledPackage = {
      source,
      name: manifest.name,
      version: manifest.version,
      dependencies: [],
    }
    seen.set(source, pkg)
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies)) {
      const installed = await find(
        dependency,
        source,
        dependency in (manifest.optionalDependencies ?? {}),
      )
      if (installed) pkg.dependencies.push(installed)
    }
    return pkg
  }
  const roots: InstalledPackage[] = []
  for (const name of names) {
    const pkg = await find(name, project)
    if (pkg) roots.push(pkg)
  }
  return roots
}

export function packageInputs(
  packages: InstalledPackage[],
  excludeNativeBuild = false,
): { path: string; exclude: (name: string) => boolean }[] {
  const seen = new Set<string>()
  const paths: string[] = []
  function visit(pkg: InstalledPackage): void {
    if (seen.has(pkg.source)) return
    seen.add(pkg.source)
    paths.push(pkg.source)
    pkg.dependencies.forEach(visit)
  }
  packages.forEach(visit)
  return paths.sort().map((path) => ({
    path,
    exclude: (name) =>
      /^(node_modules|\.git)(\/|$)/.test(name) ||
      (excludeNativeBuild && /^build(\/|$)/.test(name)),
  }))
}

/** Copies files, never hardlinks: rebuilding staged addons cannot mutate pnpm's store. */
export async function stagePackages(
  destination: string,
  packages: InstalledPackage[],
): Promise<void> {
  const modules = join(destination, "node_modules")
  await rm(modules, { recursive: true, force: true })
  const roots = new Map(packages.map((pkg) => [pkg.name, pkg.source]))
  async function copy(
    pkg: InstalledPackage,
    target: string,
    ancestors: Set<string>,
  ): Promise<void> {
    if (ancestors.has(pkg.source))
      throw new Error(`Cyclic dependency while staging ${pkg.name}.`)
    await mkdir(dirname(target), { recursive: true })
    await cp(pkg.source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const suffix = path.slice(pkg.source.length + 1)
        // Keep build/ here: Electron's compiled addons are runtime files.
        return !/^(node_modules|\.git)(\/|$)/.test(suffix)
      },
    })
    const nextAncestors = new Set([...ancestors, pkg.source])
    for (const dependency of pkg.dependencies) {
      if (roots.get(dependency.name) === dependency.source) continue
      await copy(
        dependency,
        join(target, "node_modules", dependency.name),
        nextAncestors,
      )
    }
  }
  for (const pkg of packages) {
    await copy(pkg, join(modules, pkg.name), new Set())
  }
}
