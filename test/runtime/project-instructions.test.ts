import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadProjectInstructions } from "../../src/runtime/project-instructions.ts"

describe("project instructions", () => {
  it("loads only the working directory file and prefers the local override", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-instructions-"))
    try {
      const nested = join(root, "packages", "app")
      await mkdir(join(root, ".git"))
      await mkdir(nested, { recursive: true })
      await writeFile(join(root, "AGENTS.md"), "root rules")
      await writeFile(join(nested, "AGENTS.md"), "ignored local rules")
      await writeFile(join(nested, "AGENTS.override.md"), "override rules")

      const result = await loadProjectInstructions({
        workingDirectory: nested,
      })

      expect(result?.files).toEqual([join(nested, "AGENTS.override.md")])
      const text = result?.message.content[0]?.text ?? ""
      expect(text).toContain("override rules")
      expect(text).not.toContain("root rules")
      expect(text).not.toContain("ignored local rules")
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
        await loadProjectInstructions({ workingDirectory: workspace }),
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
      })

      expect(result?.truncated).toBe(true)
      expect(result?.message.content[0]?.text).toContain("abcd")
      expect(result?.message.content[0]?.text).not.toContain("abcde")
      expect(result?.message.content[0]?.text).toContain(
        "Project instructions were truncated",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
