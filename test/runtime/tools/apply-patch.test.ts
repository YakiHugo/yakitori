import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createApplyPatchTool } from "../../../src/runtime/tools/apply-patch.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("apply_patch", () => {
  it("exposes Codex freeform grammar with a function fallback", () => {
    const tool = createApplyPatchTool()

    expect(tool).toMatchObject({
      toolName: { name: "apply_patch" },
      effect: "mutate",
      customInputFormat: { type: "grammar", syntax: "lark" },
      inputSchema: { required: ["patch"] },
    })
  })

  it("projects inexact deltas into the durable file-change descriptor", () => {
    const tool = createApplyPatchTool()
    const completed = tool.completeExecution?.(
      {
        type: "file_change",
        request: { operation: "apply_patch", paths: ["destination.txt"] },
        changes: [],
      },
      {
        changes: [
          {
            path: "destination.txt",
            kind: "move",
            sha256: "a".repeat(64),
          },
        ],
        fileObservations: [
          {
            path: "destination.txt",
            kind: "invalidate",
            complete: true,
          },
        ],
        deltaExact: false,
      },
      false,
    )

    expect(completed).toMatchObject({
      type: "file_change",
      exact: false,
      changes: [{ path: "destination.txt", kind: "update" }],
    })
  })

  it("adds, updates, moves, and deletes files from one patch", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "update.txt"), "alpha\nbeta\ngamma\n")
    await writeFile(join(root, "move.txt"), "before\n")
    await writeFile(join(root, "delete.txt"), "gone\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      `*** Begin Patch
*** Add File: added.txt
+new
*** Update File: update.txt
@@
 alpha
-beta
+changed
 gamma
*** Update File: move.txt
*** Move to: moved.txt
@@
-before
+after
*** Delete File: delete.txt
*** End Patch`,
      { workspaceRoot: root },
    )

    expect(result.ok).toBe(true)
    await expect(readFile(join(root, "added.txt"), "utf8")).resolves.toBe(
      "new\n",
    )
    await expect(readFile(join(root, "update.txt"), "utf8")).resolves.toBe(
      "alpha\nchanged\ngamma\n",
    )
    await expect(readFile(join(root, "moved.txt"), "utf8")).resolves.toBe(
      "after\n",
    )
    await expect(readFile(join(root, "move.txt"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, "delete.txt"), "utf8")).rejects.toThrow()
  })

  it("accepts the function fallback and preserves CRLF", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      {
        patch: `*** Begin Patch
*** Update File: crlf.txt
@@
 one
-two
+second
*** End of File
*** End Patch`,
      },
      { workspaceRoot: root },
    )

    expect(result.ok).toBe(true)
    await expect(readFile(join(root, "crlf.txt"), "utf8")).resolves.toBe(
      "one\r\nsecond\r\n",
    )
  })

  it("fails without changing a file when context does not match", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "file.txt"), "current\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      `*** Begin Patch
*** Update File: file.txt
@@
-stale
+changed
*** End Patch`,
      { workspaceRoot: root },
    )

    expect(result).toMatchObject({
      ok: false,
      code: "patch_context_mismatch",
    })
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe(
      "current\n",
    )
  })

  it("rejects malformed framing and duplicate path mutations", async () => {
    const root = await temporaryDirectory()
    const tool = createApplyPatchTool()

    await expect(
      tool.execute("*** Add File: x.txt\n+x", { workspaceRoot: root }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_tool_input" })
    await expect(
      tool.execute(
        `*** Begin Patch
*** Add File: x.txt
+one
*** Delete File: x.txt
*** End Patch`,
        { workspaceRoot: root },
      ),
    ).resolves.toMatchObject({ ok: false, code: "duplicate_patch_path" })
  })

  it("preserves applied changes when a later action fails", async () => {
    const root = await temporaryDirectory()
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      `*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
      { workspaceRoot: root },
    )

    expect(result).toMatchObject({
      ok: false,
      output: {
        changes: [{ path: "created.txt", kind: "add" }],
        fileObservations: [{ path: "created.txt", kind: "write" }],
      },
    })
    await expect(readFile(join(root, "created.txt"), "utf8")).resolves.toBe(
      "hello\n",
    )
  })

  it("appends pure additions and starts named-context chunks after the marker", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "file.txt"), "section\nold\nsection\nlater\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      `*** Begin Patch
*** Update File: file.txt
@@ section
-later
+changed
@@
+tail
*** End Patch`,
      { workspaceRoot: root },
    )

    expect(result.ok).toBe(true)
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe(
      "section\nold\nsection\nchanged\ntail\n",
    )
  })

  it("preserves mixed line endings and accepts padded markers", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "mixed.txt"), "one\r\ntwo\rthree\nfour\r\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      ` *** Begin Patch 
  *** Update File: mixed.txt
@@
 one
 two
-three
+THREE
 four
 *** End Patch `,
      { workspaceRoot: root },
    )

    expect(result.ok).toBe(true)
    await expect(readFile(join(root, "mixed.txt"), "utf8")).resolves.toBe(
      "one\r\ntwo\rTHREE\r\nfour\r\n",
    )
  })

  it("overwrites Add and Move destinations and creates move parents", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "duplicate.txt"), "old\n")
    await writeFile(join(root, "source.txt"), "from\n")
    const tool = createApplyPatchTool()

    const result = await tool.execute(
      `*** Begin Patch
*** Add File: duplicate.txt
+new
*** Update File: source.txt
*** Move to: nested/destination.txt
@@
-from
+moved
*** End Patch`,
      { workspaceRoot: root },
    )

    expect(result.ok).toBe(true)
    await expect(readFile(join(root, "duplicate.txt"), "utf8")).resolves.toBe(
      "new\n",
    )
    await expect(
      readFile(join(root, "nested/destination.txt"), "utf8"),
    ).resolves.toBe("moved\n")
  })

  it("rejects lexical path aliases as duplicate mutations", async () => {
    const root = await temporaryDirectory()
    const tool = createApplyPatchTool()

    await expect(
      tool.execute(
        `*** Begin Patch
*** Add File: aliases.txt
+value
*** Delete File: ./aliases.txt
*** End Patch`,
        { workspaceRoot: root },
      ),
    ).resolves.toMatchObject({ ok: false, code: "duplicate_patch_path" })
  })

  it("rejects missing child aliases through a symlink parent", async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, "real"))
    await symlink(join(root, "real"), join(root, "link"), "dir")
    const tool = createApplyPatchTool()

    await expect(
      tool.execute(
        `*** Begin Patch
*** Add File: link/new.txt
+value
*** Delete File: real/new.txt
*** End Patch`,
        { workspaceRoot: root },
      ),
    ).resolves.toMatchObject({ ok: false, code: "duplicate_patch_path" })
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "yakitori-apply-patch-"))
  temporaryDirectories.push(path)
  return path
}
