import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createEditFileTool,
  createFileObservationStore,
  createReadFileTool,
  createToolRegistry,
  createWriteFileTool,
  resolveWorkspaceRoot,
} from "../../../src/index.ts"

describe("bounded file tools", () => {
  it("reads UTF-8 content with sha256 and truncation metadata", async () => {
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
        truncated: true,
        truncatedByLines: true,
        lineCount: 3,
        content: expect.stringContaining("1\tline1\n2\tline2"),
      })
    })
  })

  it("compare-and-write succeeds, rejects stale hashes, and creates new files", async () => {
    await withWorkspace(async (workspace) => {
      const write = createWriteFileTool()
      const read = createReadFileTool()

      const created = await write.execute(
        {
          path: "new.txt",
          content: "hello",
          expectedSha256: null,
        },
        { workspaceRoot: workspace },
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.output).toMatchObject({
        previousSha256: null,
        created: true,
      })

      const collision = await write.execute(
        {
          path: "new.txt",
          content: "nope",
          expectedSha256: null,
        },
        { workspaceRoot: workspace },
      )
      expect(collision.ok).toBe(false)
      if (collision.ok) return
      expect(collision.code).toBe("file_exists")

      const current = await read.execute(
        { path: "new.txt" },
        { workspaceRoot: workspace },
      )
      expect(current.ok).toBe(true)
      if (!current.ok) return
      const sha =
        typeof current.output === "object" &&
        current.output !== null &&
        "sha256" in current.output
          ? String(current.output.sha256)
          : ""

      const stale = await write.execute(
        {
          path: "new.txt",
          content: "stale",
          expectedSha256: "0".repeat(64),
        },
        { workspaceRoot: workspace },
      )
      expect(stale.ok).toBe(false)
      if (stale.ok) return
      expect(stale).toMatchObject({
        code: "stale_sha256",
        output: {
          currentSha256: sha,
          suggestion: "Read the file again before retrying the write.",
        },
      })
      expect(JSON.parse(stale.content)).toEqual({
        error: {
          code: "stale_sha256",
          message: "expectedSha256 does not match the current file contents.",
          currentSha256: sha,
          suggestion: "Read the file again before retrying the write.",
        },
      })

      const updated = await write.execute(
        {
          path: "new.txt",
          content: "updated",
          expectedSha256: sha,
        },
        { workspaceRoot: workspace },
      )
      expect(updated.ok).toBe(true)
      if (!updated.ok) return
      expect(updated.output).toMatchObject({
        previousSha256: sha,
        created: false,
      })
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("updated")
    })
  })

  it("validates and normalizes the expected SHA-256 revision", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "revision.txt"), "before")
      const write = createWriteFileTool()

      const invalid = await write.execute(
        {
          path: "revision.txt",
          content: "after",
          expectedSha256: "not-a-sha",
        },
        { workspaceRoot: workspace },
      )
      expect(invalid).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
      })

      const expectedSha256 = createHash("sha256")
        .update("before")
        .digest("hex")
        .toUpperCase()
      const updated = await write.execute(
        {
          path: "revision.txt",
          content: "after",
          expectedSha256,
        },
        { workspaceRoot: workspace },
      )

      expect(updated.ok).toBe(true)
      expect(await readFile(join(workspace, "revision.txt"), "utf8")).toBe(
        "after",
      )
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
            expectedSha256: sha256("before\n"),
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
      })
      expect(await readFile(join(workspace, "value.ts"), "utf8")).toBe(
        "const value = 2\n",
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
        code: "edit_target_not_found",
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
        code: "edit_target_not_found",
        output: {
          expected: '  function beta() {\n    return "stale"\n  }',
          recovery: {
            action: "read_file",
            input: { path: "candidate.ts", offset: 1, limit: 10 },
          },
        },
      })
      if (result.ok) return
      const error = JSON.parse(result.content).error
      expect(error.candidates).toHaveLength(3)
      expect(error.candidates[0]).toEqual({
        startLine: 4,
        endLine: 6,
        score: 4,
        snippet: '  4| function beta() {\n  5|   return "current"\n  6| }',
      })
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
        code: "edit_target_not_found",
      })
      expect(await readFile(join(workspace, "script.py"), "utf8")).toBe(python)

      const yaml = "items:\n  - one\n"
      await writeFile(join(workspace, "config.yaml"), yaml)
      observe(context.fileObservations, "config.yaml", yaml)
      const yamlResult = await createEditFileTool().execute(
        {
          path: "config.yaml",
          oldString: "items:\n    - one",
          newString: "items:\n    - two",
        },
        context,
      )
      expect(yamlResult).toMatchObject({
        ok: false,
        code: "edit_target_not_found",
      })
      expect(await readFile(join(workspace, "config.yaml"), "utf8")).toBe(yaml)
    })
  })

  it("rejects empty and ambiguous oldString values without changing the file", async () => {
    await withWorkspace(async (workspace) => {
      const repeated = "const value = 1\nconst value = 1\n"
      const edit = createEditFileTool()
      await writeFile(join(workspace, "ambiguous.ts"), repeated)
      const context = observedContext(workspace, "ambiguous.ts", repeated)

      const empty = await edit.execute(
        {
          path: "ambiguous.ts",
          oldString: "",
          newString: "replacement",
        },
        context,
      )
      expect(empty).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        output: {
          reason: "empty_old_string",
          suggestion: "Use write_file to create or replace a complete file.",
        },
      })

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
        code: "edit_target_ambiguous",
        output: {
          matchCount: 2,
          candidates: [
            {
              startLine: 1,
              endLine: 1,
              snippet: "  1| const value = 1",
            },
            {
              startLine: 2,
              endLine: 2,
              snippet: "  2| const value = 1",
            },
          ],
          recovery: {
            action: "read_file",
            input: { path: "ambiguous.ts", offset: 1, limit: 10 },
          },
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
    ])
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema,
    ).toMatchObject({
      required: ["path", "oldString", "newString"],
      properties: {
        path: { type: "string" },
        oldString: { type: "string", minLength: 1 },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
    })
    expect(
      definitions.find((tool) => tool.name === "edit_file")?.inputSchema
        .properties,
    ).not.toHaveProperty("expectedSha256")
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
              expectedSha256: null,
            },
            { workspaceRoot: workspace },
          )
          expect(traversal.ok).toBe(false)

          const symlinkEscape = await tool.execute(
            {
              path: "link/secret.txt",
              content: "x",
              expectedSha256: null,
            },
            { workspaceRoot: workspace },
          )
          expect(symlinkEscape.ok).toBe(false)
        }
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it("keeps read content bounded while hashing the complete file", async () => {
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
        sha256: createHash("sha256").update(body).digest("hex"),
        byteCount: Buffer.byteLength(body),
        truncated: true,
        truncatedByBytes: true,
      })
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
      const expectedSha256 = createHash("sha256")
        .update("original")
        .digest("hex")
      const write = createWriteFileTool()

      const results = await Promise.all([
        write.execute(
          { path: "shared.txt", content: "first", expectedSha256 },
          { workspaceRoot: workspace },
        ),
        write.execute(
          { path: "shared.txt", content: "second", expectedSha256 },
          { workspaceRoot: workspace },
        ),
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
          { path: "created.txt", content: "first", expectedSha256: null },
          { workspaceRoot: workspace },
        ),
        write.execute(
          { path: "created.txt", content: "second", expectedSha256: null },
          { workspaceRoot: workspace },
        ),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ code: "file_exists" }),
      ])
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

function observedContext(workspaceRoot: string, path: string, content: string) {
  const fileObservations = createFileObservationStore()
  observe(fileObservations, path, content)
  return { workspaceRoot, fileObservations }
}

function observe(
  store: ReturnType<typeof createFileObservationStore>,
  path: string,
  content: string,
): void {
  store.recordSuccess(
    "read_file",
    { path },
    {
      path,
      sha256: sha256(content),
      truncated: false,
      range: { offset: 1, requestedLimit: 2_000 },
      content: "",
    },
  )
}
