import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, loadConfigFromFile } from "vite"
import { expect, test } from "vitest"

const projectRoot = fileURLToPath(new URL("../../", import.meta.url))
const configFile = join(projectRoot, "vite.config.ts")
const initialDependency = fileURLToPath(import.meta.resolve("clsx"))
const lazyDependency = fileURLToPath(import.meta.resolve("smol-toml"))

test.each([
  "production",
  "desktop",
])("%s builds preserve vendor bytes, lazy imports, and hidden source maps", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-build-artifact-"))
  const entry = join(root, "main.js")
  const outDir = join(root, "dist")

  try {
    const compile = async (label: string) => {
      await writeFile(
        entry,
        `import clsx from ${JSON.stringify(initialDependency)}
globalThis.buildFixture = {
  label: clsx(${JSON.stringify(label)}, globalThis.fixtureFlag && "enabled"),
  load: () => import(${JSON.stringify(lazyDependency)}),
}
`,
      )
      const loaded = await loadConfigFromFile(
        { command: "build", mode },
        configFile,
        projectRoot,
        "silent",
      )
      if (!loaded) throw new Error("Project Vite config was not loaded")

      const config = loaded.config
      const result = await build({
        ...config,
        configFile: false,
        mode,
        root,
        publicDir: false,
        logLevel: "silent",
        build: {
          ...config.build,
          outDir,
          // Keep production output options; replace only application inputs.
          ...(config.build?.lib ? { lib: { ...config.build.lib, entry } } : {}),
          rolldownOptions: {
            ...config.build?.rolldownOptions,
            input: entry,
          },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const chunks = outputs
        .flatMap((output) => {
          if (!("output" in output)) {
            throw new Error("Expected a completed Vite build")
          }
          return output.output
        })
        .filter((item) => item.type === "chunk")
      const main = chunks.find((chunk) => chunk.isEntry)
      const vendor = chunks.find((chunk) =>
        Object.keys(chunk.modules).includes(initialDependency),
      )
      const lazy = chunks.find((chunk) =>
        Object.keys(chunk.modules).includes(lazyDependency),
      )
      if (!main || !vendor || !lazy) {
        throw new Error(
          "Fixture entry and bundled dependencies must be emitted",
        )
      }

      expect(main.code).toContain(label)
      expect(vendor.isEntry).toBe(false)
      expect(vendor.fileName).toMatch(/(?:^|\/)vendor[~.-]/)

      // Follow static imports to distinguish a real lazy boundary from a
      // separate chunk that is nevertheless fetched with the entry.
      const initialFiles = new Set<string>()
      const pending = [main.fileName]
      while (pending.length > 0) {
        const fileName = pending.pop()
        if (!fileName || initialFiles.has(fileName)) continue
        initialFiles.add(fileName)
        const chunk = chunks.find(
          (candidate) => candidate.fileName === fileName,
        )
        if (chunk) pending.push(...chunk.imports)
      }
      expect(initialFiles.has(vendor.fileName)).toBe(true)
      expect(initialFiles.has(lazy.fileName)).toBe(false)
      expect(
        chunks
          .filter((chunk) => initialFiles.has(chunk.fileName))
          .flatMap((chunk) => chunk.dynamicImports),
      ).toContain(lazy.fileName)

      for (const chunk of chunks) {
        const code = await readFile(join(outDir, chunk.fileName), "utf8")
        expect(code).not.toContain("sourceMappingURL")
        const sourceMap: unknown = JSON.parse(
          await readFile(join(outDir, `${chunk.fileName}.map`), "utf8"),
        )
        expect(sourceMap).toMatchObject({
          version: 3,
          sources: expect.any(Array),
          mappings: expect.any(String),
        })
        expect(sourceMap).toHaveProperty("sources.0")
        expect(sourceMap).not.toHaveProperty("mappings", "")
      }

      return {
        mainCode: main.code,
        vendorName: vendor.fileName,
        vendorBytes: await readFile(join(outDir, vendor.fileName)),
      }
    }

    const before = await compile("application-before-edit")
    const after = await compile("application-after-edit")
    expect(after.mainCode).not.toBe(before.mainCode)
    expect(after.vendorName).toBe(before.vendorName)
    expect(after.vendorBytes).toEqual(before.vendorBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
