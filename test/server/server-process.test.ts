import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { runYakitoriServerProcess } from "../../src/server/server-process.ts"

describe("runYakitoriServerProcess", () => {
  it("refuses to bind a non-loopback host because the server has no auth", async () => {
    await expect(
      runYakitoriServerProcess({
        host: "0.0.0.0",
        port: 0,
        application: {},
        onListening: () => {},
      }),
    ).rejects.toThrow(
      'Refusing to bind the Yakitori server to non-loopback host "0.0.0.0": ' +
        "the server has no authentication mechanism and must bind a loopback address.",
    )
  })

  it("binds on loopback, serves, and shuts down cleanly", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-server-"))
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-workspace-"))
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    let resolveListening: ((url: string) => void) | undefined
    const listening = new Promise<string>((resolve) => {
      resolveListening = resolve
    })
    try {
      const run = runYakitoriServerProcess({
        host: "127.0.0.1",
        port: 0,
        application: {
          rootDir,
          workspace,
          userConfigPath: join(rootDir, "config.toml"),
        },
        onListening: (url) => resolveListening?.(url),
      })
      const url = await listening
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const health = await fetch(`${url}/health`)
      expect(health.status).toBe(200)

      process.emit("SIGINT")
      await run
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      exitSpy.mockRestore()
      await rm(rootDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
