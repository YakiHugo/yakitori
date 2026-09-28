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
import { afterEach, expect, it, vi } from "vitest"
import { createSqliteProjectStore } from "../../../src/server/sqlite-project-store.ts"
import { createUserConfigStore } from "../../../src/server/user-config.ts"
import type { WorkspaceReadResponse } from "../../../src/server/workspace.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  okResult,
  openTestConnection,
} from "./testkit.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

it("reads only skills discovered in the current session, using bounded pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-preview-"))
  roots.push(root)
  const skills = join(root, "skills")
  await mkdir(skills)
  const path = join(skills, "SKILL.md")
  await writeFile(path, "# Skill\nFirst detail\nLast detail")
  const other = join(root, "other")
  await mkdir(other)
  await writeFile(join(other, "SKILL.md"), "secret")
  const listSkills = vi.fn(async (input: unknown) =>
    okResult({
      skills:
        (input as { sessionId: string }).sessionId === "allowed"
          ? [
              {
                name: "Review",
                path,
                description: "Review",
                scope: "user" as const,
              },
            ]
          : [],
    }),
  )
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers({ listSkills }),
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  const first = await connection.sendRequest("session/skill/read", {
    sessionId: "allowed",
    path,
    limit: 2,
  })
  expect(first).toHaveProperty("result", {
    path: "SKILL.md",
    content: "# Skill\nFirst detail",
    offset: 1,
    nextOffset: 3,
    truncated: true,
    binary: false,
  } satisfies WorkspaceReadResponse)
  const remainder = await connection.sendRequest("session/skill/read", {
    sessionId: "allowed",
    path,
    offset: 3,
  })
  expect(remainder).toMatchObject({
    result: { content: "Last detail", truncated: false },
  })
  expect(
    await connection.sendRequest("session/skill/read", {
      sessionId: "denied",
      path,
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  expect(
    await connection.sendRequest("session/skill/read", {
      sessionId: "allowed",
      path: join(other, "SKILL.md"),
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  expect(
    await connection.sendRequest("session/skill/read", {
      sessionId: "allowed",
      path: `${other}/../skills/SKILL.md`,
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  expect(listSkills).toHaveBeenCalled()
})

it("rejects a skill symlink escaping its directory through workspace path validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-skill-symlink-"))
  roots.push(root)
  const dir = join(root, "skills")
  await mkdir(dir)
  const path = join(dir, "SKILL.md")
  await writeFile(join(root, "secret.md"), "secret")
  await symlink(join(root, "secret.md"), path)
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers({
      listSkills: async () =>
        okResult({
          skills: [
            { name: "Review", path, description: "Review", scope: "user" },
          ],
        }),
    }),
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  expect(
    await connection.sendRequest("session/skill/read", {
      sessionId: "allowed",
      path,
    }),
  ).toMatchObject({
    error: { message: "Path must stay within the workspace." },
  })
})

it("discovers enabled skills from a saved draft project and rejects disabled or foreign paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-draft-skill-"))
  roots.push(root)
  const project = join(root, "project")
  const directory = join(project, ".agents", "skills", "review")
  await mkdir(directory, { recursive: true })
  const path = await realpath(directory).then((dir) => join(dir, "SKILL.md"))
  await writeFile(
    path,
    "---\nname: review\ndescription: Review code\n---\n# Review steps",
  )
  const foreign = join(root, "other")
  await mkdir(foreign)
  await writeFile(join(foreign, "SKILL.md"), "private")
  const store = createSqliteProjectStore({
    databasePath: join(root, "projects.sqlite"),
  })
  const { project: saved } = await store.createProject({
    name: "Draft",
    roots: [project],
  })
  const userConfig = createUserConfigStore({
    configPath: join(root, "config.toml"),
    workspaceRoot: project,
  })
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers(),
    projectStore: store,
    userConfig,
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  expect(
    await connection.sendRequest("session/skills", { projectId: saved.id }),
  ).toMatchObject({
    result: {
      skills: expect.arrayContaining([
        {
          name: "review",
          description: "Review code",
          path,
          scope: "repo",
        },
      ]),
    },
  })
  expect(
    await connection.sendRequest("session/skill/read", {
      projectId: saved.id,
      path,
    }),
  ).toMatchObject({
    result: { content: expect.stringContaining("# Review steps") },
  })
  expect(
    await connection.sendRequest("session/skill/read", {
      projectId: saved.id,
      path: join(foreign, "SKILL.md"),
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  expect(
    await connection.sendRequest("session/skill/read", {
      projectId: "project_00000000-0000-0000-0000-000000000000",
      path,
    }),
  ).toHaveProperty("error")
  expect(
    await connection.sendRequest("session/skill/read", {
      projectId: "invalid",
      path,
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  await writeFile(
    join(root, "config.toml"),
    '[skills]\n[[skills.config]]\nname = "review"\nenabled = false\n',
  )
  expect(
    await connection.sendRequest("session/skill/read", {
      projectId: saved.id,
      path,
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  const disabled = await connection.sendRequest("session/skills", {
    projectId: saved.id,
  })
  expect(disabled).toHaveProperty("result")
  if ("result" in disabled) {
    expect(
      (disabled.result as { skills: { path: string }[] }).skills,
    ).not.toContainEqual(expect.objectContaining({ path }))
  }
  store.close()
})
