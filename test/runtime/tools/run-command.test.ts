import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createRunCommandTool } from "../../../src/index.ts"

describe("run_command process lifecycle", () => {
  it.skipIf(process.platform === "win32")(
    "kills descendants that ignore SIGTERM when the Turn is aborted",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "yakitori-command-"))
      try {
        const controller = new AbortController()
        const script = [
          'require("node:fs").writeFileSync("started.txt", "yes")',
          'process.on("SIGTERM", () => undefined)',
          'setTimeout(() => require("node:fs").writeFileSync("survived.txt", "yes"), 250)',
          "setInterval(() => undefined, 1000)",
        ].join(";")
        const execution = createRunCommandTool({ killGraceMs: 20 }).execute(
          {
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          },
          { workspaceRoot: workspace, signal: controller.signal },
        )

        await waitForFile(join(workspace, "started.txt"))
        controller.abort()
        await execution
        await new Promise((resolve) => setTimeout(resolve, 350))

        await expect(
          access(join(workspace, "survived.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )
})

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error(`Command did not create its start marker: ${path}`)
}
