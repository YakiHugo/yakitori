import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { JsonValue } from "../../../src/kernel/events.ts"
import { createEditFileTool } from "../../../src/runtime/tools/edit-file.ts"
import { resolveWorkspaceRoot } from "../../../src/runtime/tools/path-policy.ts"
import { createReadFileTool } from "../../../src/runtime/tools/read-file.ts"
import { createToolRegistry } from "../../../src/runtime/tools/registry.ts"
import { compareAndWriteTextFile } from "../../../src/runtime/tools/text-file-write.ts"
import {
  createVisibleFileObservations,
  type FileObservationGrant,
  grantsFromToolOutput,
} from "../../../src/runtime/tools/visible-file-observations.ts"
import { createWriteFileTool } from "../../../src/runtime/tools/write-file.ts"

describe("bounded file tools", () => {
  it("creates new files and derives overwrite revisions from visible observations", async () => {
    await withWorkspace(async (workspace) => {
      const write = createWriteFileTool()

      const created = await write.execute(
        { path: "new.txt", content: "hello" },
        { workspaceRoot: workspace },
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.output).toMatchObject({
        previousSha256: null,
        created: true,
        diff: {
          format: "unified",
          text: expect.stringContaining("+++ b/new.txt"),
          truncated: false,
        },
      })

      const observed = observedContext(workspace, "new.txt", "hello")
      await writeFile(join(workspace, "new.txt"), "external")
      const stale = await write.execute(
        { path: "new.txt", content: "stale" },
        observed,
      )
      expect(stale.ok).toBe(false)
      if (stale.ok) return
      expect(stale).toMatchObject({
        code: "stale_sha256",
        output: {
          currentSha256: sha256("external"),
          suggestion: "Read the file again before retrying the write.",
        },
      })
      expect(stale.content).toBe(
        "stale_sha256: The file changed since it was observed.\nSuggestion: Read the file again before retrying the write.",
      )

      await writeFile(join(workspace, "new.txt"), "hello")
      const updated = await write.execute(
        { path: "new.txt", content: "updated" },
        observed,
      )
      expect(updated.ok).toBe(true)
      if (!updated.ok) return
      expect(updated.output).toMatchObject({
        previousSha256: sha256("hello"),
        created: false,
      })
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("updated")
    })
  })

  it("allows an intentional overwrite and checks the revision from a live page", async () => {
    await withWorkspace(async (workspace) => {
      const path = "revision.txt"
      const write = createWriteFileTool()
      const read = createReadFileTool()
      const bareContext = { workspaceRoot: workspace }
      await writeFile(join(workspace, path), "before")
      expect(
        await write.execute({ path, content: "one\ntwo\n" }, bareContext),
      ).toMatchObject({
        ok: true,
        output: { previousSha256: sha256("before"), created: false },
      })

      const first = await read.execute({ path, limit: 1 }, bareContext)
      if (!first.ok) throw new Error(first.content)
      const context = {
        ...bareContext,
        visibleFileObservations: observeToolOutputs(first.output),
      }
      await writeFile(join(workspace, path), "one\nexternal\n")
      expect(
        await write.execute({ path, content: "stale" }, context),
      ).toMatchObject({
        ok: false,
        code: "stale_sha256",
      })
      expect(await readFile(join(workspace, path), "utf8")).toBe(
        "one\nexternal\n",
      )

      const fresh = await read.execute({ path, limit: 1 }, bareContext)
      if (!fresh.ok) throw new Error(fresh.content)
      const freshContext = {
        ...bareContext,
        visibleFileObservations: observeToolOutputs(first.output, fresh.output),
      }
      expect(
        await write.execute({ path, content: "after" }, freshContext),
      ).toMatchObject({ ok: true })
      expect(await readFile(join(workspace, path), "utf8")).toBe("after")
    })
  })

  it("leaves deleted parent directories absent when an observed overwrite is stale", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const path = "nested/parent/file.txt"
      await mkdir(join(workspaceRoot, "nested", "parent"), { recursive: true })
      await writeFile(join(workspaceRoot, path), "before")
      const read = await createReadFileTool().execute(
        { path },
        { workspaceRoot },
      )
      if (!read.ok) throw new Error(read.content)
      await rm(join(workspaceRoot, "nested"), { recursive: true })
      const result = await createWriteFileTool().execute(
        { path, content: "after" },
        {
          workspaceRoot,
          visibleFileObservations: observeToolOutputs(read.output),
        },
      )
      expect(result).toMatchObject({ ok: false, code: "file_missing" })
      await expect(stat(join(workspaceRoot, "nested"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    })
  })

  it.skipIf(process.platform === "win32")(
    "requires a fresh read when an observed symlink points to a new file",
    async () => {
      await withWorkspace(async (workspaceRoot) => {
        const path = "alias.txt"
        await writeFile(join(workspaceRoot, "first.txt"), "shared anchor")
        await writeFile(join(workspaceRoot, "second.txt"), "shared anchor")
        await symlink("first.txt", join(workspaceRoot, path))
        const read = createReadFileTool()
        const observed = await read.execute({ path }, { workspaceRoot })
        if (!observed.ok) throw new Error(observed.content)
        const context = {
          workspaceRoot,
          visibleFileObservations: observeToolOutputs(observed.output),
        }
        await rm(join(workspaceRoot, path))
        await symlink("second.txt", join(workspaceRoot, path))
        const write = createWriteFileTool()
        const edit = createEditFileTool()
        await expect(
          write.execute({ path, content: "unchecked overwrite" }, context),
        ).resolves.toMatchObject({
          ok: false,
          code: "path_changed",
        })
        await expect(
          edit.execute(
            {
              path,
              oldString: "shared",
              newString: "unsafe",
              replaceAll: true,
            },
            context,
          ),
        ).resolves.toMatchObject({
          ok: false,
          code: "path_changed",
        })
        expect(await readFile(join(workspaceRoot, "second.txt"), "utf8")).toBe(
          "shared anchor",
        )

        const refreshed = await read.execute({ path }, context)
        if (!refreshed.ok) throw new Error(refreshed.content)
        for (const grant of grantsFromToolOutput(refreshed.output))
          context.visibleFileObservations.apply(grant)
        await expect(
          write.execute({ path, content: "checked overwrite" }, context),
        ).resolves.toMatchObject({ ok: true })
        expect(await readFile(join(workspaceRoot, "second.txt"), "utf8")).toBe(
          "checked overwrite",
        )
        expect(await readFile(join(workspaceRoot, "first.txt"), "utf8")).toBe(
          "shared anchor",
        )
      })
    },
  )

  it.skipIf(process.platform === "win32")(
    "separates a literal backslash filename from a directory path",
    async () => {
      await withWorkspace(async (workspaceRoot) => {
        const path = "nested/file.txt"
        const literal = "nested\\file.txt"
        await mkdir(join(workspaceRoot, "nested"))
        await writeFile(join(workspaceRoot, path), "old\n")
        const read = createReadFileTool()
        const original = await read.execute({ path }, { workspaceRoot })
        if (!original.ok) throw new Error(original.content)
        await writeFile(join(workspaceRoot, path), "external\ncontents\n")
        await writeFile(join(workspaceRoot, literal), "external\ncontents\n")
        const other = await read.execute(
          { path: literal, limit: 1 },
          { workspaceRoot },
        )
        if (!other.ok) throw new Error(other.content)
        const context = {
          workspaceRoot,
          visibleFileObservations: observeToolOutputs(
            original.output,
            other.output,
          ),
        }
        await expect(
          createWriteFileTool().execute(
            { path, content: "overwritten" },
            context,
          ),
        ).resolves.toMatchObject({
          ok: false,
          code: "stale_sha256",
        })
        expect(await readFile(join(workspaceRoot, path), "utf8")).toBe(
          "external\ncontents\n",
        )
      })
    },
  )

  it("creates nested paths and preserves filesystem identity for a byte-identical write", async () => {
    await withWorkspace(async (workspace) => {
      const path = "nested/folder/new.txt"
      const context = { workspaceRoot: workspace }
      const write = createWriteFileTool()
      expect(
        await write.execute({ path, content: "value" }, context),
      ).toMatchObject({
        ok: true,
        content: "Created nested/folder/new.txt (5 bytes).",
      })
      const before = await stat(join(workspace, path))
      expect(
        await write.execute({ path, content: "value" }, context),
      ).toMatchObject({
        ok: true,
        content: "Already up to date: nested/folder/new.txt.",
      })
      const after = await stat(join(workspace, path))
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    })
  })

  it("bounds inline unified diffs independently of file size", async () => {
    await withWorkspace(async (workspace) => {
      const before = `${"before\n".repeat(20_000)}`
      const after = `${"after\n".repeat(20_000)}`
      await writeFile(join(workspace, "large-diff.txt"), before)

      const result = await createWriteFileTool().execute(
        { path: "large-diff.txt", content: after },
        observedContext(workspace, "large-diff.txt", before),
      )

      expect(result).toMatchObject({
        ok: true,
        output: { diff: { format: "unified", truncated: true } },
      })
      if (!result.ok || !isObject(result.output)) return
      const diff = result.output.diff
      expect(
        isObject(diff) && Buffer.byteLength(String(diff.text), "utf8"),
      ).toBeLessThanOrEqual(64 * 1024)
    })
  })

  it("rejects unsupported edit and write arguments at runtime", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "strict.txt"), "before\n")
      expect(
        await createEditFileTool().execute(
          {
            path: "strict.txt",
            oldString: "before",
            newString: "after",
            expectedSha256: "a".repeat(64),
          },
          observedContext(workspace, "strict.txt", "before\n"),
        ),
      ).toMatchObject({ ok: false, code: "invalid_tool_input" })
      expect(
        await createWriteFileTool().execute(
          {
            path: "strict.txt",
            content: "after\n",
            replaceAll: true,
          },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({ ok: false, code: "invalid_tool_input" })
    })
  })

  it("applies one exact replacement against the latest observed revision", async () => {
    await withWorkspace(async (workspace) => {
      const before = "const value = 1\n"
      await writeFile(join(workspace, "value.ts"), before)
      const context = observedContext(workspace, "value.ts", before)

      const result = await createEditFileTool().execute(
        {
          path: "value.ts",
          oldString: "const value = 1",
          newString: "const value = 2",
        },
        context,
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.output).toMatchObject({
        previousSha256: sha256(before),
        replacementCount: 1,
        matchMode: "exact",
        optimisticRebase: false,
        observation: {
          kind: "whole_file_read",
          complete: true,
          editWithinObservedRanges: true,
        },
        diff: {
          format: "unified",
          text: expect.stringContaining("-const value = 1"),
          truncated: false,
        },
      })
      expect(await readFile(join(workspace, "value.ts"), "utf8")).toBe(
        "const value = 2\n",
      )
    })
  })

  it("creates files from an empty oldString and observes the authored content", async () => {
    await withWorkspace(async (workspace) => {
      const edit = createEditFileTool()
      const created = await edit.execute(
        {
          path: "created-by-edit.ts",
          oldString: "",
          newString: "const value = 1\n",
        },
        { workspaceRoot: workspace },
      )

      expect(created).toMatchObject({
        ok: true,
        output: {
          action: "create",
          path: "created-by-edit.ts",
          previousSha256: null,
          sha256: sha256("const value = 1\n"),
          byteCount: 16,
          created: true,
          diff: {
            format: "unified",
            text: expect.stringContaining("--- /dev/null"),
            truncated: false,
          },
        },
        content: "Created created-by-edit.ts (16 bytes).",
      })
      if (!created.ok) return
      expect(created.output).not.toHaveProperty("replacementCount")
      expect(created.output).not.toHaveProperty("matchMode")
      expect(created.output).not.toHaveProperty("observedSha256")
      expect(created.output).not.toHaveProperty("changedRanges")
      expect(created.output).not.toHaveProperty("optimisticRebase")

      const visibleFileObservations = observeToolOutputs(created.output)
      expect(visibleFileObservations.latest("created-by-edit.ts")).toEqual({
        sha256: sha256("const value = 1\n"),
        complete: true,
        observation: "edit",
      })

      const replaced = await edit.execute(
        {
          path: "created-by-edit.ts",
          oldString: "value = 1",
          newString: "value = 2",
        },
        {
          workspaceRoot: workspace,
          visibleFileObservations,
        },
      )
      expect(replaced).toMatchObject({ ok: true })
      expect(
        await readFile(join(workspace, "created-by-edit.ts"), "utf8"),
      ).toBe("const value = 2\n")
    })
  })

  it("creates an empty file but never overwrites an existing file", async () => {
    await withWorkspace(async (workspace) => {
      const edit = createEditFileTool()
      const empty = await edit.execute(
        { path: "empty.txt", oldString: "", newString: "" },
        { workspaceRoot: workspace },
      )
      expect(empty).toMatchObject({
        ok: true,
        output: { action: "create", created: true, byteCount: 0 },
      })
      expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("")

      for (const [path, content] of [
        ["empty.txt", ""],
        ["existing.txt", "original"],
      ] as const) {
        if (path === "existing.txt")
          await writeFile(join(workspace, path), content)
        const result = await edit.execute(
          { path, oldString: "", newString: "replacement" },
          { workspaceRoot: workspace },
        )
        expect(result).toMatchObject({
          ok: false,
          code: "file_exists",
          message: `Cannot create ${path} because the file already exists.`,
        })
        expect(result.content).toContain(
          "Use a non-empty oldString to edit the existing file.",
        )
        expect(await readFile(join(workspace, path), "utf8")).toBe(content)
      }
    })
  })

  it("validates empty-oldString creation semantics", async () => {
    await withWorkspace(async (workspace) => {
      const edit = createEditFileTool()
      expect(
        await edit.execute(
          {
            path: "all.txt",
            oldString: "",
            newString: "content",
            replaceAll: true,
          },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        message: "replaceAll cannot be used when oldString is empty.",
      })

      const missing = await edit.execute(
        {
          path: "missing.txt",
          oldString: "before",
          newString: "after",
        },
        { workspaceRoot: workspace },
      )
      expect(missing).toMatchObject({
        ok: false,
        code: "path_not_found",
        message: "Path does not exist.",
      })
      expect(missing.content).not.toContain("empty oldString")
    })
  })

  it("preserves similar-path diagnostics for a missing edit target", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "correct-name.txt"), "before")

      const result = await createEditFileTool().execute(
        {
          path: "corect-name.txt",
          oldString: "before",
          newString: "after",
        },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: false,
        code: "path_not_found",
      })
      if (result.ok) return
      expect(result.message).toContain('Did you mean "correct-name.txt"?')
      expect(result.content).toContain('Did you mean "correct-name.txt"?')
      expect(result.content).not.toContain("empty oldString")
      expect(await readFile(join(workspace, "correct-name.txt"), "utf8")).toBe(
        "before",
      )
    })
  })

  it("edits an unread file only through an exact unique current anchor", async () => {
    await withWorkspace(async (workspace) => {
      const before = "const value = 1\n"
      await writeFile(join(workspace, "observed.ts"), before)
      const edit = createEditFileTool()
      const request = {
        path: "observed.ts",
        oldString: "value = 1",
        newString: "value = 2",
      }

      const unread = await edit.execute(request, { workspaceRoot: workspace })
      expect(unread).toMatchObject({
        ok: true,
        output: {
          matchMode: "exact",
          replacementCount: 1,
          observedRevisionKnown: false,
        },
      })
      if (!unread.ok) return
      expect(unread.output).not.toHaveProperty("observation")
      expect(observeToolOutputs(unread.output).latest("observed.ts")).toEqual({
        complete: false,
        observation: "edit",
        sha256: sha256("const value = 2\n"),
      })
      expect(await readFile(join(workspace, "observed.ts"), "utf8")).toBe(
        "const value = 2\n",
      )

      const context = observedContext(workspace, "observed.ts", before)
      await writeFile(join(workspace, "observed.ts"), "const value = 3\n")
      expect(await edit.execute(request, context)).toMatchObject({
        ok: false,
        code: "file_changed_since_observation",
        output: {
          suggestion:
            "Read the file again and rebuild the edit from its latest contents.",
        },
      })
    })
  })

  it("requires an unambiguous unread anchor unless replaceAll is explicit", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, "unread.ts"),
        "const first = “hi”\nconst next = 1\nconst next = 1\n",
      )
      const edit = createEditFileTool()
      const context = { workspaceRoot: workspace }

      expect(
        await edit.execute(
          { path: "unread.ts", oldString: "missing", newString: "found" },
          context,
        ),
      ).toMatchObject({ ok: false, code: "old_string_not_found" })
      expect(
        await edit.execute(
          {
            path: "unread.ts",
            oldString: 'const first = "hi"',
            newString: 'const first = "bye"',
          },
          context,
        ),
      ).toMatchObject({ ok: false, code: "old_string_not_found" })
      expect(
        await edit.execute(
          {
            path: "unread.ts",
            oldString: "const next = 1",
            newString: "const next = 2",
          },
          context,
        ),
      ).toMatchObject({ ok: false, code: "old_string_ambiguous" })
      expect(
        await edit.execute(
          {
            path: "unread.ts",
            oldString: "const next = 1",
            newString: "const next = 2",
            replaceAll: true,
          },
          context,
        ),
      ).toMatchObject({ ok: true, output: { replacementCount: 2 } })
      expect(await readFile(join(workspace, "unread.ts"), "utf8")).toBe(
        "const first = “hi”\nconst next = 2\nconst next = 2\n",
      )
    })
  })

  it("uses an exact unique current anchor after a revisionless ranged read", async () => {
    await withWorkspace(async (workspace) => {
      const before = "first\ntarget = 1\nlast\n"
      await writeFile(join(workspace, "rebase.txt"), before)
      const visibleFileObservations = visibleReadObservation({
        path: "rebase.txt",
        complete: false,
        kind: "ranged_read",
        ranges: [{ startLine: 1, endLine: 1 }],
      })
      await writeFile(join(workspace, "rebase.txt"), `${before}external\n`)

      const result = await createEditFileTool().execute(
        {
          path: "rebase.txt",
          oldString: "target = 1",
          newString: "target = 2",
        },
        {
          workspaceRoot: workspace,
          visibleFileObservations,
        },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          optimisticRebase: false,
          observedRevisionKnown: false,
          changedRanges: [{ startLine: 2, endLine: 2 }],
          observation: {
            kind: "ranged_read",
            complete: false,
            editWithinObservedRanges: false,
          },
        },
      })
      expect(await readFile(join(workspace, "rebase.txt"), "utf8")).toBe(
        `${before.replace("target = 1", "target = 2")}external\n`,
      )
    })
  })

  it("keeps exact-only matching after an edit advances a ranged observation", async () => {
    await withWorkspace(async (workspace) => {
      const path = "ranged-edits.ts"
      const before = "const count = 1\nconst message = “hello”\n"
      await writeFile(join(workspace, path), before)
      const edit = createEditFileTool()
      const rangedRead: FileObservationGrant = {
        path,
        complete: false,
        kind: "ranged_read",
        ranges: [{ startLine: 1, endLine: 1 }],
      }
      const first = await edit.execute(
        {
          path,
          oldString: "const count = 1",
          newString: "const count = 2",
        },
        {
          workspaceRoot: workspace,
          visibleFileObservations: visibleReadObservation(rangedRead),
        },
      )
      expect(first).toMatchObject({ ok: true })
      if (!first.ok) return

      const visibleFileObservations = visibleReadObservation(rangedRead)
      for (const grant of grantsFromToolOutput(first.output)) {
        visibleFileObservations.apply(grant)
      }
      expect(visibleFileObservations.latest(path)).toMatchObject({
        complete: false,
        sha256: expect.any(String),
      })
      const second = await edit.execute(
        {
          path,
          oldString: 'const message = "hello"',
          newString: 'const message = "goodbye"',
        },
        { workspaceRoot: workspace, visibleFileObservations },
      )

      expect(second).toMatchObject({
        ok: false,
        code: "old_string_not_found",
      })
      expect(await readFile(join(workspace, path), "utf8")).toBe(
        before.replace("count = 1", "count = 2"),
      )
    })
  })

  it("uses only deterministic quote, line-ending, and trailing-whitespace equivalence", async () => {
    await withWorkspace(async (workspace) => {
      const before =
        "function greeting() {\r\n  const value = “hello”;  \r\n  return value;\r\n}\r\n"
      await writeFile(join(workspace, "greeting.ts"), before)
      const context = observedContext(workspace, "greeting.ts", before)

      const result = await createEditFileTool().execute(
        {
          path: "greeting.ts",
          oldString: '  const value = "hello";\n  return value;',
          newString: '  const value = "goodbye";\n  return value;',
        },
        context,
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.output).toMatchObject({
        replacementCount: 1,
        matchMode: "curly_quotes_and_trailing_whitespace",
      })
      expect(await readFile(join(workspace, "greeting.ts"), "utf8")).toBe(
        "function greeting() {\r\n  const value = “goodbye”;\r\n  return value;\r\n}\r\n",
      )
    })
  })

  it("adapts replacement newlines even when oldString matches exactly", async () => {
    await withWorkspace(async (workspace) => {
      const before = "alpha\r\nomega\r\n"
      await writeFile(join(workspace, "windows.txt"), before)

      const result = await createEditFileTool().execute(
        {
          path: "windows.txt",
          oldString: "alpha",
          newString: "alpha\nbeta",
        },
        observedContext(workspace, "windows.txt", before),
      )

      expect(result).toMatchObject({
        ok: true,
        output: { matchMode: "exact", replacementCount: 1 },
      })
      expect(await readFile(join(workspace, "windows.txt"), "utf8")).toBe(
        "alpha\r\nbeta\r\nomega\r\n",
      )
    })
  })

  it("preserves CR-only replacement line endings", async () => {
    await withWorkspace(async (workspace) => {
      const before = "alpha\romega\r"
      await writeFile(join(workspace, "classic-mac.txt"), before)
      const result = await createEditFileTool().execute(
        {
          path: "classic-mac.txt",
          oldString: "alpha",
          newString: "alpha\nbeta",
        },
        observedContext(workspace, "classic-mac.txt", before),
      )
      expect(result).toMatchObject({ ok: true })
      expect(await readFile(join(workspace, "classic-mac.txt"), "utf8")).toBe(
        "alpha\rbeta\romega\r",
      )
    })
  })

  it("does not normalize whitespace inside quoted text", async () => {
    await withWorkspace(async (workspace) => {
      const before = 'const value = "hello  world"\n'
      await writeFile(join(workspace, "literal.ts"), before)
      const context = observedContext(workspace, "literal.ts", before)

      const result = await createEditFileTool().execute(
        {
          path: "literal.ts",
          oldString: 'const value = "hello world"',
          newString: 'const value = "goodbye world"',
        },
        context,
      )

      expect(result).toMatchObject({
        ok: false,
        code: "old_string_not_found",
      })
      expect(await readFile(join(workspace, "literal.ts"), "utf8")).toBe(before)
    })
  })

  it("returns bounded closest candidates when oldString is not found", async () => {
    await withWorkspace(async (workspace) => {
      const before = [
        "function alpha() {",
        '  return "old"',
        "}",
        "function beta() {",
        '  return "current"',
        "}",
        "",
      ].join("\n")
      await writeFile(join(workspace, "candidate.ts"), before)

      const result = await createEditFileTool().execute(
        {
          path: "candidate.ts",
          oldString: 'function beta() {\n  return "stale"\n}',
          newString: 'function beta() {\n  return "updated"\n}',
        },
        observedContext(workspace, "candidate.ts", before),
      )

      expect(result).toMatchObject({
        ok: false,
        code: "old_string_not_found",
        output: {
          nearMatches: expect.any(Array),
        },
      })
      if (result.ok) return
      const output = result.output as { nearMatches: unknown[] }
      expect(output.nearMatches).toHaveLength(2)
      expect(output.nearMatches[0]).toEqual({
        startLine: 4,
        endLine: 6,
        score: 4,
        text: '  4| function beta() {\n  5|   return "current"\n  6| }',
      })
      expect(result.content).toContain("Near matches:")
      expect(await readFile(join(workspace, "candidate.ts"), "utf8")).toBe(
        before,
      )
    })
  })

  it("does not broaden quote delimiters or indentation in any file format", async () => {
    await withWorkspace(async (workspace) => {
      const python = 'message = "hello"\n'
      await writeFile(join(workspace, "script.py"), python)
      const context = observedContext(workspace, "script.py", python)

      const result = await createEditFileTool().execute(
        {
          path: "script.py",
          oldString: "message = 'hello'",
          newString: "message = 'goodbye'",
        },
        context,
      )

      expect(result).toMatchObject({
        ok: false,
        code: "old_string_not_found",
      })
      expect(await readFile(join(workspace, "script.py"), "utf8")).toBe(python)

      const yaml = "items:\n  - one\n"
      await writeFile(join(workspace, "config.yaml"), yaml)
      const yamlResult = await createEditFileTool().execute(
        {
          path: "config.yaml",
          oldString: "items:\n    - one",
          newString: "items:\n    - two",
        },
        observedContext(workspace, "config.yaml", yaml),
      )
      expect(yamlResult).toMatchObject({
        ok: false,
        code: "old_string_not_found",
      })
      expect(await readFile(join(workspace, "config.yaml"), "utf8")).toBe(yaml)
    })
  })

  it("rejects ambiguous oldString values without changing the file", async () => {
    await withWorkspace(async (workspace) => {
      const repeated = "const value = 1\nconst value = 1\n"
      const edit = createEditFileTool()
      await writeFile(join(workspace, "ambiguous.ts"), repeated)
      const context = observedContext(workspace, "ambiguous.ts", repeated)

      const ambiguous = await edit.execute(
        {
          path: "ambiguous.ts",
          oldString: "const value = 1",
          newString: "const value = 2",
        },
        context,
      )
      expect(ambiguous).toMatchObject({
        ok: false,
        code: "old_string_ambiguous",
        output: {
          matchCount: 2,
          locations: [
            {
              startLine: 1,
              endLine: 1,
            },
            {
              startLine: 2,
              endLine: 2,
            },
          ],
        },
      })
      expect(await readFile(join(workspace, "ambiguous.ts"), "utf8")).toBe(
        repeated,
      )
    })
  })

  it("rejects bulk expansion before materializing the replacement file", async () => {
    await withWorkspace(async (workspace) => {
      const path = "repeat.txt"
      const before = "x".repeat(32768)
      await writeFile(join(workspace, path), before)
      const result = await createEditFileTool().execute(
        {
          path,
          oldString: "x",
          newString: "y".repeat(32768),
          replaceAll: true,
        },
        observedContext(workspace, path, before),
      )
      expect(result).toMatchObject({ ok: false, code: "content_too_large" })
      expect(await readFile(join(workspace, path), "utf8")).toBe(before)
    })
  })

  it("bounds the UTF-8 result of replaceAll including untouched text", async () => {
    await withWorkspace(async (workspace) => {
      const path = "text.txt"
      const before = "x-x!"
      await writeFile(join(workspace, path), before)
      const context = observedContext(workspace, path, before)
      const input = { path, oldString: "x", newString: "界", replaceAll: true }
      expect(await createEditFileTool(7).execute(input, context)).toMatchObject(
        {
          ok: false,
          code: "content_too_large",
        },
      )
      expect(await readFile(join(workspace, path), "utf8")).toBe(before)
      expect(await createEditFileTool(8).execute(input, context)).toMatchObject(
        { ok: true },
      )
      expect(await readFile(join(workspace, path), "utf8")).toBe("界-界!")
    })
  })

  it("supports explicit replaceAll and rejects files changed since observation", async () => {
    await withWorkspace(async (workspace) => {
      const before = "enabled = false\nenabled = false\n"
      const edit = createEditFileTool()
      await writeFile(join(workspace, "flags.txt"), before)
      const context = observedContext(workspace, "flags.txt", before)

      await writeFile(
        join(workspace, "flags.txt"),
        `${before}external = true\n`,
      )
      const stale = await edit.execute(
        {
          path: "flags.txt",
          oldString: "enabled = false",
          newString: "enabled = true",
          replaceAll: true,
        },
        context,
      )
      expect(stale).toMatchObject({
        ok: false,
        code: "file_changed_since_observation",
        output: {
          suggestion:
            "Read the file again and rebuild the edit from its latest contents.",
        },
      })

      await writeFile(join(workspace, "flags.txt"), before)
      const replaced = await edit.execute(
        {
          path: "flags.txt",
          oldString: "enabled = false",
          newString: "enabled = true",
          replaceAll: true,
        },
        context,
      )
      expect(replaced).toMatchObject({
        ok: true,
        output: { replacementCount: 2 },
      })
      expect(await readFile(join(workspace, "flags.txt"), "utf8")).toBe(
        "enabled = true\nenabled = true\n",
      )
    })
  })

  it("edits a BOM first line from a live LF page and preserves local mixed endings", async () => {
    await withWorkspace(async (workspace) => {
      const path = "mixed.txt"
      const body = "\uFEFFalpha\r\nbeta\nlast\n"
      await writeFile(join(workspace, path), body)
      const read = await createReadFileTool().execute(
        { path, limit: 2 },
        { workspaceRoot: workspace },
      )
      if (!read.ok) throw new Error(read.content)
      expect(read.content).toContain("1\talpha\n\tbeta")
      const context = {
        workspaceRoot: workspace,
        visibleFileObservations: observeToolOutputs(read.output),
      }
      await writeFile(join(workspace, path), `${body}externally appended\n`)
      expect(
        await createEditFileTool().execute(
          {
            path,
            oldString: "alpha\nbeta\n",
            newString: "first\nsecond\n",
          },
          context,
        ),
      ).toMatchObject({
        ok: true,
        output: { matchMode: "line_endings", optimisticRebase: true },
      })
      expect(await readFile(join(workspace, path), "utf8")).toBe(
        "\uFEFFfirst\r\nsecond\nlast\nexternally appended\n",
      )
    })
  })

  it("rejects an overlapping stale anchor while bulk replacement consumes each match once", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const path = "overlap.txt"
      const old = "a\r\nb\r\na\r\n"
      const current = "a\r\nb\r\na\r\nb\r\na\r\n"
      await writeFile(join(workspaceRoot, path), current)
      const edit = createEditFileTool()
      const input = { path, oldString: "a\nb\na", newString: "replaced" }
      await expect(
        edit.execute(input, observedContext(workspaceRoot, path, old)),
      ).resolves.toMatchObject({
        ok: false,
        code: "file_changed_since_observation",
      })
      expect(await readFile(join(workspaceRoot, path), "utf8")).toBe(current)
      await expect(
        edit.execute({ ...input, replaceAll: true }, { workspaceRoot }),
      ).resolves.toMatchObject({
        ok: true,
        output: { replacementCount: 1 },
      })
      expect(await readFile(join(workspaceRoot, path), "utf8")).toBe(
        "replaced\r\nb\r\na\r\n",
      )
    })
  })

  it("counts LF and CRLF anchors together for uniqueness and replaceAll", async () => {
    await withWorkspace(async (workspace) => {
      const path = "duplicates.txt"
      await writeFile(join(workspace, path), "a\nb\na\r\nb\r\n")
      const context = { workspaceRoot: workspace }
      const edit = createEditFileTool()
      const input = { path, oldString: "a\nb", newString: "x\ny" }
      expect(await edit.execute(input, context)).toMatchObject({
        ok: false,
        code: "old_string_ambiguous",
      })
      expect(
        await edit.execute({ ...input, replaceAll: true }, context),
      ).toMatchObject({
        ok: true,
        output: { replacementCount: 2 },
      })
      expect(await readFile(join(workspace, path), "utf8")).toBe(
        "x\ny\nx\r\ny\r\n",
      )
    })
  })

  it("explains failed matches with evidence from the current file", async () => {
    await withWorkspace(async (workspace) => {
      const path = "mismatch.txt"
      const body =
        "  steps: alpha–beta\n  second\nconst replacement = alreadyHere;\n"
      await writeFile(join(workspace, path), body)
      const edit = createEditFileTool()
      const context = { workspaceRoot: workspace }
      for (const [oldString, newString, diagnostic] of [
        [
          "    steps: alpha–beta\n    second",
          "changed",
          "indentation_mismatch",
        ],
        ["steps: alpha-beta", "changed", "unicode_punctuation_mismatch"],
        [
          "previous definition",
          "const replacement = alreadyHere;",
          "already_applied",
        ],
      ] as const) {
        const result = await edit.execute(
          { path, oldString, newString },
          context,
        )
        expect(result).toMatchObject({
          ok: false,
          code: "old_string_not_found",
          output: { diagnostic },
        })
        if (diagnostic === "unicode_punctuation_mismatch") {
          expect(result).toMatchObject({
            output: { locations: [{ startLine: 1, endLine: 1 }] },
          })
        }
      }
      expect(await readFile(join(workspace, path), "utf8")).toBe(body)
    })
  })

  it("preflights all batch edits and records each committed file", async () => {
    await withWorkspace(async (workspace) => {
      const edit = createEditFileTool()
      const context = { workspaceRoot: workspace }
      await writeFile(join(workspace, "a.txt"), "alpha\n")
      const entries = [
        { path: "nested/b.txt", oldString: "", newString: "beta\n" },
        { path: "a.txt", oldString: "alpha", newString: "first" },
        { path: "nested/b.txt", oldString: "beta", newString: "second" },
      ]
      const invalid = {
        edits: [
          ...entries,
          { path: "a.txt", oldString: "missing", newString: "invalid" },
        ],
      }
      expect(await edit.execute(invalid, context)).toMatchObject({
        ok: false,
        code: "old_string_not_found",
      })
      await expect(stat(join(workspace, "nested"))).rejects.toMatchObject({
        code: "ENOENT",
      })
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("alpha\n")

      const input = { edits: entries }
      expect(
        typeof edit.approvalRequirement === "function" &&
          (await edit.approvalRequirement(input, context)),
      ).toMatchObject({
        subject: "nested/b.txt, a.txt",
      })
      const start = edit.describeExecution?.(input)
      expect(start).toMatchObject({
        request: { paths: ["nested/b.txt", "a.txt"] },
      })
      const result = await edit.execute(input, context)
      if (!result.ok || start === undefined) throw new Error(result.content)
      expect(
        edit.completeExecution?.(start, result.output, true),
      ).toMatchObject({
        changes: [
          { path: "nested/b.txt", kind: "add" },
          { path: "a.txt", kind: "update" },
        ],
      })
      expect(grantsFromToolOutput(result.output)).toMatchObject([
        { path: "nested/b.txt", kind: "edit", sha256: sha256("second\n") },
        { path: "a.txt", kind: "edit", sha256: sha256("first\n") },
      ])
      expect(await readFile(join(workspace, "nested/b.txt"), "utf8")).toBe(
        "second\n",
      )
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("first\n")
    })
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports committed edits when a later file cannot be written",
    async () => {
      await withWorkspace(async (workspaceRoot) => {
        const blocked = join(workspaceRoot, "blocked")
        await mkdir(blocked)
        await writeFile(join(workspaceRoot, "a.txt"), "before")
        await writeFile(join(blocked, "b.txt"), "before")
        await chmod(blocked, 0o500)
        try {
          const edit = createEditFileTool()
          const input = {
            edits: [
              { path: "a.txt", oldString: "before", newString: "first" },
              {
                path: "blocked/b.txt",
                oldString: "before",
                newString: "second",
              },
            ],
          }
          const started = edit.describeExecution?.(input)
          const result = await edit.execute(input, { workspaceRoot })
          expect(result).toMatchObject({
            ok: false,
            code: "write_failed",
            content: expect.stringContaining("blocked/b.txt"),
          })
          if (started === undefined || result.output === undefined)
            throw new Error("Missing file changes")
          expect(
            edit.completeExecution?.(started, result.output, false),
          ).toMatchObject({
            changes: [{ path: "a.txt", kind: "update" }],
          })
          expect(grantsFromToolOutput(result.output)).toMatchObject([
            { path: "a.txt", sha256: sha256("first") },
          ])
          expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe(
            "first",
          )
          expect(await readFile(join(blocked, "b.txt"), "utf8")).toBe("before")
        } finally {
          await chmod(blocked, 0o700)
        }
      })
    },
  )

  it("returns a match diagnostic for long anchors that exceed the normalization engine's capacity", async () => {
    await withWorkspace(async (workspace) => {
      const path = "long.txt"
      const body = "x".repeat(100_000)
      await writeFile(join(workspace, path), body)
      const result = await createEditFileTool().execute(
        { path, oldString: `${body}q`, newString: "replacement" },
        observedContext(workspace, path, body),
      )
      expect(result).toMatchObject({ ok: false, code: "old_string_not_found" })
    })
  })

  it("serializes overlapping batches with reversed file order", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.txt"), "start a")
      await writeFile(join(workspace, "b.txt"), "start b")
      const edit = createEditFileTool()
      const results = await Promise.all(
        ["first", "second"].map((value, index) => {
          const edits = ["a", "b"].map((name) => ({
            path: `${name}.txt`,
            oldString: `start ${name}`,
            newString: `${value} ${name}`,
          }))
          return edit.execute(
            { edits: index === 0 ? edits : edits.reverse() },
            { workspaceRoot: workspace },
          )
        }),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      const winner = results[0]?.ok ? "first" : "second"
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        `${winner} a`,
      )
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe(
        `${winner} b`,
      )
    })
  })

  it("registers edit_file in the default model toolset", async () => {
    const registry = createToolRegistry()
    const router = registry.finalize({
      enabledTrustedTools: new Set(registry.trustedToolNames()),
      customToolMode: "function",
      wireProtocol: "eager",
    })
    const { definitions } = router
    expect(definitions.map((tool) => tool.name)).toEqual([
      "read_file",
      "view_image",
      "read_document",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "web_fetch",
      "web_search",
      "request_user_input_async",
      "update_plan",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "create_thread",
      "list_threads",
      "read_thread",
      "send_message_to_thread",
      "wait_threads",
      "tool_search",
    ])
    expect(router.deferredDefinitions.map((tool) => tool.name)).toEqual([
      "run_script",
    ])
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema,
    ).toMatchObject({
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
        edits: {
          type: "array",
          items: { required: ["path", "oldString", "newString"] },
        },
      },
    })
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema
        .properties,
    ).not.toHaveProperty("expectedSha256")
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema,
    ).not.toHaveProperty("properties.oldString.minLength")
    expect(
      definitions.find((tool) => tool.name === "write_file")?.inputSchema,
    ).toMatchObject({
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    })
    expect(
      definitions.find((tool) => tool.name === "write_file")?.inputSchema
        .properties,
    ).not.toHaveProperty("expectedSha256")

    for (const definition of definitions) {
      expect(definition.description.trim().length).toBeGreaterThan(0)
      const properties = definition.inputSchema.properties
      expect(isObject(properties)).toBe(true)
      if (!isObject(properties)) continue
      for (const property of Object.values(properties)) {
        expect(isObject(property)).toBe(true)
        if (!isObject(property)) continue
        expect(property.description).toEqual(expect.any(String))
        expect(String(property.description).trim().length).toBeGreaterThan(0)
      }
    }
    await router.release()
    await registry.dispose()
  })

  it("accepts absolute paths and symlinks outside the workspace", async () => {
    await withWorkspace(async (workspace) => {
      const outside = await mkdtemp(join(tmpdir(), "yakitori-outside-"))
      try {
        await writeFile(join(outside, "secret.txt"), "secret")
        const canonicalOutside = await realpath(outside)
        await symlink(outside, join(workspace, "link"))
        const read = createReadFileTool()
        const write = createWriteFileTool()

        const edit = createEditFileTool()
        const absoluteRead = await read.execute(
          { path: join(outside, "secret.txt") },
          { workspaceRoot: workspace },
        )
        expect(absoluteRead).toMatchObject({
          ok: true,
          output: { path: join(canonicalOutside, "secret.txt") },
          content: expect.stringContaining("secret"),
        })
        const symlinkRead = await read.execute(
          { path: "link/secret.txt" },
          { workspaceRoot: workspace },
        )
        expect(symlinkRead).toMatchObject({
          ok: true,
          output: { path: join(canonicalOutside, "secret.txt") },
        })
        const created = await edit.execute(
          {
            path: join(outside, "created.txt"),
            oldString: "",
            newString: "approved",
          },
          { workspaceRoot: workspace },
        )
        expect(created).toMatchObject({
          ok: true,
          output: {
            path: join(canonicalOutside, "created.txt"),
            created: true,
          },
        })
        await expect(
          readFile(join(outside, "created.txt"), "utf8"),
        ).resolves.toBe("approved")
        const written = await write.execute(
          { path: join(outside, "written.txt"), content: "written" },
          { workspaceRoot: workspace },
        )
        expect(written).toMatchObject({
          ok: true,
          output: {
            path: join(canonicalOutside, "written.txt"),
            created: true,
          },
        })
        expect(
          await edit.execute(
            { path: ".env.local", oldString: "", newString: "secret" },
            { workspaceRoot: workspace },
          ),
        ).toMatchObject({ ok: true, output: { created: true } })
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it("canonicalizes new-file paths and accepts in-workspace parent segments", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "actual"))
      await symlink(join(workspace, "actual"), join(workspace, "alias"))
      const created = await createEditFileTool().execute(
        {
          path: "alias/created.ts",
          oldString: "",
          newString: "created\n",
        },
        { workspaceRoot: workspace },
      )
      expect(created).toMatchObject({
        ok: true,
        output: {
          path: "actual/created.ts",
          fileObservation: { path: "actual/created.ts" },
        },
      })

      const dotted = await createEditFileTool().execute(
        {
          path: "actual/./second.ts",
          oldString: "",
          newString: "second\n",
        },
        { workspaceRoot: workspace },
      )
      expect(dotted).toMatchObject({
        ok: true,
        output: { path: "actual/second.ts" },
      })

      const read = await createReadFileTool().execute(
        { path: "alias/../actual/created.ts" },
        { workspaceRoot: workspace },
      )
      expect(read).toMatchObject({
        ok: true,
        output: {
          path: "actual/created.ts",
          content: expect.stringContaining("created"),
        },
      })
    })
  })

  it("keeps read content bounded without exposing a clipped revision", async () => {
    await withWorkspace(async (workspace) => {
      const body = "界".repeat(400_000)
      await writeFile(join(workspace, "large.txt"), body)
      const result = await createReadFileTool(64).execute(
        { path: "large.txt" },
        { workspaceRoot: workspace },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.output).toMatchObject({
        complete: false,
        truncated: true,
        truncatedByBytes: true,
      })
      expect(result.output).not.toHaveProperty("sha256")
      expect(result.output).not.toHaveProperty("byteCount")
      const content = String(
        (result.output as { readonly content: unknown }).content,
      )
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(64)
      expect(content).toContain("[truncated bytes]")
    })
  })

  it("serializes compare-and-write so one concurrent writer observes stale state", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "shared.txt"), "original")
      const write = createWriteFileTool()
      const context = observedContext(workspace, "shared.txt", "original")

      const results = await Promise.all([
        write.execute({ path: "shared.txt", content: "first" }, context),
        write.execute({ path: "shared.txt", content: "second" }, context),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ code: "stale_sha256" }),
      ])
      expect(["first", "second"]).toContain(
        await readFile(join(workspace, "shared.txt"), "utf8"),
      )
    })
  })

  it("applies a shared unread edit anchor only once under concurrent calls", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "unread.txt"), "before\n")
      const edit = createEditFileTool()
      const context = { workspaceRoot: workspace }
      const results = await Promise.all([
        edit.execute(
          { path: "unread.txt", oldString: "before", newString: "first" },
          context,
        ),
        edit.execute(
          { path: "unread.txt", oldString: "before", newString: "second" },
          context,
        ),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toHaveLength(1)
      expect(["first\n", "second\n"]).toContain(
        await readFile(join(workspace, "unread.txt"), "utf8"),
      )
    })
  })

  it("creates a file exclusively when concurrent writes require absence", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const results = await Promise.all(
        ["first", "second"].map((content) =>
          compareAndWriteTextFile({
            workspaceRoot,
            path: "created.txt",
            content,
            expectedSha256: null,
          }),
        ),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ code: "file_exists" }),
      ])
      expect(await readFile(join(workspaceRoot, "created.txt"), "utf8")).toBe(
        results[0]?.ok ? "first" : "second",
      )
    })
  })

  it("creates a new file exclusively under concurrent empty-oldString edits", async () => {
    await withWorkspace(async (workspace) => {
      const edit = createEditFileTool()
      const results = await Promise.all([
        edit.execute(
          { path: "edit-created.txt", oldString: "", newString: "first" },
          { workspaceRoot: workspace },
        ),
        edit.execute(
          { path: "edit-created.txt", oldString: "", newString: "second" },
          { workspaceRoot: workspace },
        ),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ code: "file_exists" }),
      ])
      expect(["first", "second"]).toContain(
        await readFile(join(workspace, "edit-created.txt"), "utf8"),
      )
    })
  })
})

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "yakitori-tools-"))
  const workspace = await resolveWorkspaceRoot(temporary)
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function observedContext(workspaceRoot: string, path: string, content: string) {
  return {
    workspaceRoot,
    visibleFileObservations: visibleReadObservation({
      path,
      complete: true,
      sha256: sha256(content),
      kind: "whole_file_read",
    }),
  }
}

function visibleReadObservation(grant: FileObservationGrant) {
  const observations = createVisibleFileObservations()
  observations.apply(grant)
  return observations
}

function observeToolOutputs(...outputs: JsonValue[]) {
  const observations = createVisibleFileObservations()
  for (const output of outputs) {
    for (const grant of grantsFromToolOutput(output)) observations.apply(grant)
  }
  return observations
}
