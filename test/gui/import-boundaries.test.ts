import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Value imports from these paths pull node builtins (node:crypto and friends)
// into the browser bundle and blank the GUI at runtime. Type-only imports are
// erased at build time and stay legal. The allowed kernel surfaces are
// dependency-free event types. Pure core modules own input, excerpt and asset
// validation/projection. The server asset-url module
// is a pure access-address contract shared with the renderer; ids.ts uses
// browser-safe globalThis.crypto.
const forbiddenValueImportFrom = [
  /kernel\/index\.ts/,
  /kernel\/(?!(events|ids|input-context|input-content|user-interaction)\.ts)[^"']+/,
  /core\/(?!(asset-types|conversation|input-context|user-input|thread-search|goal)\.ts)[^"']+/,
  /runtime\//,
  /server\/(?!(asset-url)\.ts)[^"']+/,
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
  it("keeps static import-from statements within the allowed GUI module boundaries", () => {
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
