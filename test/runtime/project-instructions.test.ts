import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createProjectInstructionsLoader,
  loadProjectInstructions,
} from "../../src/runtime/project-instructions.ts"

describe("project instructions", () => {
  it("loads root-to-working-directory instructions and prefers a local override", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const nested = join(root, "packages", "app")
      await mkdir(join(root, ".git"))
      await mkdir(nested, { recursive: true })
      await writeFile(join(root, "AGENTS.md"), "root rules")
      await writeFile(join(nested, "AGENTS.md"), "ignored local rules")
      await writeFile(join(nested, "AGENTS.override.md"), "override rules")

      const result = await loadProjectInstructions({
        workspaceRoot: root,
        workingDirectory: nested,
        homeDir: join(root, "empty-home"),
      })

      const text = result?.text ?? ""
      expect(text).toContain("root rules")
      expect(text).toContain("override rules")
      expect(text).not.toContain("ignored local rules")
      expect(text.indexOf("root rules")).toBeLessThan(
        text.indexOf("override rules"),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("loads user-level instructions ahead of project documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const home = join(root, "home")
      const workspace = join(root, "workspace")
      await mkdir(home)
      await mkdir(workspace)
      await writeFile(join(home, "AGENTS.override.md"), "user rules")
      await writeFile(join(workspace, "AGENTS.md"), "project rules")

      const result = await loadProjectInstructions({
        workspaceRoot: workspace,
        workingDirectory: workspace,
        homeDir: home,
      })

      const text = result?.text ?? ""
      expect(text).toContain("user rules")
      expect(text).toContain("project rules")
      expect(text.indexOf("user rules")).toBeLessThan(
        text.indexOf("project rules"),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not read instruction files outside the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const workspace = join(root, "workspace")
      await mkdir(workspace)
      await writeFile(join(root, "AGENTS.md"), "parent rules")

      expect(
        await loadProjectInstructions({
          workspaceRoot: workspace,
          workingDirectory: workspace,
          homeDir: join(root, "empty-home"),
        }),
      ).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("caps instruction file content", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      await writeFile(join(root, "AGENTS.md"), "abcdefghij")

      const result = await loadProjectInstructions({
        workingDirectory: root,
        maxBytes: 4,
        homeDir: join(root, "empty-home"),
      })

      expect(result?.text).toContain("abcd")
      expect(result?.text).not.toContain("abcde")
      expect(result?.text).toContain("Project instructions were truncated")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns cached results until an instruction file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const file = join(root, "AGENTS.md")
      await writeFile(file, "v1 rules")
      const loader = createProjectInstructionsLoader()
      const input = {
        workingDirectory: root,
        homeDir: join(root, "empty-home"),
      }

      expect((await loader(input))?.text).toContain("v1 rules")
      expect((await loader(input))?.text).toContain("v1 rules")

      await writeFile(file, "v2 rules")
      // mtime granularity can hide an immediate rewrite; ensure it moves.
      const future = new Date(Date.now() + 5_000)
      await utimes(file, future, future)

      expect((await loader(input))?.text).toContain("v2 rules")
      expect((await loader(input))?.text).not.toContain("v1 rules")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("detects instruction files created after an empty result", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const loader = createProjectInstructionsLoader()
      const input = {
        workingDirectory: root,
        homeDir: join(root, "empty-home"),
      }

      expect(await loader(input)).toBeUndefined()
      await writeFile(join(root, "AGENTS.md"), "late rules")
      expect((await loader(input))?.text).toContain("late rules")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("falls through an empty user override to AGENTS.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const home = join(root, "home")
      const workspace = join(root, "workspace")
      await mkdir(home)
      await mkdir(workspace)
      await writeFile(join(home, "AGENTS.override.md"), "  \n")
      await writeFile(join(home, "AGENTS.md"), "user rules")

      const result = await loadProjectInstructions({
        workingDirectory: workspace,
        homeDir: home,
      })

      expect(result?.text).toContain("user rules")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("serves a cached result without re-reading unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const file = join(root, "AGENTS.md")
      await writeFile(file, "cached rules")
      // Whole-second mtime: Date->utimes->stat loses sub-millisecond digits.
      const fixed = new Date(Math.floor(Date.now() / 1000) * 1000)
      await utimes(file, fixed, fixed)
      const loader = createProjectInstructionsLoader()
      const input = {
        workingDirectory: root,
        homeDir: join(root, "empty-home"),
      }

      expect((await loader(input))?.text).toContain("cached rules")

      // Same size and same mtime: only a cache serves the old text.
      await writeFile(file, "sneaky edits")
      await utimes(file, fixed, fixed)

      expect((await loader(input))?.text).toContain("cached rules")
      expect((await loader(input))?.text).not.toContain("sneaky edits")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
