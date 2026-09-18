import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveOpenableWorkspaceFile } from "../../src/desktop/resource-path.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("desktop resource paths", () => {
  it("resolves regular files inside the workspace", async () => {
    const workspace = await temporaryDirectory("workspace")
    const file = path.join(workspace, "src", "app.ts")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "export {}\n")

    await expect(
      resolveOpenableWorkspaceFile(workspace, "src/app.ts"),
    ).resolves.toBe(await realpath(file))
  })

  it("rejects paths and symlinks that leave the workspace", async () => {
    const workspace = await temporaryDirectory("workspace")
    const outside = await temporaryDirectory("outside")
    const secret = path.join(outside, "secret.txt")
    await writeFile(secret, "secret\n")
    await symlink(secret, path.join(workspace, "linked.txt"))

    await expect(
      resolveOpenableWorkspaceFile(workspace, secret),
    ).rejects.toThrow("must stay within the workspace")
    await expect(
      resolveOpenableWorkspaceFile(workspace, "linked.txt"),
    ).rejects.toThrow("must stay within the workspace")
  })

  it("rejects directories, executable files, and installer extensions", async () => {
    const workspace = await temporaryDirectory("workspace")
    const executable = path.join(workspace, "run.command")
    const installer = path.join(workspace, "setup.pkg")
    await writeFile(executable, "#!/bin/sh\n")
    await chmod(executable, 0o755)
    await writeFile(installer, "not really a package\n")

    await expect(resolveOpenableWorkspaceFile(workspace, ".")).rejects.toThrow(
      "regular file",
    )
    await expect(
      resolveOpenableWorkspaceFile(workspace, "run.command"),
    ).rejects.toThrow("Executable files")
    await expect(
      resolveOpenableWorkspaceFile(workspace, "setup.pkg"),
    ).rejects.toThrow("Executable files")
  })
})

async function temporaryDirectory(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `yakitori-${name}-`))
  roots.push(root)
  return root
}
