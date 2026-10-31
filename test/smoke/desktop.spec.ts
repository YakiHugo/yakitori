import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  test as base,
  type ElectronApplication,
  expect,
  type Page,
} from "@playwright/test"
import { parse } from "smol-toml"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import {
  computerPreviewCatalog,
  computerPreviewFrame,
} from "../fixtures/computer-preview.ts"
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
}) => {
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
  expect(rendererErrors).toEqual([])
})

test("desktop provider accounts, inference, downloads and removal cross the packaged bridge", async ({
  desktop,
}, testInfo) => {
  const { application, page, rendererErrors } = desktop
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
  expect(rendererErrors).toEqual([])
})

test("desktop external engines connect and finish their isolated conversation", async ({
  desktop,
}) => {
  await runExternalEngineFlow(desktop.page)
  expect(desktop.rendererErrors).toEqual([])
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
  const child = application.process(),
    pid = child.pid
  if (pid === undefined) throw new Error("Electron process PID is missing.")
  const timeout = setTimeout(() => killProcessGroup(pid), 10_000)
  try {
    // Closing Chromium's context can finish before Node observes Electron's
    // OS exit. Keep the same hard deadline through that actual exit boundary.
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "exit")
    await Promise.all([application.close(), exited])
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

test("agent browser observations and actions use the exact owned tab through real desktop IPC and approval", async ({
  desktop,
}, testInfo) => {
  const { page, application, userData, sidecarUrl, rendererErrors } = desktop
  // The fixture's Playwright connection must not race the production dialog
  // responder with its own automatic native dismissal.
  const ignoreDialog = () => {},
    bindDialogs = (page: Page) => {
      page.on("dialog", ignoreDialog)
    }
  application.context().on("page", bindDialogs)
  application.context().pages().forEach(bindDialogs)
  const client = createAppRpcClient({ apiBase: sidecarUrl.origin })
  const observed = Promise.withResolvers<void>(),
    releaseCompletion = Promise.withResolvers<void>(),
    failed = Promise.withResolvers<Error>()
  let modelCalls = 0,
    thirdRequests = 0,
    clearKeyUps = 0,
    frameAfterReady = 0
  const uploadPath = join(userData, "upload-你好.txt")
  const uploadText = "Owned upload 你好 🌍\n"
  const uploadDirectory = join(userData, "folder-你好")
  const uploadedDirectoryFiles: { path: string; text: string }[][] = []
  const uploadedFiles: { name: string; text: string }[][] = []
  const chooserFiles: { name: string; text: string }[][] = []
  const dialogReplies: { value: boolean; trusted: boolean }[] = []
  const promptReplies: { value: string | null; trusted: boolean }[] = []
  const dragReplies: { text: string; trusted: boolean }[] = []
  const downloadBytes = Buffer.from([0, 255, 1, 2, 3])
  let downloadArtifact: Record<string, unknown> | undefined
  const fileChoiceEvents: { type: string; trusted: boolean; count: number }[] =
    []
  const frameSelectEvents: {
    type: string
    values: string[]
    trusted: boolean
  }[] = []
  const framePointerEvents: { kind: string; trusted: boolean }[] = []
  const frameSubmittedValues: (string | null)[] = []
  let frameAfterObservation: Record<string, unknown> | undefined
  const frameObservations: Record<string, unknown>[] = []
  let frameCatalog: {
    frameReference: string
    frameId: string
    url: string
    main: boolean
    remote: boolean
    parentFrameId?: string
  }[] = []
  const captureReceipts: Record<string, unknown>[] = []
  const modelImages = new Set<string>()
  const keyboardEvents: {
    type: string
    key?: string
    trusted?: boolean
    meta?: boolean
    shift?: boolean
    value?: string
  }[] = []
  const pointerEvents: {
    type: string
    trusted: boolean
    button: number
    detail: number
    deltaX: number
    deltaY: number
    scrollTop: number
  }[] = []
  let wantedUrl = "",
    destinationUrl = "",
    navigationUrl = ""
  let observation: Record<string, unknown> | undefined,
    receipt: Record<string, unknown> | undefined,
    filledObservation: Record<string, unknown> | undefined,
    clearedObservation: Record<string, unknown> | undefined,
    clearReceipt: Record<string, unknown> | undefined,
    clickedObservation: Record<string, unknown> | undefined,
    shadowObservation: Record<string, unknown> | undefined,
    pointerReceipt: Record<string, unknown> | undefined,
    navigationReceipt: Record<string, unknown> | undefined,
    navigatedObservation: Record<string, unknown> | undefined,
    insertion:
      | {
          action: "type" | "fill"
          target: unknown
          reference: string
          text: string
        }
      | undefined
  const errors: string[] = []
  const toolResult = (
    messages: { role?: string; content?: unknown }[],
    key: string,
  ): Record<string, unknown> => {
    for (const message of [...messages].reverse()) {
      if (message.role !== "tool" || typeof message.content !== "string")
        continue
      let data: unknown
      try {
        // Chat appends image provenance markers after this tool's JSON text.
        data = JSON.parse(message.content.split("\n", 1)[0] ?? "")
      } catch (cause) {
        if (cause instanceof SyntaxError) {
          if (key === "delivered") break
          continue
        }
        throw cause
      }
      if (
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data) &&
        key in data
      )
        return data as Record<string, unknown>
      if (key === "delivered") break
    }
    const last = messages.findLast((message) => message.role === "tool")
    throw new Error(
      `Missing browser tool result ${key}: ${String(last?.content).slice(0, 512)}`,
    )
  }
  const textRequest = (
    observed: Record<string, unknown>,
    action: "type" | "fill",
    text: string,
    name = "Target field",
  ) => {
    const field = (
      observed.nodes as {
        name: string
        role: string
        inputReference?: string
      }[]
    ).find((node) => node.name === name && node.role === "textbox")
    if (!field?.inputReference)
      throw new Error("Missing exact text control reference")
    return {
      action,
      target: observed.target,
      reference: field.inputReference,
      text,
    }
  }
  const pointerRequest = (observed: Record<string, unknown>, name: string) => {
    const button = (
      observed.nodes as {
        role: string
        name: string
        elementReference?: string
      }[]
    ).find((node) => node.role === "button" && node.name === name)
    if (!button?.elementReference)
      throw new Error(`Missing captured browser button ${name}`)
    return {
      action: "click",
      target: observed.target,
      reference: button.elementReference,
    }
  }
  const framePress = (
    observed: Record<string, unknown>,
    kind: string,
    key: string,
    modifiers?: string[],
  ) => {
    const field = (
      observed.nodes as {
        role: string
        name: string
        elementReference?: string
      }[]
    ).find(
      (node) => node.role === "textbox" && node.name === `${kind} frame field`,
    )
    if (!field?.elementReference)
      throw new Error("Missing exact frame keyboard reference")
    return {
      action: "press",
      target: observed.target,
      reference: field.elementReference,
      key,
      ...(modifiers ? { modifiers } : {}),
    }
  }
  const source = createServer((request, response) => {
    if (
      request.method === "POST" &&
      [
        "/file-bytes",
        "/file-choice",
        "/directory-bytes",
        "/chooser-bytes",
        "/dialog-reply",
        "/prompt-reply",
        "/drag-reply",
      ].includes(request.url ?? "")
    ) {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        if (request.url === "/file-bytes") uploadedFiles.push(JSON.parse(body))
        else if (request.url === "/chooser-bytes")
          chooserFiles.push(JSON.parse(body))
        else if (request.url === "/directory-bytes")
          uploadedDirectoryFiles.push(JSON.parse(body))
        else if (request.url === "/dialog-reply")
          dialogReplies.push(JSON.parse(body))
        else if (request.url === "/prompt-reply")
          promptReplies.push(JSON.parse(body))
        else if (request.url === "/drag-reply")
          dragReplies.push(JSON.parse(body))
        else fileChoiceEvents.push(JSON.parse(body))
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.method === "POST" && request.url === "/frame-select") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        frameSelectEvents.push(JSON.parse(body))
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.method === "POST" && request.url === "/frame-pointer") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        framePointerEvents.push(JSON.parse(body))
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.method === "POST" && request.url === "/frame-ready") {
      frameAfterReady++
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/frame-after")) {
      frameSubmittedValues.push(
        new URL(request.url, "http://fixture.test").searchParams.get("field"),
      )
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><title>After frame</title><body onload="navigator.sendBeacon('/frame-ready','')"><label>After frame field<input value="submitted"></label><button onclick="navigator.sendBeacon('/dialog-reply',JSON.stringify({trusted:event.isTrusted,value:confirm('Owned confirmation?')}))">Native confirmation</button>`,
      )
      return
    }
    if (request.method === "POST" && request.url === "/keyboard-event") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        keyboardEvents.push(JSON.parse(body))
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.method === "POST" && request.url === "/pointer-event") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        pointerEvents.push(JSON.parse(body))
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.method === "POST" && request.url === "/key-up") {
      clearKeyUps++
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/frame-")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      const kind =
        request.url === "/frame-local"
          ? "Local"
          : request.url === "/frame-remote"
            ? "Remote"
            : "Nested"
      response.end(
        `<!doctype html><title>${kind} frame</title><form action="${new URL(wantedUrl).origin}/frame-after"><label>${kind} frame field<input name="field" value="${kind.toLowerCase()}"></label></form><button type="button" onclick="navigator.sendBeacon('/frame-pointer',JSON.stringify({kind:'${kind}',trusted:event.isTrusted}))">${kind} pointer</button>${kind === "Remote" ? `<label>Remote choices<select multiple oninput="navigator.sendBeacon('/frame-select',JSON.stringify({type:event.type,trusted:event.isTrusted,values:Array.from(this.selectedOptions,option=>option.value)}))" onchange="navigator.sendBeacon('/frame-select',JSON.stringify({type:event.type,trusted:event.isTrusted,values:Array.from(this.selectedOptions,option=>option.value)}))"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label><label>Remote files<input type="file" multiple oninput="navigator.sendBeacon('/file-choice',JSON.stringify({type:event.type,trusted:event.isTrusted,count:this.files.length}))" onchange="navigator.sendBeacon('/file-choice',JSON.stringify({type:event.type,trusted:event.isTrusted,count:this.files.length}));if(this.files.length)Promise.all(Array.from(this.files,async file=>({name:file.name,text:await file.text()}))).then(files=>fetch('/file-bytes',{method:'POST',body:JSON.stringify(files)}))"></label><button id="pick-hidden" type="button">Remote picker</button><script>document.getElementById('pick-hidden').onclick=()=>{const input=document.createElement('input');input.type='file';input.hidden=true;input.onchange=async()=>{const files=await Promise.all(Array.from(input.files,async file=>({name:file.name,text:await file.text()})));await fetch('/chooser-bytes',{method:'POST',body:JSON.stringify(files)})};document.body.append(input);input.click()};</script><label>Remote folder<input type="file" webkitdirectory onchange="Promise.all(Array.from(this.files,async file=>({path:file.webkitRelativePath,text:await file.text()}))).then(files=>fetch('/directory-bytes',{method:'POST',body:JSON.stringify(files)}))"></label>` : ""}${kind === "Remote" ? `<iframe style="width:350px;height:150px;border:4px solid blue;padding:5px;transform:rotate(-4deg) scale(.8);transform-origin:0 0" title="Nested remote scope" src="${new URL(wantedUrl).origin}/frame-nested"></iframe>` : ""}`,
      )
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/first")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        '<!doctype html><title>First owned source</title><label>First field<input value="first"></label>',
      )
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/second")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><title>Second owned source</title><body style="background:#113a66;min-height:1800px"><div style="position:absolute;left:400px;top:1000px;width:64px;height:64px;background:#12a05b"></div><label>Target field<input value="second" onfocus="this.setSelectionRange(this.value.length,this.value.length)" onkeyup="if(event.key==='Backspace')navigator.sendBeacon('/key-up','')"></label><label><input type="checkbox" checked>Approved option</label><button onclick="if(event.isTrusted)this.textContent='Clicked action'">Click action</button><div style="position:relative;width:160px;height:36px"><button style="width:100%;height:100%" onclick="this.textContent='Wrongly clicked'">Covered action</button><div style="position:absolute;inset:0;background:silver">Cover</div></div><div id="shadow"></div><script>const shadow=document.querySelector('#shadow').attachShadow({mode:'closed'});const button=document.createElement('button');button.textContent='Shadow action';button.addEventListener('click',event=>{if(event.isTrusted)button.textContent='Shadow clicked'});shadow.append(button);</script><div role="button" aria-label="Pointer surface" tabindex="0" id="pointer" style="width:240px;height:160px;overflow:auto"><div style="width:1200px;height:1200px">Scroll content</div></div><script>const surface=document.querySelector('#pointer');for(const type of ['mouseenter','wheel','contextmenu','dblclick','auxclick'])surface.addEventListener(type,event=>{if(type==='contextmenu')event.preventDefault();navigator.sendBeacon('/pointer-event',JSON.stringify({type,trusted:event.isTrusted,button:event.button??0,detail:event.detail??0,deltaX:event.deltaX??0,deltaY:event.deltaY??0,scrollTop:surface.scrollTop}));});surface.addEventListener('scroll',()=>navigator.sendBeacon('/pointer-event',JSON.stringify({type:'scroll',trusted:true,scrollTop:surface.scrollTop})));for(const type of ['keydown','keyup'])document.addEventListener(type,event=>navigator.sendBeacon('/keyboard-event',JSON.stringify({type,key:event.key,trusted:event.isTrusted,meta:event.metaKey,shift:event.shiftKey})));</script><form onsubmit="event.preventDefault();navigator.sendBeacon('/keyboard-event',JSON.stringify({type:'submit',value:this.elements.field.value}))"><label>Keyboard field<input name="field" value="draft"></label><button>Submit keys</button></form><iframe title="Local scope" src="/frame-local" style="display:block;width:400px;height:180px;border:5px solid red;padding:6px;transform:rotate(3deg) scale(.8);transform-origin:0 0"></iframe><iframe title="Remote scope" src="${new URL(wantedUrl).origin.replace("127.0.0.1", "localhost")}/frame-remote" style="display:block;width:500px;height:350px;border:5px solid red;padding:6px;transform:perspective(600px) rotateY(10deg);transform-origin:0 0"></iframe>`,
      )
      return
    }
    if (request.method === "GET" && request.url === "/jump") {
      response.writeHead(302, { location: "/third#arrived" })
      response.end()
      return
    }
    if (request.method === "GET" && request.url === "/native-download") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": downloadBytes.length,
        "content-disposition":
          "attachment; filename*=UTF-8''download-%E4%BD%A0%E5%A5%BD.bin",
      })
      response.end(downloadBytes)
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/third")) {
      thirdRequests++
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><title>Third owned source</title><label>Navigated field<input value="third"></label><script>window.originalPrompt=window.prompt;window.dragProbe=[];for(const type of ["mousedown","mousemove","mouseup","dragstart"])document.addEventListener(type,e=>dragProbe.push({type,target:e.target.getAttribute("aria-label"),x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted}))</script><button onclick="navigator.sendBeacon('/prompt-reply',JSON.stringify({trusted:event.isTrusted,value:prompt('Owned text?','default')}))">Native prompt</button><a href="/native-download" download>Native download</a><div role="button" aria-label="Native drag source" tabindex="0" draggable="true" style="width:120px;height:60px;margin:20px" ondragstart="event.dataTransfer.setData('text/plain','你好 猫 🌍')">Drag</div><div role="button" aria-label="Native drag destination" tabindex="0" style="width:150px;height:60px;margin:20px 240px" ondragover="event.preventDefault()" ondrop="event.preventDefault();navigator.sendBeacon('/drag-reply',JSON.stringify({trusted:event.isTrusted,text:event.dataTransfer.getData('text/plain')}))">Drop</div>`,
      )
      return
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "browser-model" }] }))
      return
    }
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      raw += chunk
    })
    request.on("end", async () => {
      try {
        const body = JSON.parse(raw) as {
          tools?: unknown[]
          messages?: { role?: string; content?: unknown }[]
        }
        for (const message of body.messages ?? []) {
          if (!Array.isArray(message.content)) continue
          for (const block of message.content) {
            if (
              typeof block !== "object" ||
              block === null ||
              block.type !== "image_url" ||
              typeof block.image_url?.url !== "string"
            )
              continue
            if (block.image_url.url.startsWith("data:image/jpeg;base64,"))
              modelImages.add(block.image_url.url)
          }
        }
        let tool: { name: string; input: unknown; id: string } | undefined
        let text = "Browser observation"
        if (body.tools?.length) {
          const step = modelCalls++
          if (step === 0)
            tool = {
              name: "tool_search",
              input: { query: "browser" },
              id: "find_browser",
            }
          else if (step === 1)
            tool = {
              name: "browser",
              input: { action: "list" },
              id: "list_browser",
            }
          else if (step === 2) {
            const listed = toolResult(body.messages ?? [], "tabs")
            const tab = (
              listed.tabs as { url: string; target: unknown }[]
            ).find((tab) => tab.url === wantedUrl)
            if (!tab) throw new Error("The second owned tab was not listed")
            tool = {
              name: "browser",
              input: { action: "observe", target: tab.target },
              id: "observe_browser",
            }
          } else if (step === 3) {
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: { action: "observe", target: previous.target },
              id: "observe_again",
            }
          } else if (step === 4) {
            const previous = toolResult(body.messages ?? [], "nodes")
            insertion = textRequest(previous, "type", "你好 🌍")
            tool = {
              name: "browser_input",
              input: insertion,
              id: "type_browser",
            }
          } else if (step === 5) {
            receipt = toolResult(body.messages ?? [], "textVerified")
            if (!insertion) throw new Error("Missing prior insertion")
            tool = {
              name: "browser_input",
              input: { ...insertion, text: "MUST_NOT_REPEAT" },
              id: "replay_browser",
            }
          } else if (step === 6) {
            if (
              !JSON.stringify(body.messages).includes(
                "Observe this document again before typing",
              )
            )
              throw new Error("Reused input reference was not refused")
            if (!insertion) throw new Error("Missing prior target")
            tool = {
              name: "browser",
              input: { action: "observe", target: insertion.target },
              id: "observe_input_receipt",
            }
          } else if (step === 7) {
            observation = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: textRequest(observation, "fill", "filled 内容"),
              id: "fill_browser",
            }
          } else if (step === 8) {
            if (!observation) throw new Error("Missing pre-fill observation")
            toolResult(body.messages ?? [], "textVerified")
            tool = {
              name: "browser",
              input: { action: "observe", target: observation.target },
              id: "observe_fill",
            }
          } else if (step === 9) {
            filledObservation = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: textRequest(filledObservation, "fill", ""),
              id: "clear_browser",
            }
          } else if (step === 10) {
            if (!filledObservation)
              throw new Error("Missing filled observation")
            clearReceipt = toolResult(body.messages ?? [], "textVerified")
            tool = {
              name: "browser",
              input: { action: "observe", target: filledObservation.target },
              id: "observe_clear",
            }
          } else if (step === 11) {
            clearedObservation = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: pointerRequest(clearedObservation, "Covered action"),
              id: "covered_browser_click",
            }
          } else if (step === 12) {
            if (
              !JSON.stringify(body.messages).includes(
                "no visible unoccluded click point",
              )
            )
              throw new Error("Covered browser click was not refused")
            if (!clearedObservation) throw new Error("Missing cleared target")
            tool = {
              name: "browser",
              input: { action: "observe", target: clearedObservation.target },
              id: "observe_after_covered",
            }
          } else if (step === 13) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: pointerRequest(current, "Click action"),
              id: "click_browser",
            }
          } else if (step === 14) {
            pointerReceipt = toolResult(body.messages ?? [], "point")
            tool = {
              name: "browser",
              input: { action: "observe", target: pointerReceipt.target },
              id: "observe_clicked",
            }
          } else if (step === 15) {
            clickedObservation = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: pointerRequest(clickedObservation, "Shadow action"),
              id: "click_closed_shadow",
            }
          } else if (step === 16) {
            const clicked = toolResult(body.messages ?? [], "point")
            tool = {
              name: "browser",
              input: { action: "observe", target: clicked.target },
              id: "observe_shadow_clicked",
            }
          } else if (step >= 17 && step <= 26) {
            if (step === 17)
              shadowObservation = toolResult(body.messages ?? [], "nodes")
            if (step % 2 === 0) {
              const previous = toolResult(body.messages ?? [], "point")
              tool = {
                name: "browser",
                input: { action: "observe", target: previous.target },
                id: `observe_pointer_${step}`,
              }
            } else {
              const previous = toolResult(body.messages ?? [], "nodes")
              const actions = [
                { action: "hover" },
                { action: "scroll", deltaX: 70, deltaY: 280 },
                { action: "click", button: "right" },
                { action: "click", clickCount: 2 },
                { action: "click", button: "middle" },
              ]
              const action = actions[(step - 17) / 2]
              if (!action) throw new Error("Missing pointer action")
              tool = {
                name: "browser_input",
                input: {
                  ...pointerRequest(previous, "Pointer surface"),
                  ...action,
                },
                id: `pointer_${step}`,
              }
            }
          } else if (step >= 27 && step <= 36) {
            if (step % 2 === 0) {
              const previous = toolResult(body.messages ?? [], "delivered")
              if (previous.action !== "press")
                throw new Error("Keyboard input was not acknowledged")
              tool = {
                name: "browser",
                input: { action: "observe", target: previous.target },
                id: `observe_key_${step}`,
              }
            } else {
              const previous = toolResult(body.messages ?? [], "nodes")
              const plans = [
                { name: "Keyboard field", key: "a", modifiers: ["Meta"] },
                { name: "Keyboard field", key: "r", modifiers: ["Shift"] },
                { name: "Keyboard field", key: "Tab" },
                { name: "Submit keys", key: "Enter" },
                { name: "Pointer surface", key: "t", modifiers: ["Meta"] },
              ]
              const plan = plans[(step - 27) / 2]
              const node = (
                previous.nodes as {
                  name: string
                  role: string
                  elementReference?: string
                }[]
              ).find(
                (node) =>
                  node.name === plan?.name &&
                  ["textbox", "button"].includes(node.role),
              )
              if (!plan || !node?.elementReference)
                throw new Error("Missing exact keyboard control")
              tool = {
                name: "browser_input",
                input: {
                  action: "press",
                  target: previous.target,
                  reference: node.elementReference,
                  key: plan.key,
                  ...(plan.modifiers ? { modifiers: plan.modifiers } : {}),
                },
                id: `press_${step}`,
              }
            }
          } else if (step >= 37 && step <= 39) {
            const current = toolResult(body.messages ?? [], "nodes")
            if (step > 37)
              captureReceipts.push(toolResult(body.messages ?? [], "capture"))
            if (step === 39)
              await application.evaluate(({ webContents }, url) => {
                const contents = webContents
                  .getAllWebContents()
                  .find((contents) => contents.getURL() === url)
                if (!contents) throw new Error("Missing zoomed capture target")
                contents.setZoomFactor(1.5)
              }, wantedUrl)
            tool = {
              name: "browser_capture",
              input: {
                action: "capture",
                target: current.target,
                mode: step === 37 ? "viewport" : step === 38 ? "page" : "clip",
                ...(step === 39
                  ? { clip: { x: 400, y: 1000, width: 64, height: 64 } }
                  : {}),
              },
              id: `capture_${step}`,
            }
          } else if (step === 40) {
            captureReceipts.push(toolResult(body.messages ?? [], "capture"))
            await application.evaluate(({ webContents }, url) => {
              const contents = webContents
                .getAllWebContents()
                .find((contents) => contents.getURL() === url)
              if (!contents) throw new Error("Missing capture target")
              contents.setZoomFactor(1.5)
            }, wantedUrl)
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: { action: "frames", target: current.target },
              id: "catalog_frames",
            }
          } else if (step === 41 || step === 44 || step === 47) {
            if (step === 41)
              frameCatalog = toolResult(body.messages ?? [], "frames")
                .frames as typeof frameCatalog
            else
              frameObservations.push(toolResult(body.messages ?? [], "nodes"))
            const path =
              step === 41
                ? "/frame-local"
                : step === 44
                  ? "/frame-remote"
                  : "/frame-nested"
            const selected = frameCatalog.find(
              (frame) => new URL(frame.url).pathname === path,
            )
            if (!selected) throw new Error(`Missing owned frame ${path}`)
            const current = toolResult(body.messages ?? [], "capture")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: current.target,
                frameReference: selected.frameReference,
              },
              id: `observe_frame_${step}`,
            }
          } else if (step === 42 || step === 45 || step === 50) {
            const current = toolResult(body.messages ?? [], "nodes")
            const kind =
              step === 42 ? "Local" : step === 45 ? "Remote" : "Nested"
            tool = {
              name: "browser_input",
              input: textRequest(
                current,
                step === 50 ? "type" : "fill",
                `${step === 50 ? "typed" : "filled"}_${kind}你好`,
                `${kind} frame field`,
              ),
              id: `type_frame_${step}`,
            }
          } else if (step === 43 || step === 46 || step === 49 || step === 51) {
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: previous.target,
                frameReference: previous.frameReference,
              },
              id: `verify_frame_${step}`,
            }
          } else if (step === 48) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: framePress(current, "Nested", "a", ["Meta"]),
              id: "select_nested_text",
            }
          } else if (step >= 52 && step <= 57) {
            const kind = step <= 53 ? "Local" : step <= 55 ? "Remote" : "Nested"
            if (step === 52)
              frameObservations.push(toolResult(body.messages ?? [], "nodes"))
            if (step % 2 === 0) {
              if (step > 52) toolResult(body.messages ?? [], "delivered")
              const selected = frameCatalog.find(
                (frame) =>
                  new URL(frame.url).pathname ===
                  `/frame-${kind.toLowerCase()}`,
              )
              if (!selected) throw new Error("Missing pointer frame")
              const current = toolResult(body.messages ?? [], "nodes")
              tool = {
                name: "browser",
                input: {
                  action: "observe",
                  target: current.target,
                  frameReference: selected.frameReference,
                },
                id: `observe_pointer_${kind}`,
              }
            } else {
              const current = toolResult(body.messages ?? [], "nodes")
              tool = {
                name: "browser_input",
                input: pointerRequest(current, `${kind} pointer`),
                id: `click_pointer_${kind}`,
              }
            }
          } else if (step === 58) {
            toolResult(body.messages ?? [], "delivered")
            const selected = frameCatalog.find(
              (frame) => new URL(frame.url).pathname === "/frame-remote",
            )
            if (!selected) throw new Error("Missing remote form frame")
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: current.target,
                frameReference: selected.frameReference,
              },
              id: "observe_remote_form",
            }
          } else if (step === 59) {
            const current = toolResult(body.messages ?? [], "nodes")
            const control = (
              current.nodes as {
                role: string
                name: string
                elementReference?: string
              }[]
            ).find(
              (node) =>
                node.role === "listbox" && node.name === "Remote choices",
            )
            if (!control?.elementReference)
              throw new Error("Missing remote select reference")
            tool = {
              name: "browser_input",
              input: {
                action: "select",
                target: current.target,
                reference: control.elementReference,
                options: [{ label: "Green" }, { index: 2 }],
              },
              id: "select_remote_options",
            }
          } else if (step === 60) {
            const selected = toolResult(body.messages ?? [], "delivered")
            if (
              selected.action !== "select" ||
              selected.selectionVerified !== true ||
              JSON.stringify(selected.values) !== JSON.stringify(["g", "b"]) ||
              selected.events !== "synthetic"
            )
              throw new Error("Remote selection receipt was not verified")
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: previous.target,
                frameReference: previous.frameReference,
              },
              id: "observe_selected_frame",
            }
          } else if (step === 61 || step === 63) {
            const current = toolResult(body.messages ?? [], "nodes")
            const control = (
              current.nodes as {
                role: string
                name: string
                elementReference?: string
              }[]
            ).find(
              (node) => node.role === "button" && node.name === "Remote files",
            )
            if (!control?.elementReference)
              throw new Error("Missing remote file input")
            tool = {
              name: "browser_upload",
              input: {
                action: "upload",
                target: current.target,
                reference: control.elementReference,
                fromUrl: (current.document as { url: string }).url,
                paths: step === 61 ? [uploadPath] : [],
              },
              id: step === 61 ? "provide_remote_file" : "clear_remote_file",
            }
          } else if (step === 62 || step === 64) {
            const selected = toolResult(body.messages ?? [], "filesVerified")
            if (
              selected.filesVerified !== true ||
              selected.cleared !== (step === 64)
            )
              throw new Error("File list receipt was not verified")
            if (step === 62)
              await expect.poll(() => uploadedFiles.length).toBe(1)
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: previous.target,
                frameReference: previous.frameReference,
              },
              id: `observe_file_selection_${step}`,
            }
          } else if (step === 65) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_chooser",
              input: {
                action: "arm",
                target: current.target,
                fromUrl: (current.document as { url: string }).url,
                frameReference: current.frameReference,
              },
              id: "arm_remote_picker",
            }
          } else if (step === 66) {
            const armed = toolResult(body.messages ?? [], "armed")
            if (armed.armed !== true)
              throw new Error("Remote chooser was not armed")
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: pointerRequest(current, "Remote picker"),
              id: "open_hidden_picker",
            }
          } else if (step === 67) {
            const clicked = toolResult(body.messages ?? [], "delivered")
            tool = {
              name: "browser_chooser",
              input: { action: "inspect", target: clicked.target },
              id: "inspect_hidden_picker",
            }
          } else if (step === 68) {
            const opened = toolResult(body.messages ?? [], "opened")
            if (
              opened.opened !== true ||
              typeof opened.elementReference !== "string"
            )
              throw new Error("No exact hidden file input was captured")
            tool = {
              name: "browser_upload",
              input: {
                action: "upload",
                target: opened.target,
                reference: opened.elementReference,
                fromUrl: opened.fromUrl,
                paths: [uploadPath],
              },
              id: "provide_hidden_file",
            }
          } else if (step === 69) {
            const selected = toolResult(body.messages ?? [], "filesVerified")
            if (selected.filesVerified !== true)
              throw new Error("Hidden file selection was not verified")
            await expect.poll(() => chooserFiles.length).toBe(1)
            tool = {
              name: "browser_chooser",
              input: { action: "disarm", target: selected.target },
              id: "disarm_remote_picker",
            }
          } else if (step === 70) {
            const disabled = toolResult(
              body.messages ?? [],
              "interceptionDisabled",
            )
            if (
              disabled.interceptionDisabled !== true ||
              disabled.armed !== false
            )
              throw new Error("File picker interception did not stop")
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: previous.target,
                frameReference: previous.frameReference,
              },
              id: "observe_after_hidden_picker",
            }
          } else if (step === 71) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_view",
              input: {
                action: "show",
                target: current.target,
                fromUrl: wantedUrl,
              },
              id: "display_directory_target",
            }
          } else if (step === 72) {
            const shown = toolResult(body.messages ?? [], "selectionApplied")
            if (shown.selectionApplied !== true || shown.visible !== true)
              throw new Error(
                "The requested browser tab did not become visible",
              )
            const current = toolResult(body.messages ?? [], "nodes")
            const control = (
              current.nodes as {
                role: string
                name: string
                elementReference?: string
              }[]
            ).find(
              (node) => node.role === "button" && node.name === "Remote folder",
            )
            if (!control?.elementReference)
              throw new Error("Missing remote directory input")
            tool = {
              name: "browser_upload",
              input: {
                action: "upload_directory",
                target: current.target,
                reference: control.elementReference,
                fromUrl: (current.document as { url: string }).url,
                paths: [uploadDirectory],
              },
              id: "provide_remote_directory",
            }
          } else if (step === 73) {
            const selected = toolResult(body.messages ?? [], "filesVerified")
            if (
              selected.action !== "upload_directory" ||
              selected.filesVerified !== true ||
              selected.events !== "chromium"
            )
              throw new Error("Directory selection receipt was not verified")
            await expect.poll(() => uploadedDirectoryFiles.length).toBe(1)
            await page
              .getByRole("button", { name: "Hide workspace", exact: true })
              .click()
            const previous = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: previous.target,
                frameReference: previous.frameReference,
              },
              id: "observe_directory_selection",
            }
          } else if (step === 74) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_input",
              input: framePress(current, "Remote", "Enter"),
              id: "submit_remote_form",
            }
          } else if (step === 75) {
            const receipt = toolResult(body.messages ?? [], "delivered")
            if (receipt.action !== "press" || receipt.key !== "Enter")
              throw new Error("Remote form key was not acknowledged")
            await expect.poll(() => frameAfterReady).toBe(1)
            tool = {
              name: "browser",
              input: { action: "frames", target: receipt.target },
              id: "catalog_after_frame_navigation",
            }
          } else if (step === 76) {
            const current = toolResult(body.messages ?? [], "frames")
            const selected = (
              current.frames as { url: string; frameReference: string }[]
            ).find((frame) => new URL(frame.url).pathname === "/frame-after")
            if (!selected) throw new Error("Missing navigated form frame")
            tool = {
              name: "browser",
              input: {
                action: "observe",
                target: current.target,
                frameReference: selected.frameReference,
              },
              id: "observe_submitted_frame",
            }
          } else if (step === 77) {
            frameAfterObservation = toolResult(body.messages ?? [], "nodes")
            const current = frameAfterObservation
            tool = {
              name: "browser_dialog",
              input: {
                action: "arm",
                target: current.target,
                frameReference: current.frameReference,
                fromUrl: (current.document as { url: string }).url,
                response: {
                  type: "confirm",
                  accept: false,
                  message: "Owned confirmation?",
                },
              },
              id: "arm_native_dialog",
            }
          } else if (step === 78) {
            const current = toolResult(body.messages ?? [], "nodes"),
              button = (
                current.nodes as { name: string; elementReference?: string }[]
              ).find((node) => node.name === "Native confirmation")
            if (!button?.elementReference)
              throw new Error("Missing native confirmation button")
            tool = {
              name: "browser_input",
              input: {
                action: "press",
                key: "Enter",
                target: current.target,
                reference: button.elementReference,
              },
              id: "trigger_native_dialog",
            }
          } else if (step === 79) {
            const current = toolResult(body.messages ?? [], "delivered")
            await expect.poll(() => dialogReplies.length).toBe(1)
            tool = {
              name: "browser_dialog",
              input: { action: "inspect", target: current.target },
              id: "inspect_native_dialog",
            }
          } else if (step === 80) {
            const current = toolResult(body.messages ?? [], "state")
            if (current.state !== "answered" || current.expired !== false)
              throw new Error("Native dialog response was not acknowledged")
            tool = {
              name: "browser_dialog",
              input: { action: "disarm", target: current.target },
              id: "disarm_native_dialog",
            }
          } else if (step === 81) {
            const current = frameAfterObservation
            if (!current) throw new Error("Missing submitted frame observation")
            tool = {
              name: "browser_navigate",
              input: {
                action: "navigate",
                target: current.target,
                fromUrl: wantedUrl,
                url: navigationUrl,
              },
              id: "navigate_browser",
            }
          } else if (step === 82) {
            navigationReceipt = toolResult(body.messages ?? [], "loaded")
            tool = {
              name: "browser",
              input: { action: "observe", target: navigationReceipt.target },
              id: "observe_navigation",
            }
          } else if (step === 83) {
            navigatedObservation = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_dialog",
              input: {
                action: "arm",
                target: navigatedObservation.target,
                fromUrl: destinationUrl,
                response: {
                  type: "prompt",
                  accept: true,
                  message: "Owned text?",
                  promptText: "你好 猫 🌍",
                },
              },
              id: "arm_native_prompt",
            }
          } else if (step === 84) {
            const current = toolResult(body.messages ?? [], "nodes"),
              button = (
                current.nodes as { name: string; elementReference?: string }[]
              ).find((node) => node.name === "Native prompt")
            if (!button?.elementReference)
              throw new Error("Missing native prompt button")
            tool = {
              name: "browser_input",
              input: {
                action: "press",
                key: "Enter",
                target: current.target,
                reference: button.elementReference,
              },
              id: "trigger_native_prompt",
            }
          } else if (step === 85) {
            const current = toolResult(body.messages ?? [], "delivered")
            await expect.poll(() => promptReplies.length).toBe(1)
            tool = {
              name: "browser_dialog",
              input: { action: "inspect", target: current.target },
              id: "inspect_native_prompt",
            }
          } else if (step === 86) {
            const current = toolResult(body.messages ?? [], "state")
            if (current.state !== "answered" || current.expired !== false)
              throw new Error("Native prompt response was not acknowledged")
            tool = {
              name: "browser_dialog",
              input: { action: "disarm", target: current.target },
              id: "disarm_native_prompt",
            }
          } else if (step === 87) {
            const current = toolResult(body.messages ?? [], "armed")
            if (current.armed !== false)
              throw new Error("Native prompt did not disarm")
            tool = {
              name: "browser",
              input: { action: "observe", target: current.target },
              id: "observe_restored_prompt",
            }
          } else if (step === 88) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_download",
              input: {
                action: "arm",
                target: current.target,
                fromUrl: destinationUrl,
                url: `${new URL(destinationUrl).origin}/native-download`,
              },
              id: "arm_native_download",
            }
          } else if (step === 89) {
            const current = toolResult(body.messages ?? [], "nodes"),
              link = (
                current.nodes as { name: string; elementReference?: string }[]
              ).find((node) => node.name === "Native download")
            if (!link?.elementReference)
              throw new Error("Missing native download link")
            tool = {
              name: "browser_input",
              input: {
                action: "press",
                key: "Enter",
                target: current.target,
                reference: link.elementReference,
              },
              id: "trigger_native_download",
            }
          } else if (step === 90) {
            const current = toolResult(body.messages ?? [], "downloadId")
            tool = {
              name: "browser_download",
              input: {
                action: "wait",
                target: current.target,
                downloadId: current.downloadId,
              },
              id: "await_native_download",
            }
          } else if (step === 91) {
            const current = toolResult(body.messages ?? [], "downloadId")
            if (current.state !== "completed")
              throw new Error("Native download did not finish")
            tool = {
              name: "browser_download",
              input: {
                action: "collect",
                target: current.target,
                downloadId: current.downloadId,
              },
              id: "collect_native_download",
            }
          } else if (step === 92) {
            downloadArtifact = toolResult(body.messages ?? [], "sha256")
            if (downloadArtifact.byteLength !== 5)
              throw new Error("Native download artifact size differs")
            tool = {
              name: "browser",
              input: { action: "observe", target: downloadArtifact.target },
              id: "observe_after_download",
            }
          } else if (step === 93) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_view",
              input: {
                action: "show",
                target: current.target,
                fromUrl: destinationUrl,
              },
              id: "show_native_drag_view",
            }
          } else if (step === 94) {
            const current = toolResult(body.messages ?? [], "nodes")
            tool = {
              name: "browser_drag",
              input: {
                ...pointerRequest(current, "Native drag source"),
                action: "prepare",
              },
              id: "prepare_native_drag",
            }
          } else if (step === 95) {
            const current = toolResult(body.messages ?? [], "dragId")
            tool = {
              name: "browser",
              input: { action: "observe", target: current.target },
              id: "observe_drag_destination",
            }
          } else if (step === 96) {
            const current = toolResult(body.messages ?? [], "nodes"),
              prepared = toolResult(body.messages ?? [], "dragId")
            tool = {
              name: "browser_drag",
              input: {
                ...pointerRequest(current, "Native drag destination"),
                action: "drop",
                dragId: prepared.dragId,
              },
              id: "deliver_native_drag",
            }
          } else if (step === 97) {
            const current = toolResult(body.messages ?? [], "native")
            if (current.delivered !== true || current.native !== true) {
              const probe = await application.evaluate(
                ({ webContents }, url) =>
                  webContents
                    .getAllWebContents()
                    .find((contents) => contents.getURL() === url)
                    ?.executeJavaScript("window.dragProbe"),
                destinationUrl,
              )
              throw new Error(
                "Native drag was not acknowledged: " +
                  JSON.stringify({ current, probe }),
              )
            }
            tool = {
              name: "browser",
              input: { action: "observe", target: current.target },
              id: "observe_after_drag",
            }
          } else {
            navigatedObservation = toolResult(body.messages ?? [], "nodes")
            observed.resolve()
            await releaseCompletion.promise
            text = "Observed and navigated the owned browser."
          }
        }
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: tool.id,
                  type: "function",
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input),
                  },
                },
              ],
            }
          : { role: "assistant", content: text }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          `data: ${JSON.stringify({ id: `browser_${modelCalls}`, object: "chat.completion.chunk", created: 1, model: "browser-model", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        )
      } catch (cause) {
        errors.push(String(cause))
        failed.resolve(
          cause instanceof Error ? cause : new Error(String(cause)),
        )
        response.writeHead(500)
        response.end("Owned browser fixture failed")
      }
    })
  })
  source.listen(0, "127.0.0.1")
  await once(source, "listening")
  const address = source.address()
  if (!address || typeof address === "string")
    throw new Error("Missing owned browser source")
  const origin = `http://127.0.0.1:${address.port}`
  wantedUrl = `${origin}/second#owned`
  navigationUrl = `${origin}/jump`
  destinationUrl = `${origin}/third#arrived`
  try {
    await writeFile(uploadPath, uploadText)
    await mkdir(join(uploadDirectory, "nested/empty"), { recursive: true })
    await writeFile(join(uploadDirectory, ".hidden"), "Hidden 你好 🌍")
    await writeFile(join(uploadDirectory, "nested/a.txt"), "Nested bytes")
    const helper = join(userData, "computer.cjs")
    await writeFile(
      helper,
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-computer',version:'1'}}:m.method==='tools/list'?{tools:['control','turn_ended'].map(name=>({name,inputSchema:{type:'object'}}))}:{content:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
    )
    await client.request("config/write", {
      keyPath: ["mcp_servers", "computer"],
      value: {
        command: process.execPath,
        args: [helper],
        enabled: true,
        required: true,
        enabled_tools: ["control"],
      },
    })
    await client.request("provider/configuration/write", {
      id: "browser-fixture",
      configuration: {
        name: "Browser fixture",
        service: "openai",
        authentication: "none",
        baseURL: `${origin}/v1`,
        wireApi: "openai_chat_completions",
        models: [
          {
            id: "browser-model",
            displayName: "Browser Model",
            inputModalities: ["text", "image"],
          },
        ],
      },
    })
    await client.request("userPreference/write", {
      provider: "openai",
      model: "browser-model",
    })
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(
      page.getByRole("combobox", { name: "New session project", exact: true }),
    ).toBeDisabled()
    await page
      .getByRole("button", { name: "Select model and effort", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Browser Model", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    for (const [url, title] of [
      [`${origin}/first`, "First owned source"],
      [wantedUrl, "Second owned source"],
    ]) {
      if (!url || !title) throw new Error("Invalid owned page fixture")
      await page
        .getByRole("button", { name: "Add workspace tab", exact: true })
        .click()
      await page.getByRole("menuitem", { name: /^Browser/ }).click()
      await page.getByRole("textbox", { name: "Browser address" }).fill(url)
      await page
        .getByRole("textbox", { name: "Browser address" })
        .press("Enter")
      await expect(
        page.getByRole("tab", { name: title, exact: true }),
      ).toBeVisible()
    }
    await page
      .getByRole("button", { name: "Hide workspace", exact: true })
      .click()
    await page
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("Inspect the owned browser tabs and read the second page.")
    await application.evaluate(({ webContents, session }) => {
      const entries: Record<string, unknown>[] = []
      Reflect.set(globalThis, "yakitoriBrowserProtocolTrace", entries)
      const profile = session.fromPartition(
        "persist:yakitori-workspace-browser",
      )
      const append = (entry: Record<string, unknown>) => {
        entries.push(entry)
        if (entries.length > 200) entries.shift()
      }
      for (const contents of webContents.getAllWebContents()) {
        if (contents.session !== profile) continue
        const debug = contents.debugger
        const send = debug.sendCommand.bind(debug)
        debug.sendCommand = async (method, params, sessionId) => {
          const entry = {
            method,
            sessionId,
            type: params?.type,
            key: params?.key,
            x: params?.x,
            y: params?.y,
            state: "pending",
            error: "",
            geometry: undefined as unknown,
            fileState: undefined as unknown,
            files: params?.files,
            completion: undefined as unknown,
          }
          append(entry)
          try {
            const result = await send(method, params, sessionId)
            if (method === "DOM.getBoxModel")
              entry.geometry = result.model?.content
            if (
              method === "Runtime.callFunctionOn" &&
              String(params?.functionDeclaration).startsWith(
                "function(scroll, point)",
              )
            )
              entry.geometry = result.result?.value
            if (
              method === "Runtime.callFunctionOn" &&
              Array.isArray(result.result?.value?.files)
            )
              entry.fileState = result.result.value
            if (params?.awaitPromise) entry.completion = result.result?.value
            entry.state = "done"
            return result
          } catch (cause) {
            entry.state = "failed"
            entry.error = String(cause)
            throw cause
          }
        }
        debug.on("message", (_event, method, params, parentSessionId) => {
          if (
            method === "Target.attachedToTarget" ||
            method === "Target.detachedFromTarget" ||
            method === "Page.fileChooserOpened"
          )
            append({ method, sessionId: params.sessionId, parentSessionId })
        })
      }
    })
    await page.getByRole("button", { name: "Send", exact: true }).click()
    // Cover real pointer hit testing once. The remaining decisions use the
    // same renderer/RPC handler, driven by keyed DOM requests rather than 96
    // compositor waits and repeated protocol round trips from the test runner.
    const firstApproval = await Promise.race([
      page.getByRole("button", { name: "Allow", exact: true }).elementHandle(),
      failed.promise.then((cause) => {
        throw cause
      }),
    ])
    if (!firstApproval) throw new Error("Missing initial permission button")
    await firstApproval.click()
    const approvalDriver = await page.evaluateHandle(
      ({ first, remaining }) => {
        const seen = new WeakSet<Element>([first])
        let accepted = 0,
          finish = () => {}
        const done = new Promise<void>((resolve) => {
          finish = resolve
        })
        const scan = () => {
          for (const button of document.querySelectorAll("button")) {
            if (
              button.textContent?.trim() !== "Allow" ||
              button.disabled ||
              !button.getClientRects().length ||
              seen.has(button)
            )
              continue
            seen.add(button)
            accepted++
            button.click()
            if (accepted === remaining) {
              observer.disconnect()
              finish()
            }
            break
          }
        }
        const observer = new MutationObserver(scan)
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["disabled"],
        })
        scan()
        return {
          done,
          stop() {
            observer.disconnect()
            finish()
          },
        }
      },
      { first: firstApproval, remaining: 96 },
    )
    try {
      await Promise.race([
        approvalDriver.evaluate((driver) => driver.done),
        failed.promise.then((cause) => {
          throw cause
        }),
      ])
    } finally {
      await approvalDriver.evaluate((driver) => driver.stop())
      await approvalDriver.dispose()
      await firstApproval.dispose()
    }
    await Promise.race([
      observed.promise,
      failed.promise.then((cause) => {
        throw cause
      }),
    ])
    const attached = () =>
      application.evaluate(({ webContents }, url) => {
        const target = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
        if (!target) throw new Error("Owned browser target disappeared")
        return target.debugger.isAttached()
      }, destinationUrl)
    expect(
      await application.evaluate(async ({ webContents }, url) => {
        const target = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
        if (!target) throw new Error("Missing native prompt target")
        return target.executeJavaScript(
          "({restored:window.prompt===window.originalPrompt,frames:document.querySelectorAll('iframe').length})",
        )
      }, destinationUrl),
    ).toEqual({ restored: true, frames: 0 })
    expect(await attached()).toBe(true)
    await expect(
      page.getByRole("button", { name: "Hide workspace", exact: true }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Reload page", exact: true }).click()
    await expect.poll(() => thirdRequests).toBe(2)
    await expect(
      page.getByRole("button", { name: "Reload page", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("textbox", { name: "Browser address", exact: true }),
    ).toHaveValue(destinationUrl)
    releaseCompletion.resolve()
    await expect(
      page
        .getByRole("main")
        .getByText("Observed and navigated the owned browser.", {
          exact: true,
        }),
    ).toBeVisible()
    await expect.poll(attached).toBe(false)
    expect(errors).toEqual([])
    expect(receipt).toMatchObject({ delivered: true, textVerified: true })
    expect(filledObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "textbox",
          name: "Target field",
          value: "filled 内容",
        }),
      ]),
    )
    // Chromium omits AX.value for an empty field. The input receipt verifies
    // its exact DOM value; the subsequent AX read independently locates it.
    expect(clearReceipt).toMatchObject({
      textVerified: true,
      bytes: 0,
      valueLength: 0,
    })
    expect(clearedObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "textbox", name: "Target field" }),
      ]),
    )
    await expect.poll(() => clearKeyUps).toBe(1)
    expect(pointerReceipt).toMatchObject({
      delivered: true,
      documentChanged: false,
      point: { x: expect.any(Number), y: expect.any(Number) },
    })
    expect(clickedObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "button", name: "Clicked action" }),
      ]),
    )
    expect(JSON.stringify(clickedObservation?.nodes)).not.toContain(
      "Wrongly clicked",
    )
    expect(shadowObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "button", name: "Shadow clicked" }),
      ]),
    )
    await expect
      .poll(() =>
        pointerEvents.some(
          (event) => event.type === "scroll" && event.scrollTop > 0,
        ),
      )
      .toBe(true)
    expect(pointerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mouseenter", trusted: true }),
        expect.objectContaining({
          type: "wheel",
          trusted: true,
          deltaX: 70,
          deltaY: 280,
        }),
        expect.objectContaining({
          type: "contextmenu",
          trusted: true,
          button: 2,
        }),
        expect.objectContaining({
          type: "dblclick",
          trusted: true,
          button: 0,
          detail: 2,
        }),
        expect.objectContaining({ type: "auxclick", trusted: true, button: 1 }),
      ]),
    )
    await expect
      .poll(() =>
        keyboardEvents.some(
          (event) => event.type === "submit" && event.value === "R",
        ),
      )
      .toBe(true)
    expect(keyboardEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "keydown",
          key: "a",
          trusted: true,
          meta: true,
        }),
        expect.objectContaining({
          type: "keydown",
          key: "R",
          trusted: true,
          shift: true,
        }),
        expect.objectContaining({ type: "keydown", key: "Tab", trusted: true }),
        expect.objectContaining({ type: "keyup", key: "Tab", trusted: true }),
        expect.objectContaining({
          type: "keydown",
          key: "Enter",
          trusted: true,
        }),
        expect.objectContaining({
          type: "keydown",
          key: "t",
          trusted: true,
          meta: true,
        }),
        expect.objectContaining({
          type: "keyup",
          key: "Meta",
          trusted: true,
          meta: false,
        }),
      ]),
    )
    expect(
      await application.evaluate(({ webContents, session }) => {
        const profile = session.fromPartition(
          "persist:yakitori-workspace-browser",
        )
        return webContents
          .getAllWebContents()
          .filter((contents) => contents.session === profile).length
      }),
    ).toBe(2)
    expect(frameObservations).toHaveLength(3)
    for (const [index, kind] of ["Local", "Remote", "Nested"].entries()) {
      const observedFrame = frameObservations[index]
      expect(observedFrame?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "textbox",
            name: `${kind} frame field`,
            value: `${kind === "Nested" ? "typed" : "filled"}_${kind}你好`,
          }),
        ]),
      )
      expect(observedFrame?.mainDocument).toMatchObject({ url: wantedUrl })
      expect(observedFrame?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "textbox",
            inputReference: expect.any(String),
            elementReference: expect.any(String),
          }),
        ]),
      )
    }
    await expect.poll(() => framePointerEvents.length).toBe(3)
    expect(framePointerEvents).toEqual(
      ["Local", "Remote", "Nested"].map((kind) => ({ kind, trusted: true })),
    )
    await expect.poll(() => frameSelectEvents.length).toBe(2)
    expect(frameSelectEvents).toEqual([
      { type: "input", trusted: false, values: ["g", "b"] },
      { type: "change", trusted: false, values: ["g", "b"] },
    ])
    expect(uploadedFiles).toEqual([
      [{ name: "upload-你好.txt", text: uploadText }],
    ])
    expect(dialogReplies).toEqual([{ value: false, trusted: true }])
    expect(promptReplies).toEqual([{ value: "你好 猫 🌍", trusted: true }])
    expect(dragReplies).toEqual([{ text: "你好 猫 🌍", trusted: true }])
    if (typeof downloadArtifact?.path !== "string")
      throw new Error("Missing durable download artifact")
    expect(await readFile(downloadArtifact.path)).toEqual(downloadBytes)
    expect(downloadArtifact.sha256).toBe(
      "4be72cf29a33b5f223067ab9d5dd9567e0c14978e6ed54e2d556ddc9e2cc6038",
    )
    expect(downloadArtifact.filename).toBe("download-你好.bin")
    expect(chooserFiles).toEqual([
      [{ name: "upload-你好.txt", text: uploadText }],
    ])
    expect(uploadedDirectoryFiles).toEqual([
      expect.arrayContaining([
        { path: "folder-你好/.hidden", text: "Hidden 你好 🌍" },
        { path: "folder-你好/nested/a.txt", text: "Nested bytes" },
      ]),
    ])
    expect(uploadedDirectoryFiles[0]).toHaveLength(2)
    await expect.poll(() => fileChoiceEvents.length).toBe(4)
    expect(fileChoiceEvents).toEqual([
      { type: "input", trusted: true, count: 1 },
      { type: "change", trusted: true, count: 1 },
      { type: "input", trusted: false, count: 0 },
      { type: "change", trusted: false, count: 0 },
    ])
    expect(frameSubmittedValues).toEqual(["filled_Remote你好"])
    expect(frameAfterObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "textbox",
          name: "After frame field",
          value: "submitted",
        }),
      ]),
    )
    const mainFrame = frameCatalog.find((frame) => frame.main)
    const remoteFrame = frameCatalog.find(
      (frame) => new URL(frame.url).pathname === "/frame-remote",
    )
    const nestedFrame = frameCatalog.find(
      (frame) => new URL(frame.url).pathname === "/frame-nested",
    )
    expect(remoteFrame).toMatchObject({
      remote: true,
      parentFrameId: mainFrame?.frameId,
    })
    expect(nestedFrame).toMatchObject({
      remote: true,
      parentFrameId: remoteFrame?.frameId,
    })
    expect(
      captureReceipts.map(
        (receipt) => (receipt.capture as { mode: string }).mode,
      ),
    ).toEqual(["viewport", "page", "clip"])
    expect(modelImages.size).toBe(3)
    const { default: sharp } = await import("sharp")
    const imageBytes = [...modelImages].map((url) =>
      Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64"),
    )
    const clipped = imageBytes[2]
    if (!clipped) throw new Error("Missing clipped model image")
    const decoded = await sharp(clipped)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const offset =
      (Math.floor(decoded.info.height / 2) * decoded.info.width +
        Math.floor(decoded.info.width / 2)) *
      decoded.info.channels
    expect(Math.abs((decoded.data[offset] ?? 0) - 18)).toBeLessThan(10)
    expect(Math.abs((decoded.data[offset + 1] ?? 0) - 160)).toBeLessThan(10)
    expect(Math.abs((decoded.data[offset + 2] ?? 0) - 91)).toBeLessThan(10)
    expect(captureReceipts[2]?.capture).toMatchObject({
      source: { x: 400, y: 1000, width: 64, height: 64 },
    })
    for (const bytes of imageBytes) {
      const metadata = await sharp(bytes).metadata()
      expect(metadata.width).toBeLessThanOrEqual(1600)
      expect(metadata.height).toBeLessThanOrEqual(1600)
    }
    await testInfo.attach("browser-capture-clip", {
      body: clipped,
      contentType: "image/jpeg",
    })
    expect(navigationReceipt).toMatchObject({
      loaded: true,
      url: destinationUrl,
    })
    expect(navigatedObservation?.document).toMatchObject({
      url: destinationUrl,
    })
    expect(navigatedObservation?.target).toEqual(observation?.target)
    expect(navigatedObservation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "textbox",
          name: "Navigated field",
          value: "third",
        }),
      ]),
    )
    expect(observation?.document).toMatchObject({
      url: wantedUrl,
      documentId: expect.any(String),
    })
    expect(observation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: expect.any(String),
          backendNodeId: expect.any(Number),
          role: "textbox",
          name: "Target field",
          value: "second你好 🌍",
          properties: expect.any(Object),
        }),
      ]),
    )
    expect(JSON.stringify(observation?.nodes)).not.toContain("First field")
    expect(observation?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "checkbox",
          name: "Approved option",
          properties: expect.objectContaining({ checked: "true" }),
        }),
      ]),
    )
    await testInfo.attach("owned-browser-observation", {
      body: JSON.stringify(observation, null, 2),
      contentType: "application/json",
    })
    expect(rendererErrors).toEqual([])
  } catch (cause) {
    const protocol = await application.evaluate(() =>
      Reflect.get(globalThis, "yakitoriBrowserProtocolTrace"),
    )
    await testInfo.attach("browser-model-diagnostics", {
      body: JSON.stringify({
        modelCalls,
        errors,
        observation,
        navigationReceipt,
        navigatedObservation,
        frameSubmittedValues,
        frameAfterReady,
        framePointerEvents,
        frameSelectEvents,
        uploadedFiles,
        uploadedDirectoryFiles,
        fileChoiceEvents,
        dialogReplies,
        promptReplies,
        downloadArtifact,
        dragReplies,
        protocol,
      }),
      contentType: "application/json",
    })
    throw cause
  } finally {
    application.context().off("page", bindDialogs)
    application
      .context()
      .pages()
      .forEach((page) => {
        page.off("dialog", ignoreDialog)
      })
    releaseCompletion.resolve()
    client.close()
    source.closeAllConnections()
    await new Promise<void>((resolve) => source.close(() => resolve()))
  }
})

