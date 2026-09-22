import { execFile } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  GitDiffResponse,
  GitPullRequestsResponse,
  GitStatusResponse,
  WorkspaceListResponse,
  WorkspaceReadResponse,
} from "../../../src/server/workspace.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
  type TestConnection,
} from "./testkit.ts"

const executeFile = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup(repository = false) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-workspace-"))
  roots.push(root)
  const cwd = join(root, "project")
  await mkdir(cwd)
  if (repository) await git(cwd, ["init", "--quiet"])
  const { processor } = createTestProcessor({ handlers: createFakeHandlers() })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return { root, cwd, connection }
}

async function git(cwd: string, args: string[]) {
  return (
    await executeFile(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Workspace Test",
        "-c",
        "user.email=workspace@example.test",
        ...args,
      ],
      { encoding: "utf8" },
    )
  ).stdout
}

async function rpc<T>(
  connection: TestConnection,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await connection.sendRequest(method, params)
  expect(response).toHaveProperty("result")
  if (!("result" in response)) throw new Error(JSON.stringify(response))
  return response.result as T
}

describe("workspace RPC against the filesystem and Git", () => {
  it("lists hidden files and nested directories while keeping reads within the workspace", async () => {
    const { root, cwd, connection } = await setup()
    await mkdir(join(cwd, ".git"))
    await mkdir(join(cwd, "nested"))
    await writeFile(join(cwd, ".env.example"), "PUBLIC=value")
    await writeFile(join(cwd, "nested", "file.txt"), "inside")
    await writeFile(join(root, "outside.txt"), "outside")
    await symlink(join(root, "outside.txt"), join(cwd, "outside-link"))
    await symlink(join(cwd, "nested"), join(cwd, "inside-link"))
    const listing = await rpc<WorkspaceListResponse>(
      connection,
      "workspace/list",
      { cwd },
    )
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "nested",
      ".env.example",
      "inside-link",
      "outside-link",
    ])
    expect(listing.truncated).toBe(false)
    const nested = await rpc<WorkspaceListResponse>(
      connection,
      "workspace/list",
      { cwd, path: "inside-link" },
    )
    expect(nested.entries).toEqual([
      { name: "file.txt", path: "nested/file.txt", kind: "file" },
    ])
    for (const path of [
      "../outside.txt",
      join(root, "outside.txt"),
      "outside-link",
      ".git/config",
    ]) {
      expect(
        await connection.sendRequest("workspace/read", { cwd, path }),
      ).toMatchObject({
        error: { code: -32602, data: { code: "invalid_input" } },
      })
    }
    expect(
      await connection.sendRequest("workspace/read", { cwd, path: "missing" }),
    ).toMatchObject({
      error: { data: { code: "not_found" } },
    })
  })

  it("returns bounded line pages and explicit binary previews", async () => {
    const { cwd, connection } = await setup()
    await writeFile(join(cwd, "file.txt"), "one\n二\nthree\nfour")
    const page = await rpc<WorkspaceReadResponse>(
      connection,
      "workspace/read",
      {
        cwd,
        path: "file.txt",
        offset: 2,
        limit: 2,
      },
    )
    expect(page).toEqual({
      path: "file.txt",
      content: "二\nthree",
      offset: 2,
      nextOffset: 4,
      truncated: true,
      binary: false,
    })
    expect(
      await rpc(connection, "workspace/read", {
        cwd,
        path: "file.txt",
        offset: 4,
        limit: 2,
      }),
    ).toEqual({
      path: "file.txt",
      content: "four",
      offset: 4,
      truncated: false,
      binary: false,
    })
    await writeFile(join(cwd, "binary"), Buffer.from([0xff, 0x00, 0xfe]))
    expect(
      await rpc(connection, "workspace/read", { cwd, path: "binary" }),
    ).toMatchObject({
      binary: true,
      content: "",
    })
    await writeFile(join(cwd, "long.txt"), "x".repeat(10_000))
    const long = await rpc<WorkspaceReadResponse>(
      connection,
      "workspace/read",
      { cwd, path: "long.txt" },
    )
    expect(long.content.length).toBeLessThan(2_100)
    expect(long.truncated).toBe(true)
    expect(
      await connection.sendRequest("workspace/read", {
        cwd,
        path: "file.txt",
        offset: 0,
      }),
    ).toHaveProperty("error")
    expect(
      await connection.sendRequest("workspace/list", { cwd: "." }),
    ).toHaveProperty("error")
  })

  it("reports a non-repository folder without fabricating a changes list", async () => {
    const { cwd, connection } = await setup()
    expect(await rpc(connection, "git/status", { cwd })).toEqual({
      repository: false,
      entries: [],
    })
    expect(
      await connection.sendRequest("git/stage", { cwd, path: "anything" }),
    ).toHaveProperty("error")
  })

  it("returns stable Git identity and all PR states for a session branch", async () => {
    const { root, cwd, connection } = await setup(true)
    await writeFile(join(cwd, "tracked.txt"), "tracked\n")
    await git(cwd, ["add", "."])
    await git(cwd, ["commit", "--quiet", "-m", "initial"])
    await git(cwd, ["branch", "-M", "feat/session-context"])
    await git(cwd, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/project.git",
    ])

    const status = await rpc<GitStatusResponse>(connection, "git/status", {
      cwd,
    })
    expect(status.branch).toBe("feat/session-context")

    const bin = join(root, "bin")
    await mkdir(bin)
    const gh = join(bin, "gh")
    await writeFile(
      gh,
      `#!/bin/sh
case "$*" in
  "pr list --state all --head feat/session-context --limit 50 --json number,title,state,isDraft,url,headRefName,updatedAt") ;;
  *) exit 2 ;;
esac
printf '%s' '[{"number":12,"title":"Current work","state":"OPEN","isDraft":false,"url":"https://github.com/example/project/pull/12","headRefName":"feat/session-context","updatedAt":"2026-09-22T00:00:00Z"},{"number":7,"title":"Earlier approach","state":"MERGED","isDraft":false,"url":"https://github.com/example/project/pull/7","headRefName":"feat/session-context","updatedAt":"2026-09-20T00:00:00Z"}]'
`,
    )
    await chmod(gh, 0o755)
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)

    expect(
      await rpc<GitPullRequestsResponse>(connection, "git/pullRequests", {
        cwd,
        branch: "feat/session-context",
      }),
    ).toEqual({
      available: true,
      pullRequests: [
        expect.objectContaining({
          number: 12,
          state: "OPEN",
          title: "Current work",
        }),
        expect.objectContaining({
          number: 7,
          state: "MERGED",
          title: "Earlier approach",
        }),
      ],
    })
  })

  it("keeps the index and working tree distinct and stages only the selected literal path", async () => {
    const { cwd, connection } = await setup(true)
    const path = ":(glob)*[file].txt"
    await writeFile(join(cwd, path), "base\n")
    await git(cwd, ["add", "."])
    await git(cwd, ["commit", "--quiet", "-m", "initial"])
    await writeFile(join(cwd, path), "staged\n")
    await writeFile(join(cwd, "unrelated.txt"), "unrelated\n")
    await rpc(connection, "git/stage", { cwd, path })
    await writeFile(join(cwd, path), "working\n")
    const status = await rpc<GitStatusResponse>(connection, "git/status", {
      cwd,
    })
    expect(status.entries).toContainEqual({
      path,
      indexStatus: "M",
      worktreeStatus: "M",
    })
    const staged = await rpc<GitDiffResponse>(connection, "git/diff", {
      cwd,
      path,
      staged: true,
    })
    expect(staged.text).toContain("-base\n+staged")
    const working = await rpc<GitDiffResponse>(connection, "git/diff", {
      cwd,
      path,
      staged: false,
    })
    expect(working.text).toContain("-staged\n+working")
    const untracked = await rpc<GitDiffResponse>(connection, "git/diff", {
      cwd,
      path: "unrelated.txt",
      staged: false,
    })
    expect(untracked.text).toContain("+unrelated")
    await rpc(connection, "git/unstage", { cwd, path })
    expect(await git(cwd, ["diff", "--cached", "--name-only"])).toBe("")
    expect(await readFile(join(cwd, path), "utf8")).toBe("working\n")
  })

  it("unstages files before the first commit without deleting their working contents", async () => {
    const { cwd, connection } = await setup(true)
    await writeFile(join(cwd, "new.txt"), "first\n")
    await rpc(connection, "git/stage", { cwd, path: "new.txt" })
    await writeFile(join(cwd, "new.txt"), "second\n")
    await rpc(connection, "git/unstage", { cwd, path: "new.txt" })
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("second\n")
    expect(
      (await rpc<GitStatusResponse>(connection, "git/status", { cwd })).entries,
    ).toEqual([{ path: "new.txt", indexStatus: "?", worktreeStatus: "?" }])
  })

  it("does not inherit an unrelated Git index from the server environment", async () => {
    const { root, cwd, connection } = await setup(true)
    await writeFile(join(cwd, "file.txt"), "contents\n")
    const unrelatedIndex = join(root, "unrelated-index")
    vi.stubEnv("GIT_INDEX_FILE", unrelatedIndex)
    await rpc(connection, "git/stage", { cwd, path: "file.txt" })
    vi.unstubAllEnvs()
    expect(await git(cwd, ["diff", "--cached", "--name-only"])).toBe(
      "file.txt\n",
    )
    await expect(readFile(unrelatedIndex)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("decodes unusual rename paths and unstages both sides of the rename", async () => {
    const { cwd, connection } = await setup(true)
    const originalPath = "old\tname.txt"
    const path = "new\nname.txt"
    await writeFile(join(cwd, originalPath), "same content\n")
    await git(cwd, ["add", "."])
    await git(cwd, ["commit", "--quiet", "-m", "initial"])
    await git(cwd, ["mv", originalPath, path])
    const status = await rpc<GitStatusResponse>(connection, "git/status", {
      cwd,
    })
    expect(status.entries).toEqual([
      { path, originalPath, indexStatus: "R", worktreeStatus: " " },
    ])
    await rpc(connection, "git/unstage", { cwd, path })
    expect(await git(cwd, ["diff", "--cached", "--name-only"])).toBe("")
    expect(await readFile(join(cwd, path), "utf8")).toBe("same content\n")
  })

  it("uses a nested workspace and disables external diff drivers", async () => {
    const { cwd, connection } = await setup(true)
    await mkdir(join(cwd, "nested"))
    await writeFile(join(cwd, "outside.txt"), "base\n")
    await writeFile(join(cwd, "nested", "inside.txt"), "base\n")
    await git(cwd, ["add", "."])
    await git(cwd, ["commit", "--quiet", "-m", "initial"])
    await writeFile(join(cwd, "outside.txt"), "changed outside\n")
    await writeFile(join(cwd, "nested", "inside.txt"), "changed inside\n")
    await git(cwd, ["config", "diff.external", "false"])
    const nestedCwd = join(cwd, "nested")
    const status = await rpc<GitStatusResponse>(connection, "git/status", {
      cwd: nestedCwd,
    })
    expect(status.entries).toEqual([
      { path: "inside.txt", indexStatus: " ", worktreeStatus: "M" },
    ])
    expect(
      (
        await rpc<GitDiffResponse>(connection, "git/diff", {
          cwd: nestedCwd,
          path: "inside.txt",
          staged: false,
        })
      ).text,
    ).toContain("+changed inside")
    expect(
      await connection.sendRequest("git/stage", {
        cwd: nestedCwd,
        path: "../outside.txt",
      }),
    ).toHaveProperty("error")
    await rpc(connection, "git/stage", { cwd: nestedCwd, path: "inside.txt" })
    expect(await git(cwd, ["diff", "--cached", "--name-only"])).toBe(
      "nested/inside.txt\n",
    )
  })
})
