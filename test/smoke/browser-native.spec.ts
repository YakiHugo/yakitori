import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

test("managed tabs preserve popup openers and armed unload during slow navigation", async () => {
  test.skip(
    process.platform !== "darwin",
    "Native Chromium widget acceptance runs on macOS.",
  )
  const root = await mkdtemp(join(tmpdir(), "yakitori-browser-workspace-"))
  try {
    const { build } = await import("vite")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      build: {
        ssr: true,
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: {
            "browser-workspace": resolve("src/desktop/workspace-browser.ts"),
          },
          formats: ["es"],
        },
        rollupOptions: { external: ["electron", /^node:/] },
      },
    })
    const { stdout } = await promisify(execFile)(
      resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      [
        resolve("test/fixtures/browser-workspace-native.cjs"),
        join(root, "browser-workspace.js"),
        join(root, "profile"),
        resolve("src/desktop/preload.cjs"),
      ],
      {
        timeout: 35_000,
        killSignal: "SIGKILL",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "ELECTRON_RUN_AS_NODE",
          ),
        ),
      },
    )
    expect(stdout).toContain("BROWSER_WORKSPACE:passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unfocused embedded Chromium delivers cold clicks without OS focus", async () => {
  test.skip(
    process.platform !== "darwin",
    "Native Chromium widget acceptance runs on macOS.",
  )
  const root = await mkdtemp(join(tmpdir(), "yakitori-browser-native-"))
  try {
    const { build } = await import("vite")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      build: {
        ssr: true,
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: {
            "browser-connection": resolve("src/desktop/browser-observation.ts"),
          },
          formats: ["es"],
        },
        rollupOptions: { external: ["electron", /^node:/] },
      },
    })
    const child = spawn(
      resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      [
        resolve("test/fixtures/browser-native.cjs"),
        join(root, "browser-connection.js"),
        join(root, "profile"),
      ],
      {
        detached: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "ELECTRON_RUN_AS_NODE",
          ),
        ),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = "",
      stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const stopOwnedGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch (cause) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ESRCH"
            )
          )
            throw cause
        }
      }
    }
    // Descendants can retain stdio after the owned Electron main exits.
    child.once("exit", stopOwnedGroup)
    const timer = setTimeout(stopOwnedGroup, 15_000)
    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      expect(result, [stdout, stderr].join("\n")).toEqual({
        code: 0,
        signal: null,
      })
      const report = stdout
        .split("\n")
        .find((line) => line.startsWith("BROWSER_NATIVE:"))
      expect(report).toBeDefined()
      const rows: unknown = JSON.parse(
        report?.slice("BROWSER_NATIVE:".length) ?? "null",
      )
      expect(rows).toEqual(
        ["click", "double-click", "hover"].map((action) => ({
          action,
          trusted: true,
          osFocus: false,
          focusRestored: true,
        })),
      )
    } finally {
      clearTimeout(timer)
      stopOwnedGroup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
