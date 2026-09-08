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
import { expect, it } from "vitest"
import { instructionDirectories } from "../../src/runtime/instruction-files.ts"

it("continues past unreadable markers to other markers and ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-marker-"))
  try {
    const cwd = join(root, "nested")
    await mkdir(cwd)
    await symlink(".git", join(cwd, ".git"))
    await writeFile(join(root, ".git"), "")
    // Resolve /tmp aliases to compare the canonical discovery paths.
    const canonicalRoot = await realpath(root)
    const canonicalCwd = join(canonicalRoot, "nested")

    expect(await instructionDirectories(cwd)).toEqual([
      canonicalRoot,
      canonicalCwd,
    ])
    await writeFile(join(cwd, ".project-root"), "")
    expect(
      await instructionDirectories(cwd, [".git", ".project-root"]),
    ).toEqual([canonicalCwd])
    await symlink(".loop", join(cwd, ".loop"))
    expect(await instructionDirectories(cwd, [".missing", ".loop"])).toEqual([
      canonicalCwd,
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
