import { execFile } from "node:child_process"
import { realpath, readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"
import {
  createSmokeEnvironment,
  runBudgetedGoal,
  runFauxTurn,
  runExternalEngineFlow,
  runProviderFlow,
  smokePdfBytes,
} from "./fixtures.ts"

const execFileAsync = promisify(execFile)

test("packaged desktop boots its GUI and bridge, then stops its sidecar on quit", async ({
  playwright,
}, testInfo) => {
  test.skip(
    process.platform !== "darwin",
    "The shipping artifact is a macOS app.",
  )
  const fixture = await createSmokeEnvironment()
  const userData = join(await realpath(fixture.root), "electron-user-data")
  let application: ElectronApplication | undefined
  let page: Page | undefined
  let mainPid: number | undefined
  let sidecarPid: number | undefined
  const rendererErrors: string[] = []
  const logs: string[] = []
  const tracePath = testInfo.outputPath("desktop-renderer-trace.zip")
  let tracing = false
  let traceSaved = false
  async function stopRendererTrace(): Promise<void> {
    if (!tracing || application === undefined) return
    tracing = false
    try {
      await application.context().tracing.stop({ path: tracePath })
      traceSaved = true
    } catch (error) {
      // Diagnostics must not replace the failure or prevent app cleanup.
      logs.push(`Renderer trace capture failed: ${String(error)}`)
    }
  }
  try {
    application = await playwright._electron.launch({
      executablePath: resolve(
        "release/mac-arm64/Yakitori.app/Contents/MacOS/Yakitori",
      ),
      args: [`--user-data-dir=${userData}`],
      cwd: fixture.root,
      env: fixture.env,
      timeout: 30_000,
    })
    application.on("console", (message) => logs.push(message.text()))
    application.process().stderr?.on("data", (chunk: Buffer) => {
      logs.push(chunk.toString())
    })
    const child = application.process()
    if (child.pid === undefined)
      throw new Error("Electron process PID is missing.")
    mainPid = child.pid
    // This manually launched context is separate from Playwright's test trace.
    await application.context().tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    })
    tracing = true
    page = await application.firstWindow()
    page.on("pageerror", (error) => rendererErrors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") logs.push(message.text())
    })
    await expect
      .poll(async () => {
        const { stdout } = await execFileAsync("/bin/ps", [
          "-axo",
          "pid=,ppid=,command=",
        ])
        const sidecars = stdout.split("\n").flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
          return match !== null &&
            Number(match[2]) === child.pid &&
            match[3]?.includes("app.asar.unpacked/dist/desktop/server.js")
            ? [Number(match[1])]
            : []
        })
        sidecarPid = sidecars.length === 1 ? sidecars[0] : undefined
        return sidecarPid
      })
      .toBeDefined()

    expect(
      await application.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        userData: app.getPath("userData"),
      })),
    ).toEqual({ packaged: true, userData })
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
    const sidecarUrl = new URL(page.url())
    const health = await page.request.get(new URL("/health", sidecarUrl).href)
    await expect(health).toBeOK()
    expect(await health.json()).toEqual({ ok: true })

    const bridge = await page.evaluate(async () => {
      const desktop = window.yakitoriDesktop
      if (desktop === undefined)
        throw new Error("Desktop preload bridge is missing.")
      return {
        platform: desktop.platform,
        permission: await desktop.notifications.permission(),
      }
    })
    expect(bridge.platform).toBe("darwin")
    expect(["granted", "unsupported"]).toContain(bridge.permission)
    await runFauxTurn(page)
    await runBudgetedGoal(page)
    const downloadPath = testInfo.outputPath("ordered-smoke.pdf")
    await application.evaluate(({ BrowserWindow }, path) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error("Desktop window missing")
      window.webContents.session.once("will-download", (_event, item) =>
        item.setSavePath(path),
      )
    }, downloadPath)
    await runProviderFlow(page, testInfo, {
      downloadPdf: async () => {
        if (page === undefined) throw new Error("Desktop page missing")
        await page
          .getByRole("main")
          .getByRole("link", { name: "Download PDF", exact: true })
          .click()
        await expect
          .poll(async () => {
            try {
              return (await readFile(downloadPath)).equals(smokePdfBytes)
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return false
              throw error
            }
          })
          .toBe(true)
        return readFile(downloadPath)
      },
    })
    await runExternalEngineFlow(page)
    expect(rendererErrors).toEqual([])

    // Export while the renderer is alive, including for later quit failures.
    await stopRendererTrace()
    // Playwright's graceful close invokes the real app.quit(). It must finish
    // the main process's will-quit handler before either process disappears.
    await closeApplication(application)
    application = undefined
    expect(child.exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
    if (sidecarPid === undefined)
      throw new Error("Sidecar process PID is missing.")
    await expect.poll(() => processExists(sidecarPid)).toBe(false)
    await expect.poll(() => acceptsConnections(sidecarUrl)).toBe(false)
  } catch (error) {
    await stopRendererTrace()
    if (traceSaved) {
      try {
        await testInfo.attach("desktop-renderer-trace", {
          path: tracePath,
          contentType: "application/zip",
        })
      } catch (captureError) {
        logs.push(`Renderer trace attachment failed: ${String(captureError)}`)
      }
    }
    await testInfo.attach("desktop-diagnostics", {
      body: JSON.stringify({ rendererErrors, logs }, null, 2),
      contentType: "application/json",
    })
    if (page !== undefined && !page.isClosed()) {
      try {
        await testInfo.attach("desktop-failure", {
          body: await page.screenshot({ timeout: 5_000 }),
          contentType: "image/png",
        })
      } catch (captureError) {
        await testInfo.attach("screenshot-error", {
          body: String(captureError),
          contentType: "text/plain",
        })
      }
    }
    throw error
  } finally {
    try {
      await stopRendererTrace()
      if (application !== undefined) await closeApplication(application)
    } finally {
      try {
        if (mainPid !== undefined) killProcessGroup(mainPid)
        if (sidecarPid !== undefined)
          await expect.poll(() => processExists(sidecarPid)).toBe(false)
      } finally {
        await fixture.cleanup()
      }
    }
  }
})

async function closeApplication(
  application: ElectronApplication,
): Promise<void> {
  // A failed quit contract must not strand the CI runner. The exit signal is
  // asserted separately, so this cleanup deadline cannot turn a hang into a pass.
  const pid = application.process().pid
  if (pid === undefined) throw new Error("Electron process PID is missing.")
  const timeout = setTimeout(() => killProcessGroup(pid), 10_000)
  try {
    await application.close()
  } finally {
    clearTimeout(timeout)
  }
}

function killProcessGroup(pid: number): void {
  // Playwright 1.63 launches Electron detached on macOS. Its PID is the
  // private group ID, and the directly spawned sidecar inherits that group.
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error
  }
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) throw new Error("Process PID is missing.")
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false
    throw error
  }
}

function acceptsConnections(url: URL): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === "ECONNREFUSED") resolve(false)
      else reject(error)
    })
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new Error("Sidecar port probe timed out."))
    })
  })
}
