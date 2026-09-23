import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  open,
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
import type { WorkspaceReadMediaResponse } from "../../../src/server/workspace.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
} from "./testkit.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(actual.open)
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-workspace-media-"))
  roots.push(root)
  const cwd = join(root, "project")
  await mkdir(cwd)
  const { processor } = createTestProcessor({ handlers: createFakeHandlers() })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return { root, cwd, connection }
}

it("returns exact base64 bytes and MIME for supported images and PDF through the RPC", async () => {
  const { cwd, connection } = await setup()
  const samples = [
    ["sample.png", "image/png"],
    ["sample.JPG", "image/jpeg"],
    ["sample.jpeg", "image/jpeg"],
    ["sample.webp", "image/webp"],
    ["sample.gif", "image/gif"],
    ["sample.pdf", "application/pdf"],
  ] as const
  const bytes = Buffer.from([0, 1, 0xff, 0x80, 27])
  for (const [path, mimeType] of samples) {
    await writeFile(join(cwd, path), bytes)
    const response = await connection.sendRequest("workspace/readMedia", {
      cwd,
      path,
    })
    expect(response).toHaveProperty("result")
    if (!("result" in response)) throw new Error(JSON.stringify(response))
    expect(response.result as WorkspaceReadMediaResponse).toEqual({
      path,
      mimeType,
      base64: "AAH/gBs=",
    })
  }
  // The existing text RPC still marks binary content without returning it.
  expect(
    await connection.sendRequest("workspace/read", { cwd, path: "sample.png" }),
  ).toMatchObject({ result: { binary: true, content: "" } })
})

it("allows an internal symlink and rejects escape paths, .git, and unsupported types", async () => {
  const { root, cwd, connection } = await setup()
  await mkdir(join(cwd, ".git"))
  await writeFile(join(cwd, ".git", "config.png"), "secret")
  await writeFile(join(cwd, "inside.png"), "inside")
  await writeFile(join(root, "outside.png"), "outside")
  await writeFile(join(cwd, "note.svg"), "<svg/>")
  await writeFile(join(cwd, "document.docx"), "office")
  await writeFile(join(cwd, "missing.png.txt"), "text")
  await symlink(join(cwd, "inside.png"), join(cwd, "alias.png"))
  await symlink(join(root, "outside.png"), join(cwd, "escape.png"))
  await symlink(join(cwd, ".git"), join(cwd, "git-alias"))
  expect(
    await connection.sendRequest("workspace/readMedia", {
      cwd,
      path: "alias.png",
    }),
  ).toMatchObject({
    result: { path: "inside.png", mimeType: "image/png", base64: "aW5zaWRl" },
  })
  for (const path of [
    "escape.png",
    "../outside.png",
    join(root, "outside.png"),
    ".git/config.png",
    "git-alias/config.png",
    "note.svg",
    "document.docx",
    "missing.png.txt",
  ]) {
    expect(
      await connection.sendRequest("workspace/readMedia", { cwd, path }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  }
  expect(
    await connection.sendRequest("workspace/readMedia", {
      cwd,
      path: "missing.png",
    }),
  ).toMatchObject({ error: { data: { code: "not_found" } } })
  expect(
    await connection.sendRequest("workspace/readMedia", { cwd, path: 1 }),
  ).toMatchObject({ error: { code: -32602 } })
})

it("rejects oversized and non-regular files before allocating a preview buffer", async () => {
  const { cwd, connection } = await setup()
  const oversized = await open(join(cwd, "large.pdf"), "w")
  try {
    await oversized.truncate(16 * 1024 * 1024 + 1)
  } finally {
    await oversized.close()
  }
  await mkdir(join(cwd, "directory.png"))
  for (const path of ["large.pdf", "directory.png"]) {
    expect(
      await connection.sendRequest("workspace/readMedia", { cwd, path }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  }
  if (process.platform !== "win32") {
    await promisify(execFile)("mkfifo", [join(cwd, "pipe.png")])
    expect(
      await connection.sendRequest("workspace/readMedia", {
        cwd,
        path: "pipe.png",
      }),
    ).toMatchObject({ error: { data: { code: "invalid_input" } } })
  }
})

it("rejects a file replaced after opening instead of returning stale bytes", async () => {
  const { cwd, connection } = await setup()
  const target = join(cwd, "image.png")
  await writeFile(target, "original")
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode)
    if (typeof path === "string" && basename(path) === "image.png") {
      await rename(target, join(cwd, "previous.png"))
      await writeFile(target, "replacement")
    }
    return handle
  })
  expect(
    await connection.sendRequest("workspace/readMedia", {
      cwd,
      path: "image.png",
    }),
  ).toMatchObject({ error: { data: { code: "conflict" } } })
})

it("rejects an internal symlink retargeted outside during a preview read", async () => {
  const { root, cwd, connection } = await setup()
  const target = join(cwd, "inside.png")
  const alias = join(cwd, "alias.png")
  await writeFile(target, "inside")
  await writeFile(join(root, "outside.png"), "outside")
  await symlink(target, alias)
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode)
    if (typeof path === "string" && basename(path) === "inside.png") {
      await unlink(alias)
      await symlink(join(root, "outside.png"), alias)
    }
    return handle
  })
  expect(
    await connection.sendRequest("workspace/readMedia", {
      cwd,
      path: "alias.png",
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
})
