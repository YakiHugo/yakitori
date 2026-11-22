import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { resolveWorkspaceRoot } from "../../../src/runtime/tools/path-policy.ts"
import { createReadFileTool } from "../../../src/runtime/tools/read-file.ts"
import {
  captureTextFilePage,
  UnsupportedTextFileTypeError,
} from "../../../src/runtime/tools/read-file-page.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open) }
})

const execFileAsync = promisify(execFile)

describe("read_file contract", () => {
  it("uses 1-based live pagination with an internal revision for each page", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "lines.txt"), "one\ntwo\nthree\nfour\n")
      const read = createReadFileTool()

      const first = await read.execute(
        { path: "lines.txt", offset: 1, limit: 2 },
        { workspaceRoot: workspace },
      )
      expect(first).toMatchObject({
        ok: true,
        output: {
          path: "lines.txt",
          complete: false,
          truncated: true,
          truncatedByLines: true,
          range: { offset: 1, limit: 2, requestedLimit: 2 },
          continuation: { nextOffset: 3 },
          content: expect.stringContaining("1\tone\n\ttwo"),
          fileObservation: {
            kind: "ranged_read",
            sha256: sha256("one\ntwo\nthree\nfour\n"),
          },
        },
      })
      if (!first.ok) return
      expect(first.output).not.toHaveProperty("sha256")
      expect(first.output).not.toHaveProperty("lineCount")
      expect(first.content).toContain("file's current contents")

      await writeFile(
        join(workspace, "lines.txt"),
        "zero\none\ntwo\nthree\nfour\n",
      )
      const continued = await read.execute(
        { path: "lines.txt", offset: 3, limit: 2 },
        { workspaceRoot: workspace },
      )
      expect(continued).toMatchObject({
        ok: true,
        output: {
          complete: false,
          content: expect.stringContaining("3\ttwo\n\tthree"),
        },
      })

      expect(
        await read.execute(
          { path: "lines.txt", offset: 0 },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        message: "read_file offset must be a nonzero safe integer.",
      })
    })
  })

  it("anchors the first and tenth lines of a tail page using absolute line numbers", async () => {
    await withWorkspace(async (workspace) => {
      const path = "log.txt"
      const prefix = "entry\n".repeat(400_000)
      await writeFile(
        join(workspace, path),
        `${prefix}last-1\r\nlast-2\rlast-3\nlast-4`,
      )
      const result = await createReadFileTool().execute(
        { path, offset: -7, limit: 5 },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        content: expect.stringContaining(
          "399998\tentry\n\tentry\n400000\tentry\n\tlast-1\n\tlast-2",
        ),
        output: {
          range: { offset: 399998, limit: 5 },
          continuation: { nextOffset: 400003 },
        },
      })
    })
  })

  it.each([
    true,
    false,
  ])("checks whether a growing file retained the original prefix (append only: %s)", async (appendOnly) => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "log.txt")
      await writeFile(path, "previous\n")
      const realOpen = (
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        )
      ).open
      vi.mocked(open).mockImplementationOnce(async (target, flags) => {
        const handle = await realOpen(target, flags)
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, "stat")
          .mockImplementationOnce(stat)
          .mockImplementationOnce(async () => {
            if (appendOnly) await appendFile(path, "appended\n")
            else await writeFile(path, "changed prefix\nappended\n")
            return stat({ bigint: true })
          })
        return handle
      })
      const result = await createReadFileTool().execute(
        { path: "log.txt", offset: -1 },
        { workspaceRoot: workspace },
      )
      if (appendOnly) {
        expect(result).toMatchObject({
          ok: true,
          content: "1\tprevious",
          output: { fileObservation: { sha256: sha256("previous\n") } },
        })
      } else {
        expect(result).toMatchObject({
          ok: false,
          code: "file_changed_during_read",
        })
      }
    })
  })

  it("paginates directory entries in directory-first order without file observations", async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all([
        mkdir(join(workspace, "z-folder")),
        mkdir(join(workspace, "b-folder")),
        writeFile(join(workspace, "a.txt"), ""),
      ])
      const read = createReadFileTool()
      const context = { workspaceRoot: workspace }
      const first = await read.execute({ path: ".", limit: 2 }, context)
      expect(first).toMatchObject({
        ok: true,
        output: {
          entries: ["b-folder/", "z-folder/"],
          continuation: { nextOffset: 3 },
          truncated: true,
        },
      })
      expect(first.output).not.toHaveProperty("fileObservation")
      expect(
        await read.execute({ path: ".", offset: -1, limit: 2 }, context),
      ).toMatchObject({
        ok: true,
        output: { entries: ["a.txt"], truncated: false },
      })
    })
  })

  it("routes recognized media by signature and honors image capability", async () => {
    await withWorkspace(async (workspace) => {
      const read = createReadFileTool()
      const context = { workspaceRoot: workspace }
      await writeFile(
        join(workspace, "opaque"),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
      await writeFile(join(workspace, "unknown"), "%PDF-1.7")
      expect(
        await read.execute(
          { path: "opaque" },
          {
            ...context,
            documentReading: { images: true, nativePdf: false },
          },
        ),
      ).toMatchObject({
        ok: false,
        code: "binary_file",
        content: expect.stringContaining("view_image"),
      })
      expect(
        (await read.execute({ path: "opaque" }, context)).content,
      ).not.toContain("view_image")
      expect(await read.execute({ path: "unknown" }, context)).toMatchObject({
        ok: false,
        code: "binary_file",
        content: expect.stringContaining("read_document"),
      })
    })
  })

  it("reads a regular virtual file whose reported size is zero without claiming a revision", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const path = "dynamic.txt"
      await writeFile(join(workspaceRoot, path), "first\nlast\n")
      const realOpen = (
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        )
      ).open
      vi.mocked(open).mockImplementationOnce(async (target, flags) => {
        const handle = await realOpen(target, flags)
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, "stat").mockImplementation(async () =>
          Object.assign(await stat({ bigint: true }), { size: 0n }),
        )
        return handle
      })
      const result = await createReadFileTool().execute(
        { path, offset: -1 },
        { workspaceRoot },
      )
      expect(result).toMatchObject({
        ok: true,
        content: "2\tlast",
        output: {
          fileObservation: {
            kind: "ranged_read",
            ranges: [{ startLine: 2, endLine: 2 }],
          },
        },
      })
      expect(result.output).not.toHaveProperty("fileObservation.sha256")
    })
  })

  it("keeps model input bounded and rejects unknown revision arguments", async () => {
    const schema = createReadFileTool().inputSchema
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: 2_000 },
      },
    })
    expect(schema.properties).not.toHaveProperty("expectedSha256")

    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "value.txt"), "value\n")
      const read = createReadFileTool()
      expect(
        await read.execute(
          { path: "value.txt", expectedSha256: "0".repeat(64) },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({ ok: false, code: "invalid_tool_input" })
      expect(
        await read.execute(
          { path: "value.txt", limit: 0 },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({ ok: false, code: "invalid_tool_input" })
      expect(
        await read.execute(
          { path: "value.txt", limit: 2_001 },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: false,
        code: "invalid_tool_input",
        message: "read_file limit must be an integer from 1 through 2000.",
      })
    })
  })

  it("emits a revision and full metadata only for an undisplayed complete read", async () => {
    await withWorkspace(async (workspace) => {
      const body = "one\r\ntwo\r\n"
      await writeFile(join(workspace, "complete.txt"), body)
      const read = createReadFileTool()

      const complete = await read.execute(
        { path: "complete.txt" },
        { workspaceRoot: workspace },
      )
      expect(complete).toMatchObject({
        ok: true,
        output: {
          complete: true,
          sha256: sha256(body),
          byteCount: Buffer.byteLength(body),
          lineCount: 2,
          lineEnding: "CRLF",
          finalNewline: true,
          truncated: false,
        },
      })

      const suffix = await read.execute(
        { path: "complete.txt", offset: 2 },
        { workspaceRoot: workspace },
      )
      expect(suffix).toMatchObject({
        ok: true,
        output: { complete: false, lineCount: 2, content: "2\ttwo" },
      })
      if (!suffix.ok) return
      expect(suffix.output).not.toHaveProperty("sha256")
      expect(suffix.output).not.toHaveProperty("lineEnding")
    })
  })

  it("detects CRLF across stream chunk boundaries on a complete read", async () => {
    await withWorkspace(async (workspace) => {
      const body = `${"x".repeat(65_535)}\r\nnext`
      await writeFile(join(workspace, "boundary.txt"), body)
      const result = await createReadFileTool(100_000, 2_000, 100_000).execute(
        { path: "boundary.txt" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: true,
        output: {
          complete: true,
          sha256: sha256(body),
          lineCount: 2,
          lineEnding: "CRLF",
          finalNewline: false,
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
          complete: false,
          truncated: true,
          truncatedByLineLength: true,
          truncatedLineCount: 1,
          lineCharacterLimit: 80,
          content: expect.stringContaining("[line truncated]"),
        },
      })
      if (!result.ok || !isObject(result.output)) return
      expect(result.output).not.toHaveProperty("sha256")
      const displayed = String(result.output.content).split("\n")[0] ?? ""
      expect(displayed.length).toBeLessThanOrEqual(80)
      expect(displayed).toContain("const start")
      expect(displayed).toContain('-tail"')
    })
  })

  it("returns self-contained duplicate live pages", async () => {
    await withWorkspace(async (workspace) => {
      const body = "one\ntwo\n"
      await writeFile(join(workspace, "same.txt"), body)
      const read = createReadFileTool()
      const first = await read.execute(
        { path: "same.txt", offset: 1, limit: 2 },
        { workspaceRoot: workspace },
      )
      const duplicate = await read.execute(
        { path: "same.txt", offset: 1, limit: 2 },
        { workspaceRoot: workspace },
      )
      expect(first).toMatchObject({ ok: true })
      expect(duplicate).toMatchObject({
        ok: true,
        output: {
          complete: true,
          sha256: sha256(body),
          content: "1\tone\n\ttwo",
        },
      })
    })
  })

  it("reports empty, binary, directory listings, bounds, and suggestions", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "empty.txt"), "")
      await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2]))
      await writeFile(join(workspace, "correct-name.txt"), "text")
      await writeFile(join(workspace, ".env.local"), "TOKEN=secret")
      await writeFile(join(workspace, "..hidden.txt"), "dotdot")
      await mkdir(join(workspace, "folder"))
      await writeFile(join(workspace, "folder", "inside.ts"), "inside")
      const read = createReadFileTool()

      expect(
        await read.execute({ path: "empty.txt" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: {
          complete: true,
          sha256: sha256(""),
          empty: true,
          lineCount: 0,
          content: "(File is empty.)",
        },
      })
      expect(
        await read.execute(
          { path: "binary.dat" },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({ ok: false, code: "binary_file" })
      expect(
        await read.execute({ path: "folder" }, { workspaceRoot: workspace }),
      ).toMatchObject({
        ok: true,
        output: {
          kind: "directory",
          count: 1,
          content: expect.stringContaining("inside.ts"),
        },
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
        ok: true,
        output: { complete: true, content: expect.stringContaining("TOKEN") },
      })
      expect(
        await read.execute(
          { path: "..hidden.txt" },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: true,
        output: { content: expect.stringContaining("dotdot") },
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

  it("rejects FIFO streams instead of risking an unbounded read", async () => {
    if (process.platform === "win32") return
    await withWorkspace(async (workspace) => {
      await execFileAsync("mkfifo", [join(workspace, "events.fifo")])
      const result = await createReadFileTool().execute(
        { path: "events.fifo" },
        { workspaceRoot: workspace },
      )
      expect(result).toMatchObject({
        ok: false,
        code: "unsupported_file_type",
      })
    })
  })

  it("rechecks the opened descriptor before reading a special file", async () => {
    if (process.platform === "win32") return
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "opened.fifo")
      await execFileAsync("mkfifo", [path])

      await expect(
        captureTextFilePage({
          absolutePath: path,
          offset: 1,
          limit: 1,
          maxLineCharacters: 2_000,
        }),
      ).rejects.toBeInstanceOf(UnsupportedTextFileTypeError)
    })
  })

  it("validates UTF-8 only through the requested live page", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, "invalid-after-page.txt"),
        Buffer.concat([Buffer.from("visible\n"), Buffer.from([0xff])]),
      )
      const read = createReadFileTool()

      expect(
        await read.execute(
          { path: "invalid-after-page.txt", offset: 1, limit: 1 },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({
        ok: true,
        output: {
          complete: false,
          content: expect.stringContaining("1\tvisible"),
          continuation: { nextOffset: 2 },
        },
      })
      expect(
        await read.execute(
          { path: "invalid-after-page.txt" },
          { workspaceRoot: workspace },
        ),
      ).toMatchObject({ ok: false, code: "read_failed" })
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
