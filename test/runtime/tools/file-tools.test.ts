import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createReadFileTool,
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
        { path: "notes.txt", offset: 0, limit: 2 },
        { workspaceRoot: workspace },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.output).toMatchObject({
        path: "notes.txt",
        truncated: true,
        truncatedByLines: true,
        lineCount: 4,
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

      const updated = await write.execute(
        {
          path: "new.txt",
          content: "updated",
          expectedSha256: sha,
        },
        { workspaceRoot: workspace },
      )
      expect(updated.ok).toBe(true)
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("updated")
    })
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
