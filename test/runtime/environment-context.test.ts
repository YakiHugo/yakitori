import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildEnvironmentContext } from "../../src/runtime/environment-context.ts"

describe("environment context", () => {
  it("renders the environment block for a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yakitori-env-"))
    try {
      const context = buildEnvironmentContext({
        workingDirectory: dir,
        now: new Date(2026, 6, 31, 12, 0, 0),
      })

      expect(context.split("\n")).toEqual([
        "<environment>",
        `Working directory: ${dir}`,
        "Is directory a git repo: no",
        `Platform: ${process.platform}`,
        expect.stringMatching(/^OS version: .+/),
        "Today's date: 2026-07-31",
        "</environment>",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("detects a git repository via the .git entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yakitori-env-"))
    try {
      await mkdir(join(dir, ".git"))

      const context = buildEnvironmentContext({
        workingDirectory: dir,
        now: new Date(2026, 0, 5),
      })

      expect(context).toContain("Is directory a git repo: yes")
      expect(context).toContain("Today's date: 2026-01-05")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
