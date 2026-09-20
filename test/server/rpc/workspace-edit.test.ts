import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import { compareAndWriteTextFile } from "../../../src/runtime/tools/text-file-write.ts"
import type {
  WorkspaceFindFilesResponse,
  WorkspaceReadForEditResponse,
  WorkspaceWriteResponse,
} from "../../../src/server/workspace.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
  type TestConnection,
} from "./testkit.ts"

// Keep real filesystem operations; the open seam lets a concurrent editor
// change a path at a deterministic point before the writer's final checks.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(open).mockReset()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-workspace-edit-"))
  roots.push(root)
  const cwd = join(root, "project")
  await mkdir(cwd)
  const { processor } = createTestProcessor({ handlers: createFakeHandlers() })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return { root, cwd, connection }
}

async function rpc<T>(
  connection: TestConnection,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await connection.sendRequest(method, params)
  if (!("result" in response)) throw new Error(JSON.stringify(response))
  return response.result as T
}

it("reads complete editable text and saves BOM, newlines, and final-newline absence exactly", async () => {
  const { cwd, connection } = await setup()
  const content = `\uFEFFfirst\r\n二\rthird\n${"long ".repeat(2500)}`
  await writeFile(join(cwd, "source.txt"), content)
  const document = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "source.txt" },
  )
  expect(document).toEqual({
    path: "source.txt",
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  })
  const edited = document.content.replace("first", "updated")
  const saved = await rpc<WorkspaceWriteResponse>(
    connection,
    "workspace/write",
    {
      cwd,
      path: document.path,
      content: edited,
      expectedSha256: document.sha256,
    },
  )
  expect(saved.sha256).toBe(createHash("sha256").update(edited).digest("hex"))
  expect(await readFile(join(cwd, "source.txt"))).toEqual(Buffer.from(edited))
  const reread = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "source.txt" },
  )
  expect(reread).toEqual({ ...saved, content: edited })
})

it("rejects stale edits and requires an explicit current revision without force overwrite", async () => {
  const { cwd, connection } = await setup()
  await writeFile(join(cwd, "file.txt"), "original")
  const document = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "file.txt" },
  )
  await writeFile(join(cwd, "file.txt"), "external edit")
  const input = {
    cwd,
    path: "file.txt",
    content: "GUI edit",
    expectedSha256: document.sha256,
  }
  expect(await connection.sendRequest("workspace/write", input)).toMatchObject({
    error: { data: { code: "conflict" } },
  })
  for (const params of [
    { cwd, path: "file.txt", content: "GUI edit" },
    { ...input, expectedSha256: "invalid" },
    { ...input, force: true },
    { ...input, content: "\uD800" },
    { ...input, content: "\0" },
    { ...input, content: "x".repeat(1024 * 1024 + 1) },
  ])
    expect(
      await connection.sendRequest("workspace/write", params),
    ).toMatchObject({
      error: { data: { code: "invalid_input" } },
    })
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("external edit")
  await unlink(join(cwd, "file.txt"))
  expect(await connection.sendRequest("workspace/write", input)).toMatchObject({
    error: { data: { code: "conflict" } },
  })
})

it("serializes GUI saves with agent compare-and-write on the same file", async () => {
  const { cwd, connection } = await setup()
  await writeFile(join(cwd, "file.txt"), "original")
  const document = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "file.txt" },
  )
  const [gui, tool] = await Promise.all([
    connection.sendRequest("workspace/write", {
      cwd,
      path: "file.txt",
      content: "GUI edit",
      expectedSha256: document.sha256,
    }),
    compareAndWriteTextFile({
      workspaceRoot: cwd,
      path: "file.txt",
      content: "agent edit",
      expectedSha256: document.sha256,
    }),
  ])
  expect(Number("result" in gui) + Number(tool.ok)).toBe(1)
  if ("result" in gui) {
    expect(tool).toMatchObject({ ok: false, code: "stale_sha256" })
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("GUI edit")
  } else {
    expect(gui).toMatchObject({ error: { data: { code: "conflict" } } })
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("agent edit")
  }
})

it("detects an external edit while the replacement file is being prepared", async () => {
  const { cwd, connection } = await setup()
  await writeFile(join(cwd, "file.txt"), "original")
  const document = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "file.txt" },
  )
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode)
    if (
      typeof path === "string" &&
      basename(path).startsWith(".yakitori-write-")
    )
      await writeFile(join(cwd, "file.txt"), "external edit during save")
    return handle
  })
  expect(
    await connection.sendRequest("workspace/write", {
      cwd,
      path: "file.txt",
      content: "GUI edit",
      expectedSha256: document.sha256,
    }),
  ).toMatchObject({ error: { data: { code: "conflict" } } })
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
    "external edit during save",
  )
})

