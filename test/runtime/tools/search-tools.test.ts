import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createGlobTool,
  createGrepTool,
  resolveWorkspaceRoot,
} from "../../../src/index.ts"

describe("workspace search tools", () => {
  it("greps content with bounded ripgrep output and respects gitignore", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "alpha.ts"), "const Needle = 1\n")
      await writeFile(join(workspace, "beta.ts"), "const needle = 2\n")
      await writeFile(join(workspace, ".gitignore"), ".env\n")
      await writeFile(join(workspace, ".env"), "needle=secret\n")

      const result = await createGrepTool().execute(
        {
          pattern: "needle",
          glob: "*.ts",
          output_mode: "content",
          "-i": true,
          "-n": true,
          head_limit: 1,
        },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          locations: [{ path: "alpha.ts", line: 1 }],
          truncated: true,
          truncationReason: "result_limit",
          timedOut: false,
          lineTruncated: false,
          content: expect.stringContaining(":1:const"),
          page: {
            has_more: true,
            next: { offset: 1 },
          },
        },
      })
      if (result.ok) {
        expect(result.content).not.toContain("secret")
        expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
          20 * 1024,
        )
      }
    })
  })

  it("exposes the Claude/Kimi grep surface without include_ignored", () => {
    const schema = createGrepTool().inputSchema
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        output_mode: {
          enum: ["content", "files_with_matches", "count", "count_matches"],
        },
        "-B": { type: "integer" },
        "-A": { type: "integer" },
        "-C": { type: "integer" },
        context: { type: "integer" },
        "-n": { type: "boolean" },
        "-i": { type: "boolean" },
        "-o": { type: "boolean" },
        type: { type: "string" },
        head_limit: { type: "integer", minimum: 1, maximum: 250 },
        offset: { type: "integer" },
        multiline: { type: "boolean" },
      },
    })
    expect(schema.properties).not.toHaveProperty("include_ignored")
  })

  it("rejects model-supplied grep ignored-file switches", async () => {
    await withWorkspace(async (workspace) => {
      const result = await createGrepTool().execute(
        { pattern: "needle", include_ignored: true },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
      })
    })
  })

  it("validates head_limit instead of treating zero as the default or clamping", async () => {
    await withWorkspace(async (workspace) => {
      const zero = await createGrepTool().execute(
        { pattern: "needle", head_limit: 0 },
        { workspaceRoot: workspace },
      )
      expect(zero).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        content: expect.stringContaining("integer from 1 to 250"),
      })

      const abovePublicLimit = await createGrepTool().execute(
        { pattern: "needle", head_limit: 251 },
        { workspaceRoot: workspace },
      )
      expect(abovePublicLimit).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        content: expect.stringContaining("integer from 1 to 250"),
      })

      const overRuntimeLimit = await createGrepTool({
        maxResults: 2,
      }).execute(
        { pattern: "needle", head_limit: 3 },
        { workspaceRoot: workspace },
      )
      expect(overRuntimeLimit).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        content: expect.stringContaining("Runtime maximum of 2"),
      })
    })
  })

  it("enables multiline matching and dotall together", async () => {
    await withWorkspace(async (workspace) => {
      const result = await createGrepTool({}, async (args, input) => {
        expect(args).toEqual(
          expect.arrayContaining(["--multiline", "--multiline-dotall"]),
        )
        input.onRecord(ripgrepMatch("missing.ts", 1, "needle\nnext\n"))
        return { ok: true }
      }).execute(
        {
          pattern: "needle.*next",
          output_mode: "content",
          multiline: true,
        },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          content: "Grep returned 1 result.\nmissing.ts:1:needle\\nnext",
        },
      })
      if (result.ok && isObject(result.output)) {
        expect(result.output).not.toHaveProperty("observations")
      }
    })
  })

  it("sorts grep files by mtime and content/count stably by path and line", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "z.ts"), "needle\nneedle\n")
      await writeFile(join(workspace, "a.ts"), "zero\nneedle\n")
      await utimes(
        join(workspace, "z.ts"),
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      )
      await utimes(
        join(workspace, "a.ts"),
        new Date("2026-01-02T00:00:00.000Z"),
        new Date("2026-01-02T00:00:00.000Z"),
      )

      const files = await createGrepTool().execute(
        { pattern: "needle", output_mode: "files_with_matches" },
        { workspaceRoot: workspace },
      )
      expect(successContent(files).split("\n")).toEqual([
        "Grep returned 2 results.",
        "a.ts",
        "z.ts",
      ])

      const content = await createGrepTool().execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(successContent(content).split("\n")).toEqual([
        "Grep returned 3 results.",
        "a.ts:2:needle",
        "z.ts:1:needle",
        "z.ts:2:needle",
      ])

      const count = await createGrepTool().execute(
        { pattern: "needle", output_mode: "count" },
        { workspaceRoot: workspace },
      )
      expect(successContent(count).split("\n")).toEqual([
        "Grep returned 2 results.",
        "a.ts:1",
        "z.ts:2",
      ])
    })
  })

  it("keeps ignored grep discovery as construction-time configuration", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "ignored"))
      await writeFile(join(workspace, "visible.ts"), "needle\n")
      await writeFile(join(workspace, "ignored", "generated.ts"), "needle\n")
      await writeFile(join(workspace, ".gitignore"), "ignored/\n")

      const normal = await createGrepTool().execute(
        { pattern: "needle" },
        { workspaceRoot: workspace },
      )
      expect(successContent(normal)).toBe("Grep returned 1 result.\nvisible.ts")

      const configured = await createGrepTool({ includeIgnored: true }).execute(
        { pattern: "needle" },
        { workspaceRoot: workspace },
      )
      expect(successContent(configured)).toContain("ignored/generated.ts")
    })
  })

  it("paginates a live search without claiming snapshot consistency", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.ts"), "needle\n")
      await writeFile(join(workspace, "b.ts"), "needle\n")
      const tool = createGrepTool()
      const first = await tool.execute(
        { pattern: "needle", output_mode: "content", head_limit: 1 },
        { workspaceRoot: workspace },
      )
      expect(first).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: true,
          truncationReason: "result_limit",
          timedOut: false,
          lineTruncated: false,
          page: {
            has_more: true,
            next: { offset: 1 },
          },
        },
      })
      if (!first.ok || !isObject(first.output)) return
      expect(first.output).not.toHaveProperty("observations")
      const page = first.output.page
      if (!isObject(page) || !isObject(page.next)) return

      const second = await tool.execute(
        {
          pattern: "needle",
          output_mode: "content",
          head_limit: 1,
          offset: page.next.offset,
        },
        { workspaceRoot: workspace },
      )
      expect(successContent(second)).toContain("b.ts:1:needle")
      const livePage = await tool.execute(
        {
          pattern: "needle",
          output_mode: "content",
          head_limit: 1,
          offset: page.next.offset,
        },
        { workspaceRoot: workspace },
      )
      expect(successContent(livePage)).toContain("b.ts:1:needle")

      const exhausted = await tool.execute(
        {
          pattern: "needle",
          path: "a.ts",
          output_mode: "content",
          offset: 1,
        },
        { workspaceRoot: workspace },
      )
      expect(exhausted).toMatchObject({
        ok: true,
        output: {
          count: 0,
          offset: 1,
          content: "Grep returned 0 results at offset 1.",
          page: { has_more: false },
        },
        content: "Grep returned 0 results at offset 1.",
      })
    })
  })

  it("distinguishes pageable result limits from non-pageable timeouts", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.ts"), "needle\n")
      await writeFile(join(workspace, "b.ts"), "needle\n")
      let offered = 0
      const tool = createGrepTool({}, async (_arguments, input) => {
        const records = [
          ripgrepMatch("a.ts", 1, "needle\n"),
          ripgrepMatch("b.ts", 1, "needle\n"),
        ]
        for (const record of records) {
          offered += 1
          if (!input.onRecord(record)) {
            return { ok: true, stopReason: "consumer_limit" }
          }
        }
        return { ok: true, stopReason: "timeout" }
      })
      const result = await tool.execute(
        { pattern: "needle", output_mode: "content", head_limit: 1 },
        { workspaceRoot: workspace },
      )
      expect(offered).toBe(2)
      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: true,
          timedOut: false,
          lineTruncated: false,
          truncationReason: "result_limit",
          page: {
            has_more: true,
            next: { offset: 1 },
          },
        },
      })

      const timedOut = await createGrepTool({}, async (_arguments, input) => {
        input.onRecord(ripgrepMatch("a.ts", 1, "needle\n"))
        return { ok: true, stopReason: "timeout" }
      }).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(timedOut).toMatchObject({
        ok: true,
        output: {
          count: 1,
          timedOut: true,
          truncated: true,
          lineTruncated: false,
          content:
            "Grep returned 1 result before timing out.\na.ts:1:needle\n(Search timed out; partial results shown.)",
          page: { has_more: false },
        },
      })
      if (timedOut.ok && isObject(timedOut.output)) {
        expect(timedOut.output).not.toHaveProperty("truncationReason")
        expect(timedOut.output.page).not.toHaveProperty("next")
      }

      const emptyTimeout = await createGrepTool({}, async () => ({
        ok: true,
        stopReason: "timeout",
      })).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(emptyTimeout).toMatchObject({
        ok: false,
        code: "search_timeout",
        content:
          "search_timeout: Grep search timed out after returning 0 results.",
      })
    })
  })

  it("reports a pageable model-output byte limit", async () => {
    await withWorkspace(async (workspace) => {
      let offered = 0
      const tool = createGrepTool(
        { maxOutputBytes: 2 * 1024 },
        async (_arguments, input) => {
          for (let line = 1; line <= 100; line += 1) {
            offered += 1
            if (
              !input.onRecord(
                ripgrepMatch("a.ts", line, `needle ${"x".repeat(80)}\n`),
              )
            ) {
              return { ok: true, stopReason: "consumer_limit" }
            }
          }
          return { ok: true }
        },
      )
      const result = await tool.execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          truncated: true,
          truncationReason: "output_byte_limit",
          timedOut: false,
          lineTruncated: false,
          page: {
            has_more: true,
            next: { offset: expect.any(Number) },
          },
          content: expect.stringContaining(
            "Search output exceeded the byte limit; partial results shown.",
          ),
        },
      })
      expect(offered).toBeLessThan(100)
      if (result.ok) {
        expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
          2 * 1024,
        )
        const output = result.output
        if (isObject(output)) {
          expect(
            Buffer.byteLength(JSON.stringify(output), "utf8"),
          ).toBeLessThanOrEqual(2 * 1024)
          expect(output).not.toHaveProperty("limitReason")
        }
      }
    })
  })

  it("rejects impossible output budgets and does not paginate an empty bounded result", async () => {
    expect(() => createGrepTool({ maxOutputBytes: 511 })).toThrow(
      "grep maxOutputBytes must be an integer of at least 512.",
    )

    await withWorkspace(async (workspace) => {
      const result = await createGrepTool(
        { maxOutputBytes: 512 },
        async (_arguments, input) => {
          input.onRecord(ripgrepMatch("a.ts", 1, "needle\n"))
          return { ok: true, stopReason: "consumer_limit" }
        },
      ).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 0,
          truncated: true,
          truncationReason: "output_byte_limit",
          content:
            "Grep returned 0 results.\n(Search output exceeded the byte limit before a complete result was returned.)",
          page: { has_more: false },
        },
      })
      if (result.ok && isObject(result.output)) {
        expect(result.output.page).not.toHaveProperty("next")
        expect(
          Buffer.byteLength(JSON.stringify(result.output), "utf8"),
        ).toBeLessThanOrEqual(512)
      }

      const longPath = ["a".repeat(180), "b".repeat(180), "c".repeat(180)].join(
        "/",
      )
      await mkdir(join(workspace, longPath), { recursive: true })
      const irreducible = await createGrepTool(
        { maxOutputBytes: 512 },
        async () => ({ ok: true }),
      ).execute(
        { pattern: "needle", path: longPath },
        { workspaceRoot: workspace },
      )
      expect(irreducible).toMatchObject({
        ok: false,
        code: "output_budget_too_small",
      })
    })
  })

  it("reports line shortening without marking the search truncated", async () => {
    await withWorkspace(async (workspace) => {
      const result = await createGrepTool(
        { maxLineCharacters: 120 },
        async (_arguments, input) => {
          input.onRecord(
            ripgrepMatch("a.ts", 1, `needle ${"x".repeat(2_000)}\n`),
          )
          return { ok: true }
        },
      ).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: false,
          timedOut: false,
          lineTruncated: true,
          content: expect.stringContaining(
            "One or more result lines were shortened for display.",
          ),
          page: { has_more: false },
        },
      })
      if (result.ok && isObject(result.output)) {
        expect(result.output).not.toHaveProperty("truncationReason")
      }
    })
  })

  it("never returns file observations from grep results", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.ts"), "needle\n")
      const result = await createGrepTool().execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({ ok: true })
      if (result.ok && isObject(result.output)) {
        expect(result.output).not.toHaveProperty("observations")
      }

      const empty = await createGrepTool().execute(
        { pattern: "missing", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(empty).toMatchObject({
        ok: true,
        output: {
          count: 0,
          truncated: false,
          timedOut: false,
          lineTruncated: false,
          content: "No matches found.",
          page: { has_more: false },
        },
        content: "No matches found.",
      })
    })
  })

  it.each([
    "raw_byte_limit",
    "record_byte_limit",
  ] as const)("maps %s to a non-pageable output byte limit", async (stopReason) => {
    await withWorkspace(async (workspace) => {
      const result = await createGrepTool({}, async (_arguments, input) => {
        input.onRecord(ripgrepMatch("a.ts", 1, "needle\n"))
        return { ok: true, stopReason }
      }).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: true,
          truncationReason: "output_byte_limit",
          timedOut: false,
          page: { has_more: false },
        },
      })
      if (result.ok && isObject(result.output)) {
        expect(result.output.page).not.toHaveProperty("next")
      }
    })
  })

  it.each([
    "raw_byte_limit",
    "record_byte_limit",
  ] as const)("describes a zero-result grep %s without claiming partial results", async (stopReason) => {
    await withWorkspace(async (workspace) => {
      const result = await createGrepTool({}, async () => ({
        ok: true,
        stopReason,
      })).execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 0,
          truncated: true,
          truncationReason: "output_byte_limit",
          timedOut: false,
          content:
            "Grep returned 0 results.\n(Search output exceeded the byte limit before a complete result was returned.)",
          page: { has_more: false },
        },
      })
      expect(result.content).not.toContain("partial results shown")
    })
  })

  it("keeps grep abort and ripgrep failures as tool failures", async () => {
    await withWorkspace(async (workspace) => {
      const aborted = await createGrepTool({}, async () => ({
        ok: true,
        stopReason: "aborted",
      })).execute({ pattern: "needle" }, { workspaceRoot: workspace })
      expect(aborted).toMatchObject({
        ok: false,
        code: "search_aborted",
      })

      const failed = await createGrepTool({}, async () => ({
        ok: false,
        message: "ripgrep failed",
      })).execute({ pattern: "needle" }, { workspaceRoot: workspace })
      expect(failed).toMatchObject({
        ok: false,
        code: "search_failed",
      })
    })
  })

  it("exposes the Claude-compatible glob input surface", () => {
    const schema = createGlobTool().inputSchema
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
    })
    expect(schema.properties).not.toHaveProperty("include_ignored")
    expect(schema.properties).not.toHaveProperty("limit")
  })

  it("rejects model-supplied ignored-file switches", async () => {
    await withWorkspace(async (workspace) => {
      const result = await createGlobTool().execute(
        { pattern: "*", include_ignored: true },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        content:
          "invalid_tool_input: glob does not accept the include_ignored argument.",
      })
    })
  })

  it("passes glob patterns to ripgrep and returns paths lexicographically", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "one.ts"), "one")
      await writeFile(join(workspace, "two.ts"), "two")
      await mkdir(join(workspace, "nested"))
      await writeFile(join(workspace, "nested", "three.ts"), "three")
      await writeFile(join(workspace, ".hidden.ts"), "hidden")
      await writeFile(join(workspace, ".env.ts"), "secret")
      await mkdir(join(workspace, ".git"))
      await writeFile(join(workspace, ".git", "internal.ts"), "vcs")
      await utimes(
        join(workspace, "one.ts"),
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      )
      await utimes(
        join(workspace, "two.ts"),
        new Date("2026-01-02T00:00:00.000Z"),
        new Date("2026-01-02T00:00:00.000Z"),
      )
      await utimes(
        join(workspace, "nested", "three.ts"),
        new Date("2026-01-01T12:00:00.000Z"),
        new Date("2026-01-01T12:00:00.000Z"),
      )
      const complete = await createGlobTool().execute(
        { pattern: "*.ts" },
        { workspaceRoot: workspace },
      )
      expect(complete).toMatchObject({
        ok: true,
        output: {
          pattern: "*.ts",
          path: ".",
          count: 5,
          paths: [
            ".env.ts",
            ".hidden.ts",
            "nested/three.ts",
            "one.ts",
            "two.ts",
          ],
          truncated: false,
          content:
            "Glob returned 5 files.\n.env.ts\n.hidden.ts\nnested/three.ts\none.ts\ntwo.ts",
        },
      })
      if (complete.ok) {
        const content = String(
          (complete.output as { content: unknown }).content,
        )
        if (isObject(complete.output)) {
          expect(complete.output).not.toHaveProperty("truncationReason")
        }
        expect(complete.content).toBe(content)
        expect(content.split("\n")).toEqual([
          "Glob returned 5 files.",
          ".env.ts",
          ".hidden.ts",
          "nested/three.ts",
          "one.ts",
          "two.ts",
        ])
        expect(content).not.toContain(".git")
      }

      const result = await createGlobTool({ limit: 1 }).execute(
        { pattern: "*.ts" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: true,
          truncationReason: "result_limit",
        },
      })
      if (!result.ok) return
      const content = String((result.output as { content: unknown }).content)
      expect(content).toContain("(Results truncated at the result limit.)")
      expect(content).not.toContain("Consider using")
    })
  })

  it("stops on the 101st valid path and reports the result limit", async () => {
    await withWorkspace(async (workspace) => {
      let offered = 0
      const result = await createGlobTool({}, async (args, input) => {
        expect(args).not.toContain("--sortr=modified")
        for (let index = 100; index >= 0; index -= 1) {
          offered += 1
          if (!input.onRecord(`file-${String(index).padStart(3, "0")}.ts`)) {
            return { ok: true, stopReason: "consumer_limit" }
          }
        }
        return { ok: true }
      }).execute({ pattern: "*.ts" }, { workspaceRoot: workspace })

      expect(offered).toBe(101)
      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 100,
          truncated: true,
          truncationReason: "result_limit",
        },
      })
      expect(successContent(result).split("\n")).toEqual([
        "Glob returned 100 files.",
        ...Array.from(
          { length: 100 },
          (_, index) => `file-${String(index + 1).padStart(3, "0")}.ts`,
        ),
        "(Results truncated at the result limit.)",
      ])
      expect(result.content).toBe(successContent(result))
    })
  })

  it("returns partial timeout results but fails a zero-result timeout", async () => {
    await withWorkspace(async (workspace) => {
      const partial = await createGlobTool({}, async (_args, input) => {
        input.onRecord("z.ts")
        input.onRecord("a.ts")
        return { ok: true, stopReason: "timeout" }
      }).execute({ pattern: "*.ts" }, { workspaceRoot: workspace })

      expect(partial).toMatchObject({
        ok: true,
        output: {
          count: 2,
          truncated: true,
          truncationReason: "timeout",
          content:
            "Glob returned 2 files before timing out.\na.ts\nz.ts\n(Search timed out; partial results shown.)",
        },
      })
      if (partial.ok && isObject(partial.output)) {
        expect(partial.output).not.toHaveProperty("timedOut")
        expect(partial.output).not.toHaveProperty("limitReason")
      }
      expect(partial.content).toBe(
        "Glob returned 2 files before timing out.\na.ts\nz.ts\n(Search timed out; partial results shown.)",
      )

      const empty = await createGlobTool({}, async () => ({
        ok: true,
        stopReason: "timeout",
      })).execute({ pattern: "*.ts" }, { workspaceRoot: workspace })
      expect(empty).toMatchObject({
        ok: false,
        code: "search_timeout",
        content:
          "search_timeout: Glob search timed out after returning 0 files.",
      })
      expect(empty.content).not.toContain("No files found")
    })
  })

  it.each([
    "raw_byte_limit",
    "record_byte_limit",
  ] as const)("maps %s to the public output byte limit", async (stopReason) => {
    await withWorkspace(async (workspace) => {
      const result = await createGlobTool({}, async (_args, input) => {
        input.onRecord("partial.ts")
        return { ok: true, stopReason }
      }).execute({ pattern: "*.ts" }, { workspaceRoot: workspace })

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 1,
          truncated: true,
          truncationReason: "output_byte_limit",
          content: expect.stringContaining(
            "Search output exceeded the byte limit; partial results shown.",
          ),
        },
      })
    })
  })

  it.each([
    "raw_byte_limit",
    "record_byte_limit",
  ] as const)("describes a zero-result %s without claiming partial results", async (stopReason) => {
    await withWorkspace(async (workspace) => {
      const result = await createGlobTool({}, async () => ({
        ok: true,
        stopReason,
      })).execute({ pattern: "*.ts" }, { workspaceRoot: workspace })

      expect(result).toMatchObject({
        ok: true,
        output: {
          count: 0,
          truncated: true,
          truncationReason: "output_byte_limit",
          content:
            "Glob returned 0 files.\n(Search output exceeded the byte limit before a complete file path was returned.)",
        },
      })
      expect(result.content).not.toContain("partial results shown")
    })
  })

  it("keeps abort and ripgrep failures as tool failures", async () => {
    await withWorkspace(async (workspace) => {
      const aborted = await createGlobTool({}, async () => ({
        ok: true,
        stopReason: "aborted",
      })).execute({ pattern: "*" }, { workspaceRoot: workspace })
      expect(aborted).toMatchObject({
        ok: false,
        code: "search_aborted",
      })

      const failed = await createGlobTool({}, async () => ({
        ok: false,
        message: "ripgrep failed",
      })).execute({ pattern: "*" }, { workspaceRoot: workspace })
      expect(failed).toMatchObject({
        ok: false,
        code: "search_failed",
        content: "search_failed: ripgrep failed",
      })
    })
  })

  it("keeps ignored-file discovery as construction-time configuration", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "ignored"))
      await writeFile(join(workspace, "visible.ts"), "visible")
      await writeFile(join(workspace, "ignored", "generated.ts"), "ignored")
      await writeFile(join(workspace, ".gitignore"), "ignored/\n")

      const normal = await createGlobTool().execute(
        { pattern: "**/*.ts" },
        { workspaceRoot: workspace },
      )
      expect(normal).toMatchObject({
        ok: true,
        output: {
          count: 1,
          content: "Glob returned 1 file.\nvisible.ts",
        },
      })

      const configured = await createGlobTool({
        includeIgnored: true,
      }).execute({ pattern: "**/*.ts" }, { workspaceRoot: workspace })
      expect(configured).toMatchObject({
        ok: true,
        output: {
          count: 2,
          content: expect.stringContaining("ignored/generated.ts"),
        },
      })
    })
  })

  it("searches only directories and keeps returned paths workspace-relative", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "src"))
      await writeFile(join(workspace, "src", "main.ts"), "main")
      await writeFile(join(workspace, "not-a-directory.txt"), "file")

      const nested = await createGlobTool().execute(
        { pattern: "*.ts", path: "src" },
        { workspaceRoot: workspace },
      )
      expect(nested).toMatchObject({
        ok: true,
        output: {
          count: 1,
          content: "Glob returned 1 file.\nsrc/main.ts",
        },
      })

      const fileRoot = await createGlobTool().execute(
        { pattern: "*", path: "not-a-directory.txt" },
        { workspaceRoot: workspace },
      )
      expect(fileRoot).toMatchObject({
        ok: false,
        code: "path_not_directory",
      })

      const outside = await createGlobTool().execute(
        { pattern: "*", path: "../" },
        { workspaceRoot: workspace },
      )
      expect(outside).toMatchObject({
        ok: false,
        code: "path_denied",
      })

      const absolute = await createGlobTool().execute(
        { pattern: "*", path: tmpdir() },
        { workspaceRoot: workspace },
      )
      expect(absolute).toMatchObject({
        ok: false,
        code: "path_denied",
      })

      const empty = await createGlobTool().execute(
        { pattern: "*.missing" },
        { workspaceRoot: workspace },
      )
      expect(empty).toMatchObject({
        ok: true,
        output: {
          count: 0,
          truncated: false,
          content: "No files found.",
        },
      })
      expect(empty.content).toBe("No files found.")

      // TODO(grok-glob): add a directory-result contract test if we later
      // adopt Grok's advertised file-and-directory behavior. Claude/Kimi and
      // this tool are currently files-only. Reference:
      // .references/public/grok-build/crates/codegen/xai-grok-tools/src/implementations/opencode/glob/mod.rs
    })
  })
})

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "yakitori-search-tools-"))
  const workspace = await resolveWorkspaceRoot(temporary)
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function successContent(
  result: Awaited<ReturnType<ReturnType<typeof createGrepTool>["execute"]>>,
) {
  expect(result.ok).toBe(true)
  if (!result.ok || !isObject(result.output)) return ""
  return String(result.output.content)
}

function ripgrepMatch(path: string, line: number, text: string) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      submatches: [{ start: 0, end: 6 }],
    },
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
