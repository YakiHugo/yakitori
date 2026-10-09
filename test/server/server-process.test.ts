import { mkdtemp, rm } from "node:fs/promises"
import { get } from "node:http"
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

  it.each([
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ])("binds on %s, reports a usable URL, and shuts down cleanly", async (host) => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-server-"))
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-workspace-"))
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    let resolveListening: ((url: string) => void) | undefined
    let rejectListening: ((error: unknown) => void) | undefined
    const listening = new Promise<string>((resolve, reject) => {
      resolveListening = resolve
      rejectListening = reject
    })
    try {
      const run = runYakitoriServerProcess({
        host,
        port: 0,
        application: {
          rootDir,
          workspace,
          userConfigPath: join(rootDir, "config.toml"),
        },
        onListening: (url) => resolveListening?.(url),
      })
      void run.catch((error: unknown) => rejectListening?.(error))
      const url = await listening
      const parsed = new URL(url)
      expect(["127.0.0.1", "[::1]"]).toContain(parsed.hostname)
      expect(Number(parsed.port)).toBeGreaterThan(0)
      // This request targets the test-owned loopback listener, never an HTTP proxy.
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(`${url}/health`, (response) => {
            response.resume()
            response.once("end", () => resolve(response.statusCode))
            response.once("error", reject)
          }).once("error", reject)
        },
      )
      expect(status).toBe(200)

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
