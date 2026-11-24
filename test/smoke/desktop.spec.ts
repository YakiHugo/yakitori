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
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import {
  computerPreviewCatalog,
  computerPreviewFrame,
} from "../fixtures/computer-preview.ts"
import { createSmokeEnvironment, runFauxTurn } from "./fixtures.ts"

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
      // Product-flow smoke tests keep release discovery deterministic. The
      // dedicated updater smoke test exercises the real download boundary.
      await application.evaluate(() => {
        const request = globalThis.fetch
        globalThis.fetch = (input, init) =>
          String(input).startsWith(
            "https://api.github.com/repos/YakiHugo/yakitori/releases",
          )
            ? Promise.resolve(Response.json([]))
            : request(input, init)
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
  const { background, ...appInfo } = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    background: process.env.YAKITORI_TEST_BACKGROUND === "1",
  }))
  expect(appInfo).toEqual({ packaged: true, userData })
  const health = await page.request.get(new URL("/health", sidecarUrl).href)
  await expect(health).toBeOK()
  expect(await health.json()).toEqual({ ok: true })

  if (!background) {
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize()
    })
  }
  const bridge = await page.evaluate(async (background) => {
    const desktop = window.yakitoriDesktop
    if (desktop === undefined)
      throw new Error("Desktop preload bridge is missing.")
    if (!background) await desktop.focusWindow()
    return {
      platform: desktop.platform,
      permission: await desktop.notifications.permission(),
    }
  }, background)
  expect(bridge.platform).toBe("darwin")
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return {
          visible: window?.isVisible(),
          minimized: window?.isMinimized(),
        }
      }),
    )
    .toEqual({ visible: true, minimized: false })
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
  expect(rendererErrors).toEqual([])
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
      .getByRole("button", { name: "1 annotation" })
    await expect(main).toBeVisible()
    await expect(
      page.getByRole("textbox", { name: "Message the Mate" }),
    ).toBeFocused()
    await main.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText("Frozen browser excerpt")
    await page
      .getByRole("button", { name: "Edit excerpt 1: Excerpt source" })
      .click()
    await page
      .getByRole("textbox", { name: "Excerpt comment (optional)" })
      .fill("Main feedback")
    await page.getByRole("button", { name: "Save comment" }).click()
    await main.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText("Main feedback")
    await page.keyboard.press("Escape")
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
      .getByRole("button", { name: "1 annotation" })
    await expect(side).toBeVisible()
    await side.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText("Frozen browser excerpt")
    await page
      .getByRole("button", { name: "Edit excerpt 1: Excerpt source" })
      .click()
    await page
      .getByRole("textbox", { name: "Excerpt comment (optional)" })
      .fill("Side feedback")
    await page.getByRole("button", { name: "Save comment" }).click()
    await side.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText("Side feedback")
    await page.keyboard.press("Escape")
    await main.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText("Main feedback")
    await page.keyboard.press("Escape")
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

