import { createHash } from "node:crypto"
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
import { describe, expect, it } from "vitest"
import {
  createEditFileTool,
  createReadFileTool,
  createToolRegistry,
  createVisibleFileObservations,
  createWriteFileTool,
  resolveWorkspaceRoot,
  type ToolProjection,
  ToolState,
} from "../../../src/index.ts"

describe("bounded file tools", () => {
  it("reads a live UTF-8 page without a full-file revision", async () => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "notes.txt")
      await writeFile(path, "line1\nline2\nline3\n")
      const tool = createReadFileTool()
      const result = await tool.execute(
        { path: "notes.txt", offset: 1, limit: 2 },
        { workspaceRoot: workspace },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.output).toMatchObject({
        path: "notes.txt",
        complete: false,
        truncated: true,
        truncatedByLines: true,
        content: expect.stringContaining("1\tline1\n2\tline2"),
      })
      expect(result.output).not.toHaveProperty("sha256")
      expect(result.output).not.toHaveProperty("lineCount")
    })
  })

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

      const collision = await write.execute(
        { path: "new.txt", content: "nope" },
        { workspaceRoot: workspace },
      )
      expect(collision.ok).toBe(false)
      if (collision.ok) return
      expect(collision.code).toBe("file_not_observed")

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
        `stale_sha256: The file changed since it was observed.\nCurrent sha256: ${sha256("external")}\nSuggestion: Read the file again before retrying the write.`,
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

  it("requires a complete observation before replacing an existing file", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "revision.txt"), "before")
      const write = createWriteFileTool()

      const unobserved = await write.execute(
        { path: "revision.txt", content: "after" },
        { workspaceRoot: workspace },
      )
      expect(unobserved).toMatchObject({
        ok: false,
        code: "file_not_observed",
      })

      const partial = visibleReadObservation({
        path: "revision.txt",
        complete: false,
        range: { offset: 1, limit: 1, requestedLimit: 1 },
      })
      expect(
        await write.execute(
          { path: "revision.txt", content: "after" },
          {
            workspaceRoot: workspace,
            visibleFileObservations: partial,
          },
        ),
      ).toMatchObject({
        ok: false,
        code: "file_not_fully_observed",
      })

      const updated = await write.execute(
        { path: "revision.txt", content: "after" },
        observedContext(workspace, "revision.txt", "before"),
      )

      expect(updated.ok).toBe(true)
      expect(await readFile(join(workspace, "revision.txt"), "utf8")).toBe(
        "after",
      )
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

      const visibleFileObservations = createVisibleFileObservations([
        toolProjection("edit_file", created.output),
      ])
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
          "Use a non-empty oldString to edit it, or write_file for an intentional whole-file replacement.",
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

  it("requires the edit revision to be observed in the current session", async () => {
    await withWorkspace(async (workspace) => {
      const before = "const value = 1\n"
      await writeFile(join(workspace, "observed.ts"), before)
      const edit = createEditFileTool()
      const request = {
        path: "observed.ts",
        oldString: "value = 1",
        newString: "value = 2",
      }

      expect(
        await edit.execute(request, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: false,
        code: "file_not_observed",
      })

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

  it("uses an exact unique current anchor after a revisionless ranged read", async () => {
    await withWorkspace(async (workspace) => {
      const before = "first\ntarget = 1\nlast\n"
      await writeFile(join(workspace, "rebase.txt"), before)
      const visibleFileObservations = visibleReadObservation({
        path: "rebase.txt",
        complete: false,
        range: { offset: 1, limit: 1, requestedLimit: 1 },
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
      const rangedRead = toolProjection("read_file", {
        path,
        complete: false,
        range: { offset: 1, limit: 1, requestedLimit: 1 },
      })
      const first = await edit.execute(
        {
          path,
          oldString: "const count = 1",
          newString: "const count = 2",
        },
        {
          workspaceRoot: workspace,
          visibleFileObservations: createVisibleFileObservations([rangedRead]),
        },
      )
      expect(first).toMatchObject({ ok: true })
      if (!first.ok) return

      const visibleFileObservations = createVisibleFileObservations([
        rangedRead,
        toolProjection("edit_file", first.output),
      ])
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

  it("supports explicit replaceAll and rejects files changed since observation", async () => {
    await withWorkspace(async (workspace) => {
      const before = "enabled = false\nenabled = false\n"
      const edit = createEditFileTool()
      await writeFile(join(workspace, "flags.txt"), before)
      const context = observedContext(workspace, "flags.txt", before)

      const ranged = await edit.execute(
        {
          path: "flags.txt",
          oldString: "enabled = false",
          newString: "enabled = true",
          replaceAll: true,
        },
        {
          workspaceRoot: workspace,
          visibleFileObservations: visibleReadObservation({
            path: "flags.txt",
            complete: false,
            range: { offset: 1, limit: 1, requestedLimit: 1 },
          }),
        },
      )
      expect(ranged).toMatchObject({
        ok: false,
        code: "file_not_fully_observed",
      })

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

  it("registers edit_file in the default model toolset", () => {
    const definitions = createToolRegistry().definitions()
    expect(definitions.map((tool) => tool.name)).toEqual([
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "run_command",
      "web_fetch",
      "web_search",
    ])
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema,
    ).toMatchObject({
      required: ["path", "oldString", "newString"],
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
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
  })

  it("rejects path traversal and symlink escapes", async () => {
    await withWorkspace(async (workspace) => {
      const outside = await mkdtemp(join(tmpdir(), "yakitori-outside-"))
      try {
        await writeFile(join(outside, "secret.txt"), "secret")
        await symlink(outside, join(workspace, "link"))
        const read = createReadFileTool()
        const write = createWriteFileTool()

        for (const tool of [read, write]) {
          const traversal = await tool.execute(
            {
              path: "../secret.txt",
              content: "x",
            },
            { workspaceRoot: workspace },
          )
          expect(traversal.ok).toBe(false)

          const symlinkEscape = await tool.execute(
            {
              path: "link/secret.txt",
              content: "x",
            },
            { workspaceRoot: workspace },
          )
          expect(symlinkEscape.ok).toBe(false)
        }

        const edit = createEditFileTool()
        expect(
          await edit.execute(
            { path: "../created.txt", oldString: "", newString: "x" },
            { workspaceRoot: workspace },
          ),
        ).toMatchObject({ ok: false, code: "path_denied" })
        expect(
          await edit.execute(
            { path: "link/created.txt", oldString: "", newString: "x" },
            { workspaceRoot: workspace },
          ),
        ).toMatchObject({ ok: false, code: "path_denied" })
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

  it("creates a new file exclusively under concurrent writes", async () => {
    await withWorkspace(async (workspace) => {
      const write = createWriteFileTool()
      const results = await Promise.all([
        write.execute(
          { path: "created.txt", content: "first" },
          { workspaceRoot: workspace },
        ),
        write.execute(
          { path: "created.txt", content: "second" },
          { workspaceRoot: workspace },
        ),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      const failures = results.filter((result) => !result.ok)
      expect(failures).toHaveLength(1)
      expect(["file_exists", "file_not_observed"]).toContain(failures[0]?.code)
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
      range: { offset: 1, limit: 2_000, requestedLimit: 2_000 },
    }),
  }
}

function visibleReadObservation(
  output: Exclude<ToolProjection["output"], undefined>,
) {
  return createVisibleFileObservations([toolProjection("read_file", output)])
}

let toolProjectionIndex = 0

function toolProjection(
  name: string,
  output: Exclude<ToolProjection["output"], undefined>,
): ToolProjection {
  toolProjectionIndex += 1
  return {
    toolCallId: `tool_observation_${toolProjectionIndex}`,
    turnId: "turn_observation",
    name,
    input: {},
    state: ToolState.Completed,
    requestedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    requestItemId: `item_observation_${toolProjectionIndex}`,
    requiresPermission: false,
    output,
  }
}
