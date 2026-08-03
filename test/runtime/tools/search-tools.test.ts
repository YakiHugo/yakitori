import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createFileObservationStore,
  createGlobTool,
  createGrepTool,
  resolveWorkspaceRoot,
} from "../../../src/index.ts"

describe("workspace search tools", () => {
  it("greps content with bounded ripgrep output and hides sensitive matches", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "alpha.ts"), "const Needle = 1\n")
      await writeFile(join(workspace, "beta.ts"), "const needle = 2\n")
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
          truncated: true,
          content: expect.stringContaining(":1:const"),
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
        head_limit: { type: "integer" },
        offset: { type: "integer" },
        multiline: { type: "boolean" },
        expected_revision: { type: "string" },
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
      expect(successContent(files).split("\n")).toEqual(["a.ts", "z.ts"])

      const content = await createGrepTool().execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(successContent(content).split("\n")).toEqual([
        "a.ts:2:needle",
        "z.ts:1:needle",
        "z.ts:2:needle",
      ])

      const count = await createGrepTool().execute(
        { pattern: "needle", output_mode: "count" },
        { workspaceRoot: workspace },
      )
      expect(successContent(count).split("\n")).toEqual(["a.ts:1", "z.ts:2"])
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
      expect(successContent(normal)).toBe("visible.ts")

      const configured = await createGrepTool({ includeIgnored: true }).execute(
        { pattern: "needle" },
        { workspaceRoot: workspace },
      )
      expect(successContent(configured)).toContain("ignored/generated.ts")
    })
  })

  it("paginates against an observation checkpoint and rejects stale continuation", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.ts"), "needle\n")
      await writeFile(join(workspace, "b.ts"), "needle\n")
      const observations = createFileObservationStore()
      const tool = createGrepTool()
      const first = await tool.execute(
        { pattern: "needle", output_mode: "content", head_limit: 1 },
        { workspaceRoot: workspace, fileObservations: observations },
      )
      expect(first).toMatchObject({
        ok: true,
        output: {
          count: 1,
          observations: [
            {
              path: "a.ts",
              kind: "grep_snippet",
              ranges: [{ startLine: 1, endLine: 1 }],
            },
          ],
          page: {
            has_more: true,
            next: { offset: 1 },
          },
        },
      })
      if (!first.ok || !isObject(first.output)) return
      observations.recordSuccess("grep", {}, first.output)
      const page = first.output.page
      if (!isObject(page) || !isObject(page.next)) return

      const second = await tool.execute(
        {
          pattern: "needle",
          output_mode: "content",
          head_limit: 1,
          offset: page.next.offset,
          expected_revision: page.next.expected_revision,
        },
        { workspaceRoot: workspace, fileObservations: observations },
      )
      expect(successContent(second)).toContain("b.ts:1:needle")

      observations.recordSuccess(
        "write_file",
        {},
        {
          path: "other.ts",
          sha256: "f".repeat(64),
        },
      )
      const stale = await tool.execute(
        {
          pattern: "needle",
          output_mode: "content",
          head_limit: 1,
          offset: page.next.offset,
          expected_revision: page.next.expected_revision,
        },
        { workspaceRoot: workspace, fileObservations: observations },
      )
      expect(stale).toMatchObject({ ok: false, code: "stale_revision" })
    })
  })

  it("returns partial timeout output and observes only displayed snippets", async () => {
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
          limitReason: "result_limit",
          observations: [{ path: "a.ts" }],
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
          observations: [{ path: "a.ts" }],
        },
      })
    })
  })

  it("caps individual lines and total model-visible grep bytes", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.ts"), `needle ${"x".repeat(2_000)}\n`)
      let offered = 0
      const tool = createGrepTool(
        { maxLineCharacters: 120, maxOutputBytes: 9 * 1024 },
        async (_arguments, input) => {
          for (let line = 1; line <= 100; line += 1) {
            offered += 1
            if (
              !input.onRecord(
                ripgrepMatch("a.ts", line, `needle ${"x".repeat(2_000)}\n`),
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
          limitReason: "output_byte_limit",
          content: expect.stringContaining("[line truncated]"),
        },
      })
      expect(offered).toBeLessThan(100)
      if (result.ok) {
        expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
          9 * 1024,
        )
        const output = result.output
        if (isObject(output)) {
          const firstLine = String(output.content).split("\n")[0] ?? ""
          expect(firstLine.length).toBeLessThanOrEqual(120)
        }
      }
    })
  })

  it("records every displayed line in a multiline grep snippet", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "multi.ts"), "needle\nnext\nafter\n")
      const result = await createGrepTool().execute(
        {
          pattern: "needle\\nnext",
          output_mode: "content",
          multiline: true,
        },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          content: expect.stringContaining("multi.ts:1:needle\\nnext"),
          observations: [
            {
              path: "multi.ts",
              kind: "grep_snippet",
              ranges: [{ startLine: 1, endLine: 2 }],
            },
          ],
        },
      })
    })
  })

  it("does not materialize edit observations for files above the edit limit", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, "large.txt"),
        `needle\n${"x".repeat(1024 * 1024)}`,
      )
      const result = await createGrepTool().execute(
        { pattern: "needle", output_mode: "content" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          content: expect.stringContaining("large.txt:1:needle"),
          observations: [],
        },
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
      })
    })
  })

  it("passes glob patterns to ripgrep and returns newest files first", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "one.ts"), "one")
      await writeFile(join(workspace, "two.ts"), "two")
      await mkdir(join(workspace, "nested"))
      await writeFile(join(workspace, "nested", "three.ts"), "three")
      await writeFile(join(workspace, ".env.ts"), "secret")
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
        output: { count: 3, truncated: false },
      })
      if (complete.ok) {
        const content = String(
          (complete.output as { content: unknown }).content,
        )
        expect(content.split("\n")[0]).toBe("two.ts")
        expect(content).toContain("nested/three.ts")
        expect(content).not.toContain(".env.ts")
      }

      const result = await createGlobTool({ limit: 1 }).execute(
        { pattern: "*.ts" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: { count: 1, truncated: true },
      })
      if (!result.ok) return
      const content = String((result.output as { content: unknown }).content)
      expect(content).toContain(
        "Consider using a more specific path or pattern",
      )
      expect(content).not.toContain(".env.ts")
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
        output: { count: 1, content: "visible.ts" },
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
        output: { count: 1, content: "src/main.ts" },
      })

      const fileRoot = await createGlobTool().execute(
        { pattern: "*", path: "not-a-directory.txt" },
        { workspaceRoot: workspace },
      )
      expect(fileRoot).toMatchObject({
        ok: false,
        code: "path_not_directory",
      })

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
