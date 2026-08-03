import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runRipgrepRecords } from "../../../src/runtime/tools/ripgrep.ts"

describe("bounded ripgrep records", () => {
  it("stops the child as soon as the consumer has enough records", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-ripgrep-"))
    try {
      await writeFile(
        join(workspace, "many.txt"),
        Array.from({ length: 1_000 }, () => "needle").join("\n"),
      )
      let matches = 0
      const result = await runRipgrepRecords(["--json", "--", "needle", "."], {
        cwd: workspace,
        timeoutMs: 20_000,
        maxBytes: 5 * 1024 * 1024,
        maxRecordBytes: 256 * 1024,
        delimiter: "newline",
        onRecord(record) {
          const event = JSON.parse(record) as { type?: string }
          if (event.type !== "match") return true
          matches += 1
          return false
        },
      })
      expect(result).toEqual({ ok: true, stopReason: "consumer_limit" })
      expect(matches).toBe(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("terminates on the raw byte ceiling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-ripgrep-"))
    try {
      await writeFile(
        join(workspace, "large.txt"),
        `needle ${"x".repeat(4_096)}\n`,
      )
      const result = await runRipgrepRecords(["--json", "--", "needle", "."], {
        cwd: workspace,
        timeoutMs: 20_000,
        maxBytes: 64,
        maxRecordBytes: 256 * 1024,
        delimiter: "newline",
        onRecord() {
          return true
        },
      })
      expect(result).toEqual({ ok: true, stopReason: "raw_byte_limit" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