test("packaged scripts compose approved MCP and browser calls through real desktop IPC", async ({
  desktop,
}) => {
  const { page, application, userData, sidecarUrl, rendererErrors } = desktop
  const client = createAppRpcClient({ apiBase: sidecarUrl.origin })
  const failed = Promise.withResolvers<Error>()
  let modelCalls = 0,
    url = ""
  const source = createServer((request, response) => {
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(
        '<!doctype html><title>Script source</title><label>Script field<input value="initial"></label>',
      )
      return
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "script-model" }] }))
      return
    }
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      raw += chunk
    })
    request.on("end", () => {
      try {
        const body = JSON.parse(raw) as {
          tools?: unknown[]
          messages?: {
            role?: string
            tool_call_id?: string
            content?: unknown
          }[]
        }
        let delta: Record<string, unknown> = {
            role: "assistant",
            content: "Script browser verified.",
          },
          finish = "stop"
        if (body.tools?.length) {
          if (modelCalls++ === 0) {
            const code = `const control = await tools.call('computer__control',{action:'fixture_effect'}); if(!control.ok) throw control;
const listed = await tools.call('browser',{action:'list'}); if(!listed.ok) throw listed;
const tab = listed.output.tabs.find(tab=>tab.url===args.url); if(!tab) throw 'Missing script tab';
const observed = await tools.call('browser',{action:'observe',target:tab.target}); if(!observed.ok) throw observed;
const node = observed.output.nodes.find(node=>node.name==='Script field'&&node.inputReference); if(!node) throw 'Missing script input';
const result = await tools.call('browser_input',{action:'fill',target:tab.target,reference:node.inputReference,text:'Script 你好 🌍'}); if(!result.ok) throw result;
const image = await tools.call('browser_capture',{action:'capture',mode:'viewport',target:tab.target}); if(!image.ok) throw image; show(image); return result.output;`
            delta = {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "script_call",
                  type: "function",
                  function: {
                    name: "run_script",
                    arguments: JSON.stringify({ code, arguments: { url } }),
                  },
                },
              ],
            }
            finish = "tool_calls"
          } else {
            const results = (body.messages ?? []).filter(
              (message) => message.role === "tool",
            )
            expect(results.map((message) => message.tool_call_id)).toEqual([
              "script_call",
            ])
            expect(JSON.stringify(results[0]?.content)).toContain(
              "textVerified",
            )
            // Chat Completions carries tool media in the following user batch.
            const blocks: unknown[] = (body.messages ?? []).flatMap(
              (message) =>
                Array.isArray(message.content) ? message.content : [],
            )
            expect(blocks).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "image_url",
                  image_url: expect.objectContaining({
                    url: expect.stringMatching(/^data:image\/jpeg;base64,/),
                  }),
                }),
              ]),
            )
          }
        }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          `data: ${JSON.stringify({ id: `script_${modelCalls}`, object: "chat.completion.chunk", created: 1, model: "script-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        )
      } catch (cause) {
        failed.resolve(
          cause instanceof Error ? cause : new Error(String(cause)),
        )
        response.writeHead(500)
        response.end("Owned script fixture failed")
      }
    })
  })
  source.listen(0, "127.0.0.1")
  await once(source, "listening")
  const address = source.address()
  if (!address || typeof address === "string")
    throw new Error("Missing script source")
  const origin = `http://127.0.0.1:${address.port}`
  url = `${origin}/page`
  const helper = join(userData, "script-computer.cjs"),
    log = join(userData, "script-computer.log")
  try {
    await writeFile(
      helper,
      `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return; if(m.method==='tools/call')fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params)+'\\n'); const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'script-computer',version:'1'}}:m.method==='tools/list'?{tools:['control','turn_ended'].map(name=>({name,inputSchema:{type:'object'}}))}:{content:[{type:'text',text:'Owned helper acknowledged'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
    )
    await client.request("config/write", {
      keyPath: ["mcp_servers", "computer"],
      value: {
        command: process.execPath,
        args: [helper],
        enabled: true,
        required: true,
        enabled_tools: ["control"],
      },
    })
    await client.request("provider/configuration/write", {
      id: "script-fixture",
      configuration: {
        name: "Script fixture",
        service: "openai",
        authentication: "none",
        baseURL: `${origin}/v1`,
        wireApi: "openai_chat_completions",
        models: [
          {
            id: "script-model",
            displayName: "Script Model",
            inputModalities: ["text", "image"],
          },
        ],
      },
    })
    await client.request("userPreference/write", {
      provider: "openai",
      model: "script-model",
    })
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await page
      .getByRole("button", { name: "Select model and effort", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Script Model", exact: true })
      .click()
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
      page.getByRole("tab", { name: "Script source", exact: true }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Hide workspace", exact: true })
      .click()
    await page
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("Run the owned script.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    for (let index = 0; index < 5; index++)
      await Promise.race([
        page.getByRole("button", { name: "Allow", exact: true }).click(),
        failed.promise.then((error) => {
          throw error
        }),
      ])
    await Promise.race([
      expect(
        page.getByText("Script browser verified.", { exact: true }).first(),
      ).toBeVisible(),
      failed.promise.then((error) => {
        throw error
      }),
    ])
    expect(modelCalls).toBe(2)
    await expect
      .poll(
        async () => (await client.request("computer/status", {})).inputOwner,
      )
      .toBeUndefined()
    expect(
      await application.evaluate(async ({ webContents }, url) => {
        const owned = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
        if (!owned) throw new Error("Missing owned script browser")
        return {
          value: await owned.executeJavaScript(
            "document.querySelector('input').value",
          ),
          attached: owned.debugger.isAttached(),
        }
      }, url),
    ).toEqual({ value: "Script 你好 🌍", attached: false })
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { name: string; arguments?: { action?: string } },
      )
    expect(
      calls.filter(
        (call) =>
          call.name === "control" &&
          call.arguments?.action === "fixture_effect",
      ),
    ).toHaveLength(1)
    expect(calls.filter((call) => call.name === "turn_ended")).toHaveLength(1)
    expect(
      (await client.request("computer/status", {})).inputOwner,
    ).toBeUndefined()
    expect(rendererErrors).toEqual([])
  } finally {
    client.close()
    source.closeAllConnections()
    await new Promise<void>((resolve) => source.close(() => resolve()))
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

test("packaged Chromium enumerates a directory for its owned cross-site frame", async ({
  desktop,
}) => {
  const directory = join(desktop.userData, "native-directory")
  await mkdir(join(directory, "nested/empty"), { recursive: true })
  await writeFile(join(directory, ".hidden"), "hidden")
  await writeFile(join(directory, "nested/a.txt"), "nested")
  const source = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(
      request.url === "/frame"
        ? '<label>Folder<input id="folder" type="file" webkitdirectory></label>'
        : `<button>Root</button><iframe src="http://localhost:${(source.address() as { port: number }).port}/frame"></iframe>`,
    )
  })
  source.listen(0, "127.0.0.1")
  await once(source, "listening")
  const address = source.address()
  if (!address || typeof address === "string")
    throw new Error("Missing owned directory fixture")
  try {
    const state = await desktop.application.evaluate(
      async (
        { BrowserWindow, WebContentsView, session },
        { url, directory },
      ) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("Missing owned host window")
        const view = new WebContentsView({
          webPreferences: {
            session: session.fromPartition(
              "persist:yakitori-workspace-browser",
            ),
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
          },
        })
        view.setBounds({ x: 0, y: 0, width: 1200, height: 1000 })
        window.contentView.addChildView(view)
        view.setVisible(false)
        const contents = view.webContents
        const debug = contents.debugger
        try {
          await contents.loadURL(url)
          if (contents.isLoadingMainFrame())
            await new Promise<void>((resolve) =>
              contents.once("did-stop-loading", () => resolve()),
            )
          view.setVisible(true)
          debug.attach("1.3")
          let frameSession: string | undefined
          debug.on("message", (_event, method, params) => {
            if (
              method === "Target.attachedToTarget" &&
              params.targetInfo?.type === "iframe"
            )
              frameSession = params.sessionId
          })
          await debug.sendCommand("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: "iframe", exclude: false }, { exclude: true }],
          })
          if (!frameSession) throw new Error("Missing owned child renderer")
          const { root } = await debug.sendCommand(
            "DOM.getDocument",
            {},
            frameSession,
          )
          const { nodeId } = await debug.sendCommand(
            "DOM.querySelector",
            { nodeId: root.nodeId, selector: "input" },
            frameSession,
          )
          await debug.sendCommand(
            "Runtime.evaluate",
            {
              expression:
                'window.completion = new Promise(resolve => { for(const type of ["change","cancel"]) folder.addEventListener(type,e=>resolve({type:e.type,trusted:e.isTrusted,files:Array.from(folder.files,f=>({path:f.webkitRelativePath,size:f.size}))}),{once:true}); })',
            },
            frameSession,
          )
          // Measure file selection, after the fixture's own view load/show and
          // debugger setup. Startup activation can finish during those awaits.
          const previousFocus = BrowserWindow.getFocusedWindow()?.id
          await debug.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: [directory] },
            frameSession,
          )
          const result = await debug.sendCommand(
            "Runtime.evaluate",
            {
              expression: "completion",
              awaitPromise: true,
              returnByValue: true,
            },
            frameSession,
          )
          return {
            ...result.result.value,
            focusUnchanged:
              BrowserWindow.getFocusedWindow()?.id === previousFocus,
          }
        } finally {
          if (debug.isAttached()) debug.detach()
          contents.close({ waitForBeforeUnload: false })
          window.contentView.removeChildView(view)
        }
      },
      { url: `http://127.0.0.1:${address.port}/`, directory },
    )
    expect(state).toMatchObject({
      type: "change",
      focusUnchanged: true,
      trusted: true,
      files: expect.arrayContaining([
        { path: "native-directory/.hidden", size: 6 },
        { path: "native-directory/nested/a.txt", size: 6 },
      ]),
    })
    expect(state.files).toHaveLength(2)
  } finally {
    source.closeAllConnections()
    await new Promise<void>((resolve) => source.close(() => resolve()))
  }
})

