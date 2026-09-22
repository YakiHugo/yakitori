import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createSkillsLoader,
  getSkillDependencyDiagnostics,
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
        userHomeDir: home,
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
    const input = {
      workingDirectory: workspace,
      homeDir: home,
      userHomeDir: home,
    }
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
      userHomeDir: join(root, "empty"),
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

it("discovers and injects shared user skills outside the project and app home", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-shared-skills-"))
  try {
    const userHomeDir = join(root, "user")
    const directory = join(userHomeDir, ".agents", "skills", "review")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nInspect the diff before acting.\n",
    )
    const snapshot = await createSkillsLoader()({
      workingDirectory: root,
      homeDir: join(root, "app"),
      userHomeDir,
    })
    expect(snapshot.skills).toHaveLength(1)
    expect(snapshot.skills[0]).toMatchObject({ name: "review", scope: "user" })
    const injected = await loadExplicitSkillInstructions(
      `Please review [$review](${snapshot.skills[0]?.path})`,
      snapshot,
    )
    expect(injected).toContain("Inspect the diff before acting.")
    expect(renderSkillsCatalog(snapshot)?.text).not.toContain(
      "Inspect the diff before acting.",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps explicit-only skills selectable and refreshes policy and dependencies together", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-policy-"))
  try {
    const skill = join(root, ".agents", "skills", "research")
    const metadataPath = join(skill, "agents", "openai.yaml")
    await mkdir(join(skill, "agents"), { recursive: true })
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: research\ndescription: Research sources\n---\nRESEARCH BODY",
    )
    await writeFile(
      metadataPath,
      `policy:
  allow_implicit_invocation: false
dependencies:
  tools:
    - type: mcp
      value: docs
      description: Official documentation
      transport: streamable_http
      url: https://docs.example/mcp
      oauth:
        callbackPort: 8765
    - type: cli
      value: node
      command: node
`,
    )
    const load = createSkillsLoader()
    const input = {
      workingDirectory: root,
      homeDir: join(root, "empty"),
      userHomeDir: join(root, "empty"),
    }
    const snapshot = await load(input)
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.skills[0]).toMatchObject({
      policy: { allowImplicitInvocation: false },
      dependencies: {
        tools: [
          {
            type: "mcp",
            value: "docs",
            transport: "streamable_http",
            url: "https://docs.example/mcp",
            oauthCallbackPort: 8765,
          },
          { type: "cli", value: "node", command: "node" },
        ],
      },
    })
    expect(renderSkillsCatalog(snapshot)).toBeUndefined()
    const warnings: string[] = []
    const instructions = await loadExplicitSkillInstructions(
      "$research",
      snapshot,
      (warning) => warnings.push(warning),
      { mcpServers: [] },
    )
    expect(instructions).toContain("RESEARCH BODY")
    expect(instructions).toContain("requires MCP server docs")
    expect(instructions).toContain("Ask the user to configure or enable")
    expect(warnings).toHaveLength(1)
    expect(getSkillDependencyDiagnostics(snapshot.skills, [])).toMatchObject([
      {
        skillName: "research",
        status: "missing",
        dependency: { value: "docs" },
      },
    ])
    expect(
      getSkillDependencyDiagnostics(snapshot.skills, [
        { name: "docs", available: false, reason: "disabled" },
      ]),
    ).toMatchObject([
      { status: "unavailable", message: expect.stringContaining("disabled") },
    ])
    expect(
      getSkillDependencyDiagnostics(snapshot.skills, [
        { name: "renamed", url: "https://docs.example/mcp", available: true },
      ]),
    ).toEqual([])
    await writeFile(
      metadataPath,
      "policy:\n  allow_implicit_invocation: true\n",
    )
    const refreshed = await load(input)
    expect(refreshed.skills[0]?.dependencies).toBeUndefined()
    expect(renderSkillsCatalog(refreshed)?.text).toContain("Research sources")
    expect(snapshot.skills[0]?.policy?.allowImplicitInvocation).toBe(false)
    await rm(metadataPath)
    expect((await load(input)).skills[0]?.policy).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("reports invalid optional metadata without hiding the workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-invalid-policy-"))
  try {
    const skill = join(root, "skill")
    await mkdir(join(skill, "agents"), { recursive: true })
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nREVIEW BODY",
    )
    const metadata = join(skill, "agents", "openai.yaml")
    const input = {
      workingDirectory: root,
      homeDir: join(root, "empty"),
      userHomeDir: join(root, "empty"),
      configuration: { paths: [skill] },
    }
    const load = createSkillsLoader()
    for (const invalid of [
      "policy:\n  allow_implicit_invocation: nope\n",
      "dependencies:\n  tools: broken\n",
      "dependencies:\n  tools:\n    - type: mcp\n      value: []\n",
      "[broken",
      "x".repeat(33_000),
    ]) {
      await writeFile(metadata, invalid)
      const snapshot = await load(input)
      expect(snapshot.skills).toHaveLength(1)
      expect(snapshot.diagnostics).toHaveLength(1)
      expect(snapshot.diagnostics[0]?.path).toBe(await realpath(metadata))
      expect(renderSkillsCatalog(snapshot)?.text).toContain("Review changes")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("skips hidden descendants while retaining explicit hidden roots and linked visible skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-hidden-"))
  try {
    const skillsRoot = join(root, ".agents", "skills")
    const hidden = join(skillsRoot, ".hidden")
    const visible = join(skillsRoot, "visible")
    await mkdir(hidden, { recursive: true })
    await mkdir(visible)
    await writeFile(
      join(hidden, "SKILL.md"),
      "---\nname: hidden\ndescription: Hidden workflow\n---\n",
    )
    await writeFile(
      join(visible, "SKILL.md"),
      "---\nname: visible\ndescription: Visible workflow\n---\n",
    )
    await symlink(skillsRoot, join(visible, "cycle"))
    const load = createSkillsLoader()
    const input = {
      workingDirectory: root,
      homeDir: join(root, "empty"),
      userHomeDir: join(root, "empty"),
    }
    expect((await load(input)).skills.map((skill) => skill.name)).toEqual([
      "visible",
    ])
    expect(
      (await load({ ...input, configuration: { paths: [hidden] } })).skills.map(
        (skill) => skill.name,
      ),
    ).toEqual(["hidden", "visible"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("bounds each root independently so a large repo cannot starve user skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-root-budget-"))
  try {
    const repoSkills = join(root, ".agents", "skills")
    const userHome = join(root, "user")
    const userSkill = join(userHome, ".agents", "skills", "review")
    await mkdir(repoSkills, { recursive: true })
    await mkdir(userSkill, { recursive: true })
    // Ordinary unrelated files also consume enumeration work. This exercises
    // the real filesystem boundary without timing or syscall-count assertions.
    for (let start = 0; start < 20_001; start += 256)
      await Promise.all(
        Array.from({ length: Math.min(256, 20_001 - start) }, (_, index) =>
          writeFile(join(repoSkills, `asset-${start + index}`), ""),
        ),
      )
    await writeFile(
      join(userSkill, "SKILL.md"),
      "---\nname: review\ndescription: User review\n---\n",
    )
    const snapshot = await createSkillsLoader()({
      workingDirectory: root,
      homeDir: join(root, "empty"),
      userHomeDir: userHome,
    })
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["review"])
    expect(snapshot.diagnostics).toEqual([
      {
        path: await realpath(repoSkills),
        message: "Skill discovery reached its host traversal safety boundary.",
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
