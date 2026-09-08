import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadSkillsCatalog } from "../../src/runtime/skills.ts"

describe("skills catalog", () => {
  it("discovers user and nested repo skills without loading their bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-skills-"))
    try {
      const home = join(root, "home")
      const workspace = join(root, "workspace")
      const nested = join(workspace, "package")
      await mkdir(join(home, "skills", "review"), { recursive: true })
      await mkdir(join(nested, ".agents", "skills", "deploy"), {
        recursive: true,
      })
      await writeFile(
        join(home, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review changes carefully.\n---\nSECRET BODY\n",
      )
      await writeFile(
        join(nested, ".agents", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: >\n  Deploy the current\n  service safely.\n---\nLONG BODY\n",
      )

      const catalog = await loadSkillsCatalog({
        workspaceRoot: workspace,
        workingDirectory: nested,
        homeDir: home,
      })

      expect(catalog?.skills.map((skill) => [skill.name, skill.scope])).toEqual(
        [
          ["deploy", "repo"],
          ["review", "user"],
        ],
      )
      expect(catalog?.text).toContain("Review changes carefully.")
      expect(catalog?.text).toContain("Deploy the current service safely.")
      expect(catalog?.text).not.toContain("SECRET BODY")
      expect(catalog?.text).not.toContain("LONG BODY")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
