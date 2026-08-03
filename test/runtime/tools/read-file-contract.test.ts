import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createFileObservationStore,
  createReadFileTool,
  resolveWorkspaceRoot,
} from "../../../src/index.ts"

describe("read_file contract", () => {
  it("uses 1-based and negative offsets with internally guarded continuation", async () => {
    await withWorkspace(async (workspace) => {
      const body = "one\ntwo\nthree\nfour\n"
      await writeFile(join(workspace, "lines.txt"), body)
      const read = createReadFileTool()
      const observations = createFileObservationStore()
      const context = {
        workspaceRoot: workspace,
        fileObservations: observations,
      }
      const tail = await read.execute(
        { path: "lines.txt", offset: -2, limit: 1 },
        context,
      )
      expect(tail).toMatchObject({
        ok: true,
        output: {
          sha256: sha256(body),
          range: { offset: 3, limit: 1, requestedLimit: 1 },
          continuation: { nextOffset: 4 },
          content: expect.stringContaining("3\tthree"),
        },
      })
      if (!tail.ok) return
      observations.recordSuccess("read_file", {}, tail.output)

      await writeFile(join(workspace, "lines.txt"), `${body}five\n`)
      const stale = await read.execute(
        { path: "lines.txt", offset: 4 },
        context,
      )
      expect(stale).toMatchObject({ ok: false, code: "read_stale" })
      if (!stale.ok) expect(stale.content).not.toContain(sha256(body))

      const restarted = await read.execute(
        { path: "lines.txt", offset: 1, limit: 1 },
        context,
      )
      expect(restarted).toMatchObject({ ok: true })
    })
  })

  it("removes revision guards from model input", async () => {
    const schema = createReadFileTool().inputSchema
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
    })
    expect(schema.properties).not.toHaveProperty("expectedSha256")

    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "value.txt"), "value\n")
      const rejected = await createReadFileTool().execute(
        { path: "value.txt", expectedSha256: "0".repeat(64) },
        { workspaceRoot: workspace },
      )
      expect(rejected).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
      })
    })
  })

  it("reports newline style and final-newline state", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "lf.txt"), "one\ntwo\n")
      await writeFile(join(workspace, "crlf.txt"), "one\r\ntwo\r\n")
      await writeFile(join(workspace, "mixed.txt"), "one\r\ntwo\nthree\r")
      await writeFile(join(workspace, "none.txt"), "one")
      const read = createReadFileTool()

      expect(
        await read.execute({ path: "lf.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: { lineEnding: "LF", finalNewline: true, lineCount: 2 },
      })
      expect(
        await read.execute({ path: "crlf.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: { lineEnding: "CRLF", finalNewline: true, lineCount: 2 },
      })
      expect(
        await read.execute({ path: "mixed.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: { lineEnding: "mixed", finalNewline: true, lineCount: 3 },
      })
      expect(
        await read.execute({ path: "none.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: { lineEnding: "none", finalNewline: false, lineCount: 1 },
      })
    })
  })

  it("detects CRLF across stream chunk boundaries", async () => {
    await withWorkspace(async (workspace) => {
      const body = `${"x".repeat(65_535)}\r\nnext`
      await writeFile(join(workspace, "boundary.txt"), body)
      const result = await createReadFileTool().execute(
        { path: "boundary.txt", offset: 2, limit: 1 },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          sha256: sha256(body),
          lineCount: 2,
          lineEnding: "CRLF",
          finalNewline: false,
          content: "2\tnext",
        },
      })
    })
  })

  it("caps each displayed line while preserving its head and tail", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, "long.txt"),
        `const start = "${"x".repeat(500)}-tail"\n`,
      )
      const result = await createReadFileTool(50 * 1024, 2_000, 80).execute(
        { path: "long.txt" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          truncated: true,
          truncatedByLineLength: true,
          truncatedLineCount: 1,
          lineCharacterLimit: 80,
          content: expect.stringContaining("[line truncated]"),
        },
      })
      if (!result.ok || !isObject(result.output)) return
      const displayed = String(result.output.content).split("\n")[0] ?? ""
      expect(displayed.length).toBeLessThanOrEqual(80)
      expect(displayed).toContain("const start")
      expect(displayed).toContain('-tail"')
    })
  })

  it("records a self-contained result for an unchanged duplicate range", async () => {
    await withWorkspace(async (workspace) => {
      const body = "one\ntwo\n"
      await writeFile(join(workspace, "same.txt"), body)
      const observations = createFileObservationStore()
      const context = {
        workspaceRoot: workspace,
        fileObservations: observations,
      }
      const first = await createReadFileTool().execute(
        { path: "same.txt", offset: 1, limit: 2 },
        context,
      )
      expect(first.ok).toBe(true)
      if (!first.ok) return
      observations.recordSuccess(
        "read_file",
        { path: "same.txt" },
        first.output,
      )

      const duplicate = await createReadFileTool().execute(
        { path: "same.txt", offset: 1, limit: 2 },
        context,
      )
      expect(duplicate).toMatchObject({
        ok: true,
        output: {
          sha256: sha256(body),
          content: "1\tone\n2\ttwo",
        },
      })
    })
  })

  it("reports empty, binary, directory, bounds, sensitive paths, and suggestions", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "empty.txt"), "")
      await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2]))
      await writeFile(join(workspace, "correct-name.txt"), "text")
      await writeFile(join(workspace, ".env.local"), "TOKEN=secret")
      await mkdir(join(workspace, "folder"))
      const read = createReadFileTool()

      expect(
        await read.execute({ path: "empty.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: { empty: true, lineCount: 0, content: "(File is empty.)" },
      })
      expect(
        await read.execute(
          { path: "binary.dat" },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "binary_file",
      })
      expect(
        await read.execute({ path: "folder" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: false,
        code: "directory_not_supported",
      })
      expect(
        await read.execute(
          { path: "correct-name.txt", offset: 2 },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "offset_out_of_bounds",
        output: { lineCount: 1 },
      })
      expect(
        await read.execute(
          { path: ".env.local" },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "sensitive_path",
      })
      const typo = await read.execute(
        { path: "corect-name.txt" },
        { workspaceRoot: workspace },
      )
      expect(typo).toMatchObject({ ok: false, code: "path_not_found" })
      if (!typo.ok)
        expect(typo.message).toContain('Did you mean "correct-name.txt"?')
    })
  })
})

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "yakitori-read-contract-"))
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
