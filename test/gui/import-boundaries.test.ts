import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Value imports from these paths pull node builtins (node:crypto and friends)
// into the browser bundle and blank the GUI at runtime. Type-only imports are
// erased at build time and stay legal. kernel/events.ts and kernel/ids.ts are
// the allowed value-import surfaces: both are dependency-free and ids.ts uses
// the browser-safe globalThis.crypto.
const forbiddenValueImportFrom = [
  /kernel\/index\.ts/,
  /kernel\/(?!(events|ids)\.ts)[^"']+/,
  /runtime\//,
  /server\//,
]

const importStatement = /import\s+(?!type\b)([\s\S]*?)\sfrom\s["']([^"']+)["']/g

function guiSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return guiSourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe("GUI import boundaries", () => {
  it("keeps node-only modules out of the browser bundle", () => {
    const guiRoot = join(__dirname, "..", "..", "src", "gui")
    const violations: string[] = []
    for (const file of guiSourceFiles(guiRoot)) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(importStatement)) {
        const specifier = match[2]
        if (specifier === undefined) continue
        if (
          forbiddenValueImportFrom.some((pattern) => pattern.test(specifier))
        ) {
          violations.push(`${file}: value import from ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
