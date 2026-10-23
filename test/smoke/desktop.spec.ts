import { execFile } from "node:child_process"
import { once } from "node:events"
import { readFile, realpath } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { parse } from "smol-toml"
import {
  test as base,
  type ElectronApplication,
  expect,
  type Page,
} from "@playwright/test"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import {
  createSmokeEnvironment,
  runBudgetedGoal,
  runExternalEngineFlow,
  runFauxTurn,
  runIndependentSessionFlow,
  runProviderFlow,
  smokePdfBytes,
} from "./fixtures.ts"

const execFileAsync = promisify(execFile)

type DesktopSmoke = Readonly<{
  application: ElectronApplication
  page: Page
  userData: string
  sidecarUrl: URL
  rendererErrors: string[]
}>

const test = base.extend<{ desktop: DesktopSmoke }>({
  desktop: async ({ playwright }, use, testInfo) => {
    testInfo.skip(
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
    let diagnosticsAttached = false
    async function attachDiagnostics(): Promise<void> {
      if (diagnosticsAttached) return
      diagnosticsAttached = true
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

      await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
      const sidecarUrl = new URL(page.url())
      await use({ application, page, userData, sidecarUrl, rendererErrors })
      if (testInfo.status !== testInfo.expectedStatus) await attachDiagnostics()
      // Playwright gives test-scoped fixture teardown a separate bounded timeout.
      // Keep artifact export and shutdown acceptance out of the unchanged 60s
      // product-flow budget. Cleanup still has its own unchanged hard deadline.
      // https://playwright.dev/docs/test-timeouts#test-timeout
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
      await attachDiagnostics()
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
  },
})

test("packaged desktop boots its GUI and bridge, then stops its sidecar on quit", async ({
  desktop,
}, testInfo) => {
  const { application, page, userData, sidecarUrl, rendererErrors } = desktop
  expect(
    await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      userData: app.getPath("userData"),
    })),
  ).toEqual({ packaged: true, userData })
  const health = await page.request.get(new URL("/health", sidecarUrl).href)
  await expect(health).toBeOK()
  expect(await health.json()).toEqual({ ok: true })

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.minimize()
  })
  const bridge = await page.evaluate(async () => {
    const desktop = window.yakitoriDesktop
    if (desktop === undefined)
      throw new Error("Desktop preload bridge is missing.")
    await desktop.focusWindow()
    return {
      platform: desktop.platform,
      permission: await desktop.notifications.permission(),
    }
  })
  expect(bridge.platform).toBe("darwin")
  expect(
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window?.isVisible(), minimized: window?.isMinimized() }
    }),
  ).toEqual({ visible: true, minimized: false })
  expect(["granted", "unsupported"]).toContain(bridge.permission)
  await page
    .getByRole("button", { name: "Show workspace", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Add workspace tab", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Computer", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Connect computer", exact: true }),
  ).toBeEnabled()
  await expect(
    page.getByText(
      "Yakitori Computer requires macOS and the bundled native helper.",
      { exact: true },
    ),
  ).toHaveCount(0)
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
})

test("desktop independent sessions route cross-provider models and appear in the sidebar", async ({
  desktop,
}, testInfo) => {
  await runIndependentSessionFlow(desktop.page, testInfo)
  expect(desktop.rendererErrors).toEqual([])
})

test("desktop runtime settings persist subagent model selection to disk", async ({
  desktop,
}, testInfo) => {
  const { page, sidecarUrl, rendererErrors } = desktop
  const client = createAppRpcClient({ apiBase: sidecarUrl.origin })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Runtime", exact: true }).click()
  const control = page.getByRole("switch", { name: "Subagent model selection" })
  await expect(control).not.toBeChecked()
  await control.click()
  await expect
    .poll(
      async () =>
        (await client.request("config/read", {})).configuration.agents
          ?.exposeModelOverrides,
    )
    .toBe(true)
  const snapshot = await client.request("config/read", {})
  const user = snapshot.layers.find((layer) => layer.source === "user")
  if (user === undefined) throw new Error("User configuration is missing.")
  expect(parse(await readFile(user.path, "utf8")).agents).toEqual({
    expose_model_overrides: true,
  })
  await page.reload()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Runtime", exact: true }).click()
  await expect(control).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath("runtime-settings.png") })
  expect(rendererErrors).toEqual([])
})