test("packaged preview recording decodes and saves WebM through Electron's download boundary", async ({
  desktop,
}) => {
  const { page, application, userData, rendererErrors } = desktop
  const frame = computerPreviewFrame()
  let captures = 0
  await page.routeWebSocket("**/rpc", (socket) => {
    const peer = socket.connectToServer()
    peer.onMessage((message) => socket.send(message))
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        peer.send(message)
        return
      }
      const request = JSON.parse(message) as { id?: number; method?: string }
      let result: unknown
      if (request.method === "computer/status")
        result = {
          available: true,
          connected: true,
          backend: "yakitori-native",
          serverName: "computer",
          tools: ["control"],
          permissions: { accessibility: true, screenRecording: true },
        }
      else if (request.method === "computer/preview/catalog")
        result = computerPreviewCatalog
      else if (request.method === "computer/preview/capture") {
        captures++
        result = frame
      } else if (request.method === "computer/preview/stop") result = {}
      else {
        peer.send(message)
        return
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
    })
  })
  // Only the native frame source is supplied. The packaged renderer, encoder,
  // video decoder and Electron download all execute their real implementations.
  await page.reload()
  await page
    .getByRole("button", { name: "Show workspace", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Add workspace tab", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Computer", exact: true }).click()
  const preview = page.getByRole("region", { name: "Live computer preview" })
  await preview
    .getByRole("button", { name: "Start preview", exact: true })
    .click()
  await expect(
    preview.getByRole("img", { name: "Live computer preview", exact: true }),
  ).toBeVisible()
  await preview
    .getByRole("button", { name: "Record preview", exact: true })
    .click()
  const startedAt = captures
  await expect.poll(() => captures).toBeGreaterThanOrEqual(startedAt + 2)
  await preview
    .getByRole("button", { name: "Stop preview", exact: true })
    .click()
  const video = preview.getByLabel("Recorded computer preview")
  await expect
    .poll(() =>
      video.evaluate((node) => ({
        width: (node as HTMLVideoElement).videoWidth,
        height: (node as HTMLVideoElement).videoHeight,
        ready: (node as HTMLVideoElement).readyState >= 2,
      })),
    )
    .toEqual({ width: 200, height: 100, ready: true })
  const destination = join(userData, "preview.webm")
  await application.evaluate(({ BrowserWindow }, destination) => {
    const renderer = BrowserWindow.getAllWindows()[0]?.webContents
    if (!renderer) throw new Error("Missing recording renderer")
    const completion = Promise.withResolvers<string>()
    Reflect.set(globalThis, "yakitoriRecordingSaved", completion.promise)
    // Choose this fixture's disposable destination in place of the OS save UI.
    renderer.session.once("will-download", (_event, item, contents) => {
      if (contents !== renderer) throw new Error("Unowned recording download")
      item.setSavePath(destination)
      item.once("done", (_event, state) => completion.resolve(state))
    })
  }, destination)
  await preview
    .getByRole("link", { name: "Save recording", exact: true })
    .click()
  const saved = await application.evaluate(async () => {
    const pending = Reflect.get(
      globalThis,
      "yakitoriRecordingSaved",
    ) as Promise<string>
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("The owned recording did not finish downloading"),
              ),
            10_000,
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
      Reflect.deleteProperty(globalThis, "yakitoriRecordingSaved")
    }
  })
  expect(saved).toBe("completed")
  expect([...(await readFile(destination)).subarray(0, 4)]).toEqual([
    26, 69, 223, 163,
  ])
  expect(rendererErrors).toEqual([])
})
