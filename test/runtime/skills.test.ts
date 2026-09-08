import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createSkillsLoader,
  loadExplicitSkillInstructions,
  loadSkillsCatalog,
  renderSkillsCatalog,
} from "../../src/runtime/skills.ts"

it.each([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
])("ignores shell variable %s in plain and linked mentions", async (name) => {
  const warnings: string[] = []
  const text = `Check $${name}, $${name.toLowerCase()} and [$${name}](/missing/SKILL.md).`
  expect(
    await loadExplicitSkillInstructions(
      text,
      { skills: [], diagnostics: [] },
      (warning) => warnings.push(warning),
    ),
  ).toBeUndefined()
  expect(warnings).toEqual([])
})

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

it("keeps valid YAML, large bodies, linked skills and discovery diagnostics independent of catalog budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skills-contract-"))
  try {
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const skillRoot = join(workspace, ".agents", "skills")
    await mkdir(skillRoot, { recursive: true })
    const shared = join(root, "shared")
    await mkdir(shared)
    await writeFile(
      join(shared, "SKILL.md"),
      '---\nname: shared\ndescription: "Review code" # valid YAML\n---\n' +
        "x".repeat(300_000),
    )
    await symlink(shared, join(skillRoot, "linked"))
    await symlink(skillRoot, join(shared, "cycle"))
    await mkdir(join(skillRoot, "bad"))
    await writeFile(
      join(skillRoot, "bad", "SKILL.md"),
      "---\nname: [broken\n---\n",
    )
    const loader = createSkillsLoader()
    const input = { workingDirectory: workspace, homeDir: home }
    const snapshot = await loader(input)
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["shared"])
    expect(snapshot.diagnostics).toHaveLength(1)
    const tiny = renderSkillsCatalog(snapshot, 1)
    expect(Buffer.byteLength(tiny?.text ?? "")).toBeLessThanOrEqual(1)
    expect(tiny?.skills).toHaveLength(1)
    expect(await loadExplicitSkillInstructions("$shared", snapshot)).toContain(
      "host injection safety boundary",
    )
    await writeFile(
      join(shared, "SKILL.md"),
      "---\ndescription: Updated description\n---\nUPDATED BODY",
    )
    expect((await loader(input)).skills[0]).toMatchObject({
      name: "shared",
      description: "Updated description",
    })
    await rm(join(skillRoot, "linked"))
    expect((await loader(input)).skills).toHaveLength(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("requires path disambiguation and honors configuration changes without restarting discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-selection-"))
  try {
    const paths: string[] = []
    for (const directory of ["one", "two"]) {
      const dir = join(root, directory)
      await mkdir(dir)
      const path = join(dir, "SKILL.md")
      paths.push(path)
      await writeFile(
        path,
        `---\nname: review\ndescription: Review code\n---\nBODY ${directory}`,
      )
    }
    const loader = createSkillsLoader()
    const input = {
      workingDirectory: root,
      homeDir: join(root, "empty"),
      configuration: { paths },
    }
    const snapshot = await loader(input)
    expect(await loadExplicitSkillInstructions("$review", snapshot)).toContain(
      "ambiguous",
    )
    const selected = await loadExplicitSkillInstructions(
      `[$review](${snapshot.skills[0]?.path})`,
      snapshot,
    )
    expect(selected).toContain("BODY one")
    expect(selected).not.toContain("BODY two")
    const disabled = await loader({
      ...input,
      configuration: { paths, config: [{ name: "review", enabled: false }] },
    })
    expect(renderSkillsCatalog(disabled)).toBeUndefined()
    expect(await loadExplicitSkillInstructions("$review", disabled)).toContain(
      "disabled",
    )
    await rm(paths[0] ?? "")
    expect(
      await loadExplicitSkillInstructions(
        `[$review](${snapshot.skills[0]?.path})`,
        snapshot,
      ),
    ).toContain("Failed to load")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
