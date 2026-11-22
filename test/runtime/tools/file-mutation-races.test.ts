import { createHash } from "node:crypto"
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createApplyPatchTool } from "../../../src/runtime/tools/apply-patch.ts"
import { createEditFileTool } from "../../../src/runtime/tools/edit-file.ts"
import {
  createVisibleFileObservations,
  grantsFromToolOutput,
} from "../../../src/runtime/tools/visible-file-observations.ts"
import { createWriteFileTool } from "../../../src/runtime/tools/write-file.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, link: vi.fn(fs.link), rename: vi.fn(fs.rename) }
})

const realFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")

const editors = [
  {
    name: "edit_file",
    tool: createEditFileTool(),
    additions: (...paths: string[]) => ({
      edits: paths.map((path) => ({
        path,
        oldString: "",
        newString: `${path}\n`,
      })),
    }),
  },
  {
    name: "apply_patch",
    tool: createApplyPatchTool(),
    additions: (...paths: string[]) =>
      [
        "*** Begin Patch",
        ...paths.flatMap((path) => [`*** Add File: ${path}`, `+${path}`]),
        "*** End Patch",
      ].join("\n"),
  },
]

it.each(
  editors,
)("$name detects case-colliding files and supports siblings under the same new directory", async ({
  tool,
  additions,
}) => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "probe.txt"), "existing")
    const insensitive = await namesAreCaseInsensitive(workspaceRoot)

    if (insensitive) {
      for (const paths of [
        ["Foo.txt", "foo.txt"],
        ["Dir", "dir/child.txt"],
      ]) {
        await expect(
          tool.execute(additions(...paths), { workspaceRoot }),
        ).resolves.toMatchObject({ ok: false })
        expect(await readdir(workspaceRoot)).toEqual(["probe.txt"])
      }
    } else {
      await expect(
        tool.execute(additions("Foo.txt", "foo.txt"), { workspaceRoot }),
      ).resolves.toMatchObject({ ok: true })
      expect(await readFile(join(workspaceRoot, "Foo.txt"), "utf8")).toBe(
        "Foo.txt\n",
      )
      expect(await readFile(join(workspaceRoot, "foo.txt"), "utf8")).toBe(
        "foo.txt\n",
      )
    }

    await expect(
      tool.execute(additions("Src/a.txt", "src/b.txt"), { workspaceRoot }),
    ).resolves.toMatchObject({ ok: true })
    expect(await readFile(join(workspaceRoot, "Src/a.txt"), "utf8")).toBe(
      "Src/a.txt\n",
    )
    expect(await readFile(join(workspaceRoot, "src/b.txt"), "utf8")).toBe(
      "src/b.txt\n",
    )
  })
})

for (const { name, tool, additions } of editors) {
  it(`${name} detects Unicode normalization aliases before creating any file`, async (test) => {
    await withWorkspace(async (workspaceRoot) => {
      const composed = "café.txt"
      const decomposed = "cafe\u0301.txt"
      await writeFile(join(workspaceRoot, composed), "probe")
      let aliases = false
      try {
        aliases =
          (await readFile(join(workspaceRoot, decomposed), "utf8")) === "probe"
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error
      } finally {
        await rm(join(workspaceRoot, composed))
      }
      if (!aliases) test.skip()
      const result = await tool.execute(
        additions("earlier.txt", composed, decomposed),
        { workspaceRoot },
      )
      expect(result).toMatchObject({ ok: false })
      expect(await readdir(workspaceRoot)).toEqual([])
    })
  })
}