test("desktop keeps model identity across account edits and preserves an unavailable choice", async ({
  desktop,
}, testInfo) => {
  const { page, sidecarUrl, rendererErrors } = desktop
  const endpoint = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ data: [{ id: "coder" }] }))
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing model catalog server")
  const client = createAppRpcClient({ apiBase: sidecarUrl.origin })
  const choice = { provider: "deepseek", model: "coder" }
  const selector = page.getByRole("button", { name: "Select model and effort" })
  try {
    for (const edited of [false, true]) {
      const displayName = edited ? "Renamed model" : "Friendly model"
      await client.request("provider/configuration/write", {
        id: "vendor-account",
        configuration: {
          name: edited ? "Renamed account" : "Original account",
          service: "deepseek",
          authentication: "none",
          baseURL: `http://127.0.0.1:${address.port}/${edited ? "edited" : "original"}/v1`,
          wireApi: edited ? "openai_responses" : "openai_chat_completions",
          models: [{ id: "coder", displayName }],
        },
      })
      if (!edited) await client.request("userPreference/write", choice)
      await page.reload()
      await expect(selector).toHaveText(displayName)
      expect(
        (await client.request("provider/list", {})).userPreference,
      ).toEqual(choice)
    }
    await client.request("provider/configuration/delete", {
      id: "vendor-account",
    })
    await page.reload()
    await expect(selector).toHaveText("Select model")
    expect((await client.request("provider/list", {})).userPreference).toEqual(
      choice,
    )
    await page.screenshot({
      path: testInfo.outputPath("model-unavailable.png"),
    })
    expect(rendererErrors).toEqual([])
  } finally {
    client.close()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
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

test("embedded browser selections attach editable excerpts to main and side drafts", async ({
  desktop,
}, testInfo) => {
  const { application, page, rendererErrors } = desktop
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(
      "<!doctype html><title>Excerpt source</title><p id=quote>Frozen browser excerpt</p>",
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing source server")
  const url = `http://127.0.0.1:${address.port}/`
  try {
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: /^Browser/ }).click()
    await page.getByRole("textbox", { name: "Browser address" }).fill(url)
    await page.getByRole("textbox", { name: "Browser address" }).press("Enter")
    await expect(
      page.getByRole("tab", { name: "Excerpt source", exact: true }),
    ).toBeVisible()
    const selectPageText = () =>
      application.evaluate(async ({ webContents }, sourceUrl) => {
        const contents = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === sourceUrl)
        if (!contents) throw new Error("Missing embedded browser")
        await contents.executeJavaScript(
          "(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('quote')); window.getSelection().removeAllRanges(); window.getSelection().addRange(range) })()",
        )
      }, url)
    await selectPageText()
    await page
      .getByRole("button", {
        name: "Add selected text to conversation",
        exact: true,
      })
      .click()
    const main = page
      .locator("main")
      .getByRole("button", { name: "Open excerpt 1: Excerpt source" })
    await expect(main).toContainText("Frozen browser excerpt")
    await expect(
      page.getByRole("textbox", { name: "Message the Mate" }),
    ).toBeFocused()
    await main.click()
    await page
      .getByRole("textbox", { name: "Excerpt comment (optional)" })
      .fill("Main feedback")
    await page.getByRole("button", { name: "Save comment" }).click()
    await expect(main).toContainText("Main feedback")
    const showWorkspace = page.getByRole("button", {
      name: "Show workspace",
      exact: true,
    })
    if (await showWorkspace.isVisible()) await showWorkspace.click()
    await page.getByRole("tab", { name: "Excerpt source", exact: true }).click()
    await selectPageText()
    await page
      .getByRole("button", {
        name: "Ask about selected text in side chat",
        exact: true,
      })
      .click()
    const side = page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Open excerpt 1: Excerpt source" })
    await expect(side).toContainText("Frozen browser excerpt")
    await side.click()
    await page
      .getByRole("textbox", { name: "Excerpt comment (optional)" })
      .fill("Side feedback")
    await page.getByRole("button", { name: "Save comment" }).click()
    await expect(side).toContainText("Side feedback")
    await expect(main).toContainText("Main feedback")
    await page.screenshot({
      path: testInfo.outputPath("browser-excerpt-drafts.png"),
      animations: "disabled",
    })
    expect(rendererErrors).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

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