test("agent creates a tab, batches form input and inspects diagnostics through desktop IPC", async ({
  desktop,
}) => {
  const { page, sidecarUrl, userData, rendererErrors } = desktop
  const client = createAppRpcClient({ apiBase: sidecarUrl.origin })
  const failed = Promise.withResolvers<unknown>()
  const filePath = join(userData, "browser-fixture.txt")
  await writeFile(filePath, "yakitori upload")
  const submitted: string[] = []
  const uploads: string[] = []
  let formUrl = "",
    modelCalls = 0,
    tabId = ""
  const source = createServer((request, response) => {
    if (request.url === "/form") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(`<!doctype html><title>Agent browser form</title>
        <style>label{display:block} button{min-height:26px} output{display:block}</style>
        <label>Name<input id="name"></label>
        <label>City<input id="city"></label>
        <label>Size<select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
        <button id="submit">Send form</button>
        <input type="file" id="upload" hidden>
        <button id="picker">Choose local file</button><output id="result"></output>
        <div style="display:flex;gap:80px;margin:20px">
          <button draggable="true" id="source">Drag item</button>
          <button id="destination">Drop here</button>
        </div>
        <a id="download" href="/artifact" download="fixture.txt">Download report</a>
        <script>
          const element = (id) => document.getElementById(id);
          element('submit').onclick = async () => {
            await fetch('/api', {method:'POST',body:['name','city','size'].map(id=>element(id).value).join('/')});
            console.error('fixture console error');
            element('result').textContent = 'Form submitted';
          };
          element('picker').onclick = () => element('upload').click();
          element('upload').onchange = async () => fetch('/file', {method:'POST',body:await element('upload').files[0].text()});
          element('source').ondragstart = (event) => event.dataTransfer.setData('text/plain', 'dragged');
          element('destination').ondragover = (event) => event.preventDefault();
          element('destination').ondrop = (event) => { element('destination').textContent = event.dataTransfer.getData('text/plain'); };
        </script>`)
      return
    }
    if (request.url === "/artifact") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=fixture.txt",
      })
      response.end("owned browser artifact")
      return
    }
    if (
      !["/api", "/file", "/v1/chat/completions"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end()
      return
    }
    let raw = ""
    request.setEncoding("utf8").on("data", (chunk: string) => {
      raw += chunk
    })
    request.on("end", () => {
      if (request.url === "/api" || request.url === "/file") {
        ;(request.url === "/api" ? submitted : uploads).push(raw)
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"status":"ok"}')
        return
      }
      try {
        const body = JSON.parse(raw) as {
          tools?: { function?: { name?: string } }[]
          messages?: {
            role?: string
            tool_call_id?: string
            content?: unknown
          }[]
        }
        const calls: {
          id: string
          name: string
          input: Record<string, unknown>
        }[] = []
        const call = (
          id: string,
          name: string,
          input: Record<string, unknown>,
        ) => calls.push({ id, name, input })
        const resultText = (id: string) => {
          const message = body.messages?.findLast(
            (row) => row.role === "tool" && row.tool_call_id === id,
          )
          if (typeof message?.content !== "string")
            throw new Error(`Missing result for ${id}`)
          return message.content
        }
        const result = (id: string) => {
          const content = resultText(id)
          const line = content
            .split("\n")
            .find((entry) => entry.startsWith("{"))
          if (!line) throw new Error(`Invalid result for ${id}: ${content}`)
          return JSON.parse(line)
        }
        const ref = (name: string) => {
          const line = resultText("observe")
            .split("\n")
            .find((line) => line.includes(JSON.stringify(name)))
          const ref = line?.match(/\[(e\d+)\]/)?.[1]
          if (!ref)
            throw new Error(
              `Missing browser ref for ${name}\n${resultText("observe")}`,
            )
          return ref
        }
        if (body.tools?.length)
          switch (modelCalls++) {
            case 0:
              call("discover", "tool_search", {
                query: "browser",
              })
              break
            case 1: {
              const names = (result("discover").tools as { name: string }[])
                .map((tool) => tool.name)
                .filter((name) => name.startsWith("browser"))
              expect(names.sort()).toEqual([
                "browser_act",
                "browser_inspect",
                "browser_wait",
              ])
              call("tabs", "browser_inspect", { action: "tabs" })
              call("open", "browser_act", { action: "new_tab" })
              break
            }
            case 2:
              expect(result("tabs").tabs).toEqual([])
              tabId = result("open").tabId
              expect(tabId).toMatch(/^agent_tab_/)
              call("navigate", "browser_act", {
                action: "navigate",
                tabId,
                url: formUrl,
              })
              call("observe", "browser_inspect", {
                action: "snapshot",
                tabId,
                interactiveOnly: true,
              })
              break
            case 3:
              expect(result("navigate")).toMatchObject({
                tabId,
                loaded: true,
                url: formUrl,
              })
              expect(result("observe")).toMatchObject({
                tabId,
                consoleErrors: 0,
              })
              call("batch", "browser_act", {
                action: "batch",
                tabId,
                steps: [
                  { action: "fill", ref: ref("Name"), text: "Ada" },
                  { action: "fill", ref: ref("City"), text: "Shanghai" },
                  {
                    action: "select",
                    ref: ref("Size"),
                    options: [{ label: "Large" }],
                  },
                  { action: "click", ref: ref("Send form") },
                ],
              })
              call("wait", "browser_wait", {
                tabId,
                until: "text",
                value: "Form submitted",
              })
              call("upload", "browser_act", {
                action: "upload",
                tabId,
                ref: ref("Choose local file"),
                paths: [filePath],
              })
              call("drag", "browser_act", {
                action: "drag",
                tabId,
                fromRef: ref("Drag item"),
                toRef: ref("Drop here"),
              })
              call("download", "browser_act", {
                action: "download",
                operation: "arm",
                tabId,
                ref: ref("Download report"),
              })
              break
            case 4:
              expect(result("batch"), resultText("batch")).toMatchObject({
                completedSteps: 4,
              })
              expect(result("wait")).toMatchObject({ matched: true })
              expect(result("upload")).toMatchObject({ filesVerified: true })
              expect(result("drag")).toMatchObject({ native: true })
              call("screenshot", "browser_inspect", {
                action: "screenshot",
                mode: "ref",
                tabId,
                ref: ref("Name"),
              })
              call("console", "browser_inspect", { action: "console", tabId })
              call("network", "browser_inspect", { action: "network", tabId })
              call("download_wait", "browser_wait", {
                until: "download",
                tabId,
                downloadId: result("download").downloadId,
              })
              break
            case 5: {
              expect(result("screenshot")).toMatchObject({
                capture: { mode: "ref" },
                mediaType: "image/jpeg",
              })
              expect(result("console").entries).toContainEqual(
                expect.objectContaining({
                  level: "error",
                  message: "fixture console error",
                }),
              )
              const entry = (
                result("network").entries as {
                  id: string
                  url: string
                  status?: number
                  method: string
                }[]
              ).find((row) => row.url.endsWith("/api"))
              expect(entry).toMatchObject({ method: "POST", status: 200 })
              expect(result("download_wait")).toMatchObject({
                state: "completed",
              })
              call("request", "browser_inspect", {
                action: "network",
                tabId,
                requestId: entry?.id,
              })
              call("collect", "browser_act", {
                action: "download",
                operation: "collect",
                tabId,
                downloadId: result("download").downloadId,
              })
              break
            }
            default:
              expect(result("request")).toMatchObject({
                bodyAvailable: true,
                body: '{"status":"ok"}',
              })
              expect(result("collect")).toMatchObject({
                filename: "fixture.txt",
              })
          }
        const delta = calls.length
          ? {
              role: "assistant",
              tool_calls: calls.map(({ id, name, input }, index) => ({
                index,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              })),
            }
          : { role: "assistant", content: "Browser workflow verified." }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          `data: ${JSON.stringify({ id: `browser_${modelCalls}`, object: "chat.completion.chunk", created: 1, model: "browser-model", choices: [{ index: 0, delta, finish_reason: calls.length ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        )
      } catch (cause) {
        failed.resolve(cause)
        response.writeHead(500).end("Browser fixture failed")
      }
    })
  })
  source.listen(0, "127.0.0.1")
  await once(source, "listening")
  const address = source.address()
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address")
  const origin = `http://127.0.0.1:${address.port}`
  formUrl = `${origin}/form`
  const fixtureFailure = failed.promise.then((cause) => {
    throw cause
  })
  try {
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
    await page.getByRole("button", { name: "Select model and effort" }).click()
    await page
      .getByRole("button", { name: "Browser Model", exact: true })
      .click()
    await page
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("Open the site and submit the form.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    for (let index = 0; index < 7; index++)
      await Promise.race([
        page
          .getByRole("button", { name: "Allow", exact: true })
          .first()
          .click(),
        fixtureFailure,
      ])
    await Promise.race([
      expect(
        page.getByText("Browser workflow verified.", { exact: true }).first(),
      ).toBeVisible(),
      fixtureFailure,
    ])
    expect(submitted).toEqual(["Ada/Shanghai/l"])
    expect(uploads).toEqual(["yakitori upload"])
    await expect(
      page.getByRole("tab", { name: "Agent browser form", exact: true }),
    ).toHaveAttribute("aria-selected", "true")
    expect(rendererErrors).toEqual([])
  } finally {
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
  const clicks: { trusted: boolean }[] = []
  let modelCalls = 0,
    url = ""
  const source = createServer((request, response) => {
    if (request.url === "/cold-click") {
      let raw = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        raw += chunk
      })
      request.on("end", () => {
        clicks.push(JSON.parse(raw) as { trusted: boolean })
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(
        '<!doctype html><title>Script source</title><button onclick="navigator.sendBeacon(\'/cold-click\',JSON.stringify({trusted:event.isTrusted}))">Cold script click</button><label>Script field<input value="initial"></label>',
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
            const code = `const control = await tools.call('computer__input',{action:'fixture_effect'}); if(!control.ok) throw control;
const listed = await tools.call('browser_inspect',{action:'tabs'}); if(!listed.ok) throw listed;
const tab = listed.output.tabs.find(tab=>tab.url===args.url); if(!tab) throw 'Missing script tab';
let observed = await tools.call('browser_inspect',{action:'snapshot',tabId:tab.tabId}); if(!observed.ok) throw observed;
const button = observed.output.nodes.find(node=>node.name==='Cold script click'&&node.ref); if(!button) throw 'Missing cold button';
const clicked = await tools.call('browser_act',{action:'click',tabId:tab.tabId,ref:button.ref}); if(!clicked.ok) throw clicked;
observed = await tools.call('browser_inspect',{action:'snapshot',tabId:tab.tabId}); if(!observed.ok) throw observed;
const node = observed.output.nodes.find(node=>node.name==='Script field'&&node.ref); if(!node) throw 'Missing script input';
const result = await tools.call('browser_act',{action:'fill',tabId:tab.tabId,ref:node.ref,text:'Script 你好 🌍'}); if(!result.ok) throw result;
const image = await tools.call('browser_inspect',{action:'screenshot',mode:'viewport',tabId:tab.tabId}); if(!image.ok) throw image; show(image); return result.output;`
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
      `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return; if(m.method==='tools/call')fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params)+'\\n'); const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'script-computer',version:'1'}}:m.method==='tools/list'?{tools:['observe','input','app','internal'].map(name=>({name,inputSchema:{type:'object'}}))}:{content:[{type:'text',text:'Owned helper acknowledged'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
    )
    await client.request("config/write", {
      keyPath: ["mcp_servers", "computer"],
      value: {
        command: process.execPath,
        args: [helper],
        enabled: true,
        required: true,
        enabled_tools: ["observe", "input", "app"],
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
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("Run the owned script.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    for (let index = 0; index < 3; index++)
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
    expect(clicks).toEqual([{ trusted: true }])
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
          call.name === "input" && call.arguments?.action === "fixture_effect",
      ),
    ).toHaveLength(1)
    expect(
      calls.filter(
        (call) =>
          call.name === "internal" && call.arguments?.action === "turn_ended",
      ),
    ).toHaveLength(1)
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
          tools: ["observe", "input", "app"],
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