it("serializes concurrent creation batches for the same case-insensitive filename", async (test) => {
  await withWorkspace(async (workspaceRoot) => {
    if (!(await namesAreCaseInsensitive(workspaceRoot))) test.skip()
    const edit = createEditFileTool()
    const additions = (other: string, shared: string) => ({
      edits: [other, shared].map((path) => ({
        path,
        oldString: "",
        newString: path,
      })),
    })
    const [one, two] = await Promise.all([
      edit.execute(additions("one.txt", "Shared.txt"), { workspaceRoot }),
      edit.execute(additions("two.txt", "shared.txt"), { workspaceRoot }),
    ])
    expect([one.ok, two.ok].filter(Boolean)).toEqual([true])
    const winner = one.ok ? "one.txt" : "two.txt"
    const loser = one.ok ? "two.txt" : "one.txt"
    await expect(readFile(join(workspaceRoot, winner), "utf8")).resolves.toBe(
      winner,
    )
    await expect(readFile(join(workspaceRoot, loser))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

it("labels a failed case-only rename diff with the source that was actually updated", async (test) => {
  await withWorkspace(async (workspaceRoot) => {
    if (!(await namesAreCaseInsensitive(workspaceRoot))) test.skip()
    await writeFile(join(workspaceRoot, "file.txt"), "before\n")
    vi.mocked(rename)
      .mockImplementationOnce(realFs.rename)
      .mockRejectedValueOnce(
        Object.assign(new Error("rename denied"), { code: "EACCES" }),
      )
    const result = await createApplyPatchTool().execute(
      "*** Begin Patch\n*** Update File: file.txt\n*** Move to: File.txt\n@@\n-before\n+after\n*** End Patch",
      { workspaceRoot },
    )
    expect(result).toMatchObject({
      ok: false,
      code: "partial_move",
      output: {
        deltaExact: false,
        changes: [
          {
            path: "file.txt",
            kind: "update",
            diff: { text: expect.stringContaining("+++ b/file.txt") },
          },
        ],
      },
    })
    expect(await readFile(join(workspaceRoot, "file.txt"), "utf8")).toBe(
      "after\n",
    )
    expect(await readdir(workspaceRoot)).toEqual(["file.txt"])
  })
})

it.each(
  editors,
)("$name preserves the committed file when the workspace disappears mid-batch", async ({
  tool,
  additions,
}) => {
  await withWorkspace(async (root) => {
    const workspaceRoot = join(root, "workspace")
    const moved = join(root, "moved")
    await mkdir(workspaceRoot)
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await realFs.link(from, to)
      await rename(workspaceRoot, moved)
    })

    const result = await tool.execute(additions("a.txt", "b.txt"), {
      workspaceRoot,
    })
    expect(result).toMatchObject({
      ok: false,
      code: "workspace_unavailable",
      output: {
        failedPath: "b.txt",
        changes: [{ path: "a.txt", kind: "add" }],
        fileObservations: [{ path: "a.txt", sha256: digest("a.txt\n") }],
      },
    })
    expect(await readFile(join(moved, "a.txt"), "utf8")).toBe("a.txt\n")
    await expect(readFile(join(moved, "b.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

it.each(
  editors,
)("$name stops before the next file and reports the committed file on cancellation", async ({
  tool,
  additions,
}) => {
  await withWorkspace(async (workspaceRoot) => {
    const controller = new AbortController()
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await realFs.link(from, to)
      controller.abort()
    })
    const result = await tool.execute(additions("a.txt", "b.txt", "c.txt"), {
      workspaceRoot,
      signal: controller.signal,
    })
    expect(result).toMatchObject({
      ok: false,
      code: "batch_cancelled",
      output: {
        failedPath: "b.txt",
        changes: [{ path: "a.txt", kind: "add" }],
      },
    })
    expect(await readdir(workspaceRoot)).toEqual(["a.txt"])
  })
})

it("identifies a later edit CAS failure and retains prior changes and the CAS diagnostic", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const b = join(workspaceRoot, "b.txt")
    await writeFile(b, "before")
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await realFs.link(from, to)
      await writeFile(b, "external")
    })

    const result = await createEditFileTool().execute(
      {
        edits: [
          { path: "a.txt", oldString: "", newString: "created" },
          { path: "b.txt", oldString: "before", newString: "edit" },
          { path: "c.txt", oldString: "", newString: "unattempted" },
        ],
      },
      { workspaceRoot },
    )
    expect(result).toMatchObject({
      ok: false,
      code: "file_changed_during_edit",
      output: {
        failedPath: "b.txt",
        currentSha256: digest("external"),
        changes: [{ path: "a.txt", kind: "add" }],
      },
    })
    expect(await readFile(b, "utf8")).toBe("external")
    expect(await readdir(workspaceRoot)).toEqual(["a.txt", "b.txt"])
  })
})

it("keeps uncertainty from a partial patch move until the file is read again", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const source = join(workspaceRoot, "source.txt")
    const destination = join(workspaceRoot, "destination.txt")
    await writeFile(source, "value\n")
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await realFs.link(from, to)
      await writeFile(source, "external source\n")
      await writeFile(destination, "external destination\n")
    })

    const result = await createApplyPatchTool().execute(
      "*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n*** End Patch",
      { workspaceRoot },
    )
    expect(result).toMatchObject({
      ok: false,
      code: "partial_move",
      output: {
        deltaExact: false,
        fileObservations: [
          expect.objectContaining({ path: "source.txt", kind: "invalidate" }),
          expect.objectContaining({
            path: "destination.txt",
            kind: "invalidate",
          }),
        ],
      },
    })
    if (result.output === undefined) throw new Error("Missing partial outcome")
    const visibleFileObservations = createVisibleFileObservations()
    for (const grant of grantsFromToolOutput(result.output))
      visibleFileObservations.apply(grant)
    const context = { workspaceRoot, visibleFileObservations }
    await expect(
      createWriteFileTool().execute(
        { path: "destination.txt", content: "overwrite" },
        context,
      ),
    ).resolves.toMatchObject({ ok: false, code: "file_revision_unknown" })
    await expect(
      createEditFileTool().execute(
        {
          path: "source.txt",
          oldString: "external",
          newString: "new",
          replaceAll: true,
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: false, code: "file_revision_unknown" })
    expect(await readFile(source, "utf8")).toBe("external source\n")
    expect(await readFile(destination, "utf8")).toBe("external destination\n")
  })
})

async function namesAreCaseInsensitive(
  workspaceRoot: string,
): Promise<boolean> {
  const probe = join(workspaceRoot, "case-probe.txt")
  await writeFile(probe, "existing")
  try {
    return (
      (await readFile(join(workspaceRoot, "CASE-PROBE.txt"), "utf8")) ===
      "existing"
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
    return false
  } finally {
    await rm(probe)
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function withWorkspace(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-file-race-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