it("rejects a symlink retargeted outside the workspace during save", async () => {
  const { root, cwd, connection } = await setup()
  await writeFile(join(cwd, "file.txt"), "original")
  await writeFile(join(root, "outside.txt"), "original")
  await symlink(join(cwd, "file.txt"), join(cwd, "alias.txt"))
  const document = await rpc<WorkspaceReadForEditResponse>(
    connection,
    "workspace/readForEdit",
    { cwd, path: "alias.txt" },
  )
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode)
    if (
      typeof path === "string" &&
      basename(path).startsWith(".yakitori-write-")
    ) {
      await unlink(join(cwd, "alias.txt"))
      await symlink(join(root, "outside.txt"), join(cwd, "alias.txt"))
    }
    return handle
  })
  expect(
    await connection.sendRequest("workspace/write", {
      cwd,
      path: "alias.txt",
      content: "GUI edit",
      expectedSha256: document.sha256,
    }),
  ).toMatchObject({ error: { data: { code: "conflict" } } })
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("original")
  expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("original")
})

it("rejects a replaced file during an editable read", async () => {
  const { cwd, connection } = await setup()
  const path = join(cwd, "file.txt")
  await writeFile(path, "original")
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(async (target, flags, mode) => {
    const handle = await actual.open(target, flags, mode)
    if (typeof target === "string" && basename(target) === "file.txt") {
      await rename(path, join(cwd, "before.txt"))
      await writeFile(path, "replacement")
    }
    return handle
  })
  expect(
    await connection.sendRequest("workspace/readForEdit", {
      cwd,
      path: "file.txt",
    }),
  ).toMatchObject({ error: { data: { code: "conflict" } } })
})

it("refuses binary, invalid UTF-8, oversized, special, and out-of-workspace edit reads", async () => {
  const { root, cwd, connection } = await setup()
  await writeFile(join(cwd, "binary"), Buffer.from([65, 0, 66]))
  await writeFile(join(cwd, "invalid"), Buffer.from([0xff, 0xfe]))
  await writeFile(join(cwd, "oversized"), "x".repeat(1024 * 1024 + 1))
  await mkdir(join(cwd, "directory"))
  await mkdir(join(cwd, ".git"))
  await writeFile(join(cwd, ".git", "config"), "internal")
  await writeFile(join(root, "outside"), "outside")
  await symlink(join(root, "outside"), join(cwd, "external"))
  await symlink(join(cwd, ".git"), join(cwd, "git-alias"))
  for (const path of [
    "binary",
    "invalid",
    "oversized",
    "directory",
    "external",
    "../outside",
    join(root, "outside"),
    ".git/config",
    "git-alias/config",
  ])
    expect(
      await connection.sendRequest("workspace/readForEdit", { cwd, path }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  for (const path of [
    "external",
    "../outside",
    join(root, "outside"),
    ".git/config",
    "git-alias/config",
  ])
    expect(
      await connection.sendRequest("workspace/write", {
        cwd,
        path,
        content: "must not be written",
        expectedSha256: createHash("sha256").update("outside").digest("hex"),
      }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  expect(await readFile(join(root, "outside"), "utf8")).toBe("outside")
  expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe("internal")
  if (process.platform !== "win32") {
    await promisify(execFile)("mkfifo", [join(cwd, "pipe")])
    expect(
      await connection.sendRequest("workspace/readForEdit", {
        cwd,
        path: "pipe",
      }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  }
})

it("finds literal case-insensitive paths including hidden files while respecting Git ignores", async () => {
  const { cwd, connection } = await setup()
  await promisify(execFile)("git", ["init", "--quiet", cwd])
  await mkdir(join(cwd, ".config"))
  await mkdir(join(cwd, "ignored"))
  await writeFile(join(cwd, ".gitignore"), "ignored/\n")
  await writeFile(join(cwd, ".config", "[literal].TS"), "")
  await writeFile(join(cwd, "ignored", "[literal].TS"), "")
  await writeFile(join(cwd, ".git", "[literal].TS"), "")
  expect(
    await rpc<WorkspaceFindFilesResponse>(connection, "workspace/findFiles", {
      cwd,
      query: "[LITERAL]",
    }),
  ).toEqual({ paths: [".config/[literal].TS"], truncated: false })
  expect(
    await rpc(connection, "workspace/findFiles", { cwd, query: "" }),
  ).toEqual({ paths: [], truncated: false })
})

it("bounds filename results and reports truncation", async () => {
  const { cwd, connection } = await setup()
  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      writeFile(join(cwd, `match-${index}.txt`), ""),
    ),
  )
  const result = await rpc<WorkspaceFindFilesResponse>(
    connection,
    "workspace/findFiles",
    { cwd, query: "match-" },
  )
  expect(result.paths).toHaveLength(200)
  expect(result.truncated).toBe(true)
})
