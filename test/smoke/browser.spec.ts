import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { expect, test, type WebSocketRoute } from "@playwright/test"
import { parse, stringify } from "smol-toml"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import type {
  WorkspaceBrowserBridge,
  WorkspaceBrowserShowRequest,
  WorkspaceBrowserShowResult,
} from "../../src/desktop/workspace-browser-types.ts"
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

type BrowserViewSmoke = {
  tabs: string[]
  claims: string[]
  completed: { requestId: string; result: WorkspaceBrowserShowResult }[]
  emit: (request: WorkspaceBrowserShowRequest) => void
}

test("browser display requests select the owned tab and refuse cancelled or foreign requests", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    let listener: ((request: WorkspaceBrowserShowRequest) => void) | undefined
    const state: BrowserViewSmoke = {
      tabs: [],
      claims: [],
      completed: [],
      emit(request) {
        if (!listener) throw new Error("Display listener is not mounted")
        listener(request)
      },
    }
    const browser: WorkspaceBrowserBridge = {
      async create({ tabId }) {
        if (!state.tabs.includes(tabId)) state.tabs.push(tabId)
        return {
          tabId,
          title: "Owned browser",
          url: "https://example.test/",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        }
      },
      async navigate() {},
      async action() {},
      async viewport() {
        return undefined
      },
      async selection() {},
      async close() {},
      async claimShow({ requestId }) {
        state.claims.push(requestId)
        return requestId !== "cancelled"
      },
      async completeShow(input) {
        state.completed.push(input)
        return true
      },
      onShowRequest(fn) {
        listener = fn
        return () => {
          listener = undefined
        }
      },
      onState() {
        return () => {}
      },
      onSelection() {
        return () => {}
      },
      onShortcut() {
        return () => {}
      },
    }
    Object.defineProperty(window, "yakitoriDesktop", { value: { browser } })
    Reflect.set(window, "browserViewSmoke", state)
  })
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    await page.goto(server.url)
    await runFauxTurn(page)
    const client = createAppRpcClient({ apiBase: server.url })
    const { sessions } = await client.request("session/list", {})
    expect(sessions).toHaveLength(1)
    const ownerSessionId = sessions[0]?.id
    if (!ownerSessionId) throw new Error("Missing owning session")
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: /^Browser/ }).click()
    const tab = page.getByRole("tab", { name: "Owned browser", exact: true })
    await expect(tab).toHaveAttribute("aria-selected", "true")
    const tabId = await page.evaluate(
      () =>
        (Reflect.get(window, "browserViewSmoke") as BrowserViewSmoke).tabs[0],
    )
    if (!tabId) throw new Error("Missing owned browser tab")
    await page
      .getByRole("button", { name: "Hide workspace", exact: true })
      .click()
    const workspace = page.getByRole("complementary", {
      name: "Workspace",
      exact: true,
    })
    const emit = (requestId: string, owner = ownerSessionId) =>
      page.evaluate(
        (request) => {
          ;(Reflect.get(window, "browserViewSmoke") as BrowserViewSmoke).emit(
            request,
          )
        },
        { requestId, ownerSessionId: owner, tabId },
      )
    await emit("foreign", "another-session")
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (Reflect.get(window, "browserViewSmoke") as BrowserViewSmoke)
              .completed,
        ),
      )
      .toEqual([{ requestId: "foreign", result: "refused" }])
    await emit("cancelled")
    await emit("applied")
    await expect(workspace).toBeVisible()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (Reflect.get(window, "browserViewSmoke") as BrowserViewSmoke)
              .completed,
        ),
      )
      .toEqual([
        { requestId: "foreign", result: "refused" },
        { requestId: "applied", result: "applied" },
      ])
    expect(
      await page.evaluate(
        () =>
          (Reflect.get(window, "browserViewSmoke") as BrowserViewSmoke).claims,
      ),
    ).toEqual(["cancelled", "applied"])
    expect(errors).toEqual([])
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})

test("live computer preview renders decoded frames and pointer positions and sends Stop", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const logs: string[] = [],
    errors: string[] = []
  const requests: { method: string; params: unknown }[] = []
  let finishTakeover: (() => void) | undefined
  const frame = computerPreviewFrame()
  let server: ServerProcess | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  // Renderer-only verification: the owned native bridge is covered by the
  // separate process/native tests. All other application RPC remains real.
  await page.routeWebSocket("**/rpc", (socket) => {
    const peer = socket.connectToServer()
    peer.onMessage((message) => socket.send(message))
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        peer.send(message)
        return
      }
      const sent = JSON.parse(message) as {
        id?: number
        method?: string
        params?: unknown
      }
      if (sent.method === "computer/takeover") {
        requests.push({ method: sent.method, params: sent.params })
        finishTakeover = () =>
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: sent.id,
              result: {
                available: true,
                connected: false,
                backend: "yakitori-native",
                serverName: "computer",
                tools: [],
              },
            }),
          )
        return
      }
      let result: unknown
      if (sent.method === "computer/status")
        result = {
          available: true,
          connected: true,
          backend: "yakitori-native",
          serverName: "computer",
          tools: ["control"],
          permissions: { accessibility: true, screenRecording: true },
        }
      else if (sent.method === "computer/preview/catalog")
        result = computerPreviewCatalog
      else if (sent.method === "computer/preview/capture") result = frame
      else if (sent.method === "computer/preview/stop") result = {}
      else {
        peer.send(message)
        return
      }
      if (sent.method)
        requests.push({ method: sent.method, params: sent.params })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result }))
    })
  })
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: "Computer", exact: true }).click()
    const preview = page.getByRole("region", { name: "Live computer preview" })
    await expect(
      preview.getByRole("combobox", { name: "Preview target", exact: true }),
    ).toHaveText("Owned fixture window")
    expect(
      requests.filter((entry) => entry.method === "computer/preview/capture"),
    ).toHaveLength(0)
    await preview
      .getByRole("button", { name: "Start preview", exact: true })
      .click()
    const image = preview.getByRole("img", {
      name: "Live computer preview",
      exact: true,
    })
    await expect
      .poll(() =>
        image.evaluate((node) => {
          const image = node as HTMLImageElement
          return (
            image.complete &&
            image.naturalWidth === 200 &&
            image.naturalHeight === 100
          )
        }),
      )
      .toBe(true)
    await image.scrollIntoViewIfNeeded()
    const imageBounds = await image.boundingBox(),
      pointerBounds = await preview
        .getByRole("img", { name: "Pointer position" })
        .boundingBox()
    expect(imageBounds).not.toBeNull()
    expect(pointerBounds).not.toBeNull()
    if (!imageBounds || !pointerBounds)
      throw new Error("Preview geometry is unavailable")
    expect(
      Math.abs(
        pointerBounds.x +
          pointerBounds.width / 2 -
          (imageBounds.x + imageBounds.width * 0.2),
      ),
    ).toBeLessThan(2)
    expect(
      Math.abs(
        pointerBounds.y +
          pointerBounds.height / 2 -
          (imageBounds.y + imageBounds.height * 0.3),
      ),
    ).toBeLessThan(2)
    await page.screenshot({ path: testInfo.outputPath("live-preview.png") })
    await preview
      .getByRole("button", { name: "Enlarge live computer preview" })
      .click()
    await expect(
      page.getByRole("dialog", { name: "Preview Live computer preview" }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click()
    await preview
      .getByRole("button", { name: "Stop preview", exact: true })
      .click()
    await expect(preview.getByRole("status")).toHaveText("Paused")
    await expect
      .poll(
        () =>
          requests.filter((entry) => entry.method === "computer/preview/stop")
            .length,
      )
      .toBeGreaterThan(0)
    expect(
      requests.find((entry) => entry.method === "computer/preview/capture")
        ?.params,
    ).toMatchObject({ target: computerPreviewCatalog.targets[0]?.target })
    await page
      .getByRole("button", { name: "Take over computer", exact: true })
      .click()
    await expect(
      page.getByRole("button", {
        name: "Waiting for input release…",
        exact: true,
      }),
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Connect computer", exact: true }),
    ).toHaveCount(0)
    if (!finishTakeover) throw new Error("Takeover request was not sent")
    finishTakeover()
    await expect(
      page.getByRole("button", { name: "Connect computer", exact: true }),
    ).toBeEnabled()
    expect(errors).toEqual([])
  } catch (cause) {
    await testInfo.attach("server.log", {
      body: logs.join("\n"),
      contentType: "text/plain",
    })
    throw cause
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})

test("new Kimi, OpenAI and xAI accounts default to Responses and persist Kimi K3", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  const endpoint = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ data: [{ id: "kimi-k3" }] }))
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing catalog endpoint")
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  let server: ServerProcess | undefined
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: {
        ...environment.env,
        MOONSHOT_API_KEY: "",
        YAKITORI_GUI_DIR: resolve("dist/gui"),
      },
    })
    await page.goto(server.url)
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("button", { name: "Providers", exact: true }).click()
    await page.getByRole("button", { name: "Add account", exact: true }).click()
    for (const [name, defaultBaseURL] of [
      ["OpenAI", "https://api.openai.com/v1"],
      ["xAI", "https://api.x.ai/v1"],
      ["Kimi API", "https://api.moonshot.ai/v1"],
    ] as const) {
      await page.getByRole("button", { name, exact: true }).click()
      const editor = page.getByRole("dialog", { name, exact: true })
      await editor.getByText("Advanced settings", { exact: true }).click()
      await expect(editor.getByLabel("API protocol")).toHaveText(
        "OpenAI Responses",
      )
      await expect(editor.getByLabel("API base URL")).toHaveValue(
        defaultBaseURL,
      )
      if (name !== "Kimi API") {
        await editor
          .getByRole("button", { name: "Cancel", exact: true })
          .click()
        continue
      }
      await editor
        .getByText("Model defaults (optional)", { exact: true })
        .click()
      await expect(editor.getByText("kimi-k3", { exact: true })).toBeVisible()
      await editor.getByLabel("Account name").fill("Smoke Kimi")
      // Catalog discovery stays on the owned endpoint before credentials are
      // entered; this smoke never sends a key or model request to Kimi.
      await editor.getByLabel("API base URL").fill(baseURL)
      await editor.getByLabel("API key", { exact: true }).fill("smoke-key")
      await editor
        .getByRole("button", { name: "Add account", exact: true })
        .click()
      await expect(editor).toHaveCount(0)
    }
    await page.reload()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("button", { name: "Providers", exact: true }).click()
    await page.getByRole("button", { name: /^Smoke Kimi/ }).click()
    await expect(page.getByText("kimi-k3", { exact: true })).toBeVisible()
    await page
      .getByRole("button", { name: "Edit connection", exact: true })
      .click()
    const saved = page.getByRole("dialog", { name: "Smoke Kimi", exact: true })
    await saved.getByText("Advanced settings", { exact: true }).click()
    await expect(saved.getByLabel("API protocol")).toHaveText(
      "OpenAI Responses",
    )
    await expect(saved.getByLabel("API base URL")).toHaveValue(baseURL)
  } finally {
    await server?.stop()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    )
    await environment.cleanup()
  }
})

test("independent sessions route cross-provider models and appear in the sidebar", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    await page.goto(server.url)
    await runIndependentSessionFlow(page, testInfo)
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})

test("shared selects keep preferences, keyboard focus and popup bounds", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    await page.goto(server.url)
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const appearance = page.getByRole("combobox", { name: "Appearance" })
    await appearance.focus()
    await page.keyboard.press("ArrowDown")
    await expect(
      page.getByRole("option", { name: "Light", exact: true }),
    ).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(
      page.getByRole("option", { name: "Dark", exact: true }),
    ).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(appearance).toHaveText("Dark")
    await expect(appearance).toBeFocused()
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click()
    const notifications = page.getByRole("combobox", {
      name: "When work finishes",
    })
    await notifications.click()
    await page.keyboard.press("Escape")
    await expect(notifications).toBeFocused()
    await expect(
      page.getByRole("region", { name: "Notification settings" }),
    ).toBeVisible()
    await notifications.click()
    await page.getByRole("option", { name: "Never", exact: true }).click()
    await expect(
      page.getByRole("switch", { name: "Notification sound" }),
    ).toBeDisabled()

    await page.reload()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(appearance).toHaveText("Dark")
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click()
    await expect(notifications).toHaveText("Never")
    await page.setViewportSize({ width: 560, height: 720 })
    await notifications.click()
    const bounds = await page.getByRole("listbox").boundingBox()
    if (!bounds) throw new Error("Select popup has no visible bounds")
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(560)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(720)
    await page.keyboard.press("Escape")
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})

test("an unavailable saved model can be replaced and stays corrected after reload", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const configPath = join(environment.root, "home", "config.toml")
  const logs: string[] = []
  let server: ServerProcess | undefined
  try {
    await writeFile(
      configPath,
      stringify({ provider: "removed-account", model: "retired-model" }),
    )
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    const selector = page.getByRole("button", {
      name: "Select model and effort",
    })
    await expect(selector).toHaveText("Select model")
    await page.reload()
    await expect(selector).toHaveText("Select model")
    expect(parse(await readFile(configPath, "utf8"))).toMatchObject({
      provider: "removed-account",
      model: "retired-model",
    })
    await page.screenshot({
      path: testInfo.outputPath("model-unavailable.png"),
    })
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await selector.click()
    await expect(page.getByRole("button", { name: /^Default/ })).toHaveCount(0)
    await page.getByRole("button", { name: "scripted", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("Test model selection recovery.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByRole("main").getByText("Hello from faux.", { exact: true }),
    ).toBeVisible()
    await expect
      .poll(async () => parse(await readFile(configPath, "utf8")).provider)
      .toBe("faux")
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Select model and effort" }),
    ).toContainText("scripted")
    await page.screenshot({ path: testInfo.outputPath("model-recovered.png") })
  } finally {
    await testInfo.attach("server.log", {
      body: logs.join("\n"),
      contentType: "text/plain",
    })
    const timer = setTimeout(() => void server?.forceStop(), 5_000)
    try {
      await server?.stop()
    } finally {
      clearTimeout(timer)
      await environment.cleanup()
    }
  }
})

test("model picker groups choices by vendor and keeps the selected model explicit", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const endpoint = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    const ids = request.url?.startsWith("/kimi/")
      ? ["k3", "k3-256k"]
      : ["gpt-6-sol", "gpt-6-luna"]
    response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }))
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing catalog endpoint")
  let server: ServerProcess | undefined
  try {
    await writeFile(
      join(environment.root, "home", "config.toml"),
      stringify({
        provider: "kimi-code",
        model: "k3",
        model_providers: {
          "kimi-account": {
            name: "Kimi account",
            service: "kimi-code",
            authentication: "none",
            base_url: `http://127.0.0.1:${address.port}/kimi`,
            api_backend: "messages",
            models: [
              {
                id: "k3",
                displayName: "K3",
                efforts: ["low", "max"],
                defaultEffort: "max",
              },
              { id: "k3-256k", displayName: "K3-256k" },
            ],
          },
          "openai-account": {
            name: "OpenAI account",
            service: "openai",
            authentication: "none",
            base_url: `http://127.0.0.1:${address.port}/openai/v1`,
            api_backend: "chat_completions",
            models: [
              { id: "gpt-6-sol", displayName: "GPT-6 Sol" },
              { id: "gpt-6-luna", displayName: "GPT-6 Luna" },
            ],
          },
        },
      }),
    )
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: {
        ...environment.env,
        YAKITORI_PROVIDER: "kimi-account",
        YAKITORI_MODEL: "k3",
        YAKITORI_GUI_DIR: resolve("dist/gui"),
      },
    })
    await page.goto(server.url)
    const selector = page.getByRole("button", {
      name: "Select model and effort",
    })
    await expect(selector).toContainText("K3")
    await selector.click()
    await page
      .getByRole("button", { name: "Select model", exact: true })
      .click()
    const kimi = page.getByRole("group", { name: "Kimi Code", exact: true })
    const openai = page.getByRole("group", { name: "OpenAI", exact: true })
    await expect(
      kimi.getByRole("button", { name: "K3", exact: true }),
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      kimi.getByRole("button", { name: "K3-256k", exact: true }),
    ).toBeVisible()
    await expect(
      openai.getByRole("button", { name: "GPT-6 Sol", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: /^Default/ })).toHaveCount(0)
    for (const group of [kimi, openai]) {
      await expect(group.locator(".provider-logo")).toBeVisible()
      await expect(group.locator(".provider-logo > span")).not.toHaveCSS(
        "mask-image",
        "none",
      )
    }
    await page.screenshot({
      path: testInfo.outputPath("model-groups.png"),
      animations: "disabled",
    })
    await page.setViewportSize({ width: 560, height: 720 })
    const bounds = await page.locator("[data-model-picker]").boundingBox()
    if (!bounds) throw new Error("Missing model picker")
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(560)
    await openai
      .getByRole("button", { name: "GPT-6 Luna", exact: true })
      .click()
    await expect(selector).toHaveText("GPT-6 Luna")
    await selector.click()
    await expect(
      openai.getByRole("button", { name: "GPT-6 Luna", exact: true }),
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      kimi.getByRole("button", { name: "K3", exact: true }),
    ).toHaveAttribute("aria-pressed", "false")
    await page.screenshot({
      path: testInfo.outputPath("model-groups-narrow.png"),
      animations: "disabled",
    })
  } finally {
    await server?.stop()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    await environment.cleanup()
  }
})

test("model preview prevents mixed-provider effort and image combinations before routing the turn", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const requests: {
    path: string | undefined
    body: Record<string, unknown>
  }[] = []
  const endpoint = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [
            {
              id: request.url?.startsWith("/vision/")
                ? "vision-upstream"
                : "text-upstream",
            },
          ],
        }),
      )
      return
    }
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      requests.push({
        path: request.url,
        body: JSON.parse(body) as Record<string, unknown>,
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        `data: ${JSON.stringify({
          id: "preview-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "vision-upstream",
          choices: [
            {
              index: 0,
              delta: { content: "Routed through vision." },
              finish_reason: null,
            },
          ],
        })}\n\ndata: ${JSON.stringify({
          id: "preview-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "vision-upstream",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      )
    })
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing preview endpoint")
  let server: ServerProcess | undefined
  let client: ReturnType<typeof createAppRpcClient> | undefined
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    client = createAppRpcClient({ apiBase: server.url })
    for (const kind of ["text", "vision"] as const) {
      await client.request("provider/configuration/write", {
        id: `${kind}-account`,
        configuration: {
          name: `${kind} account`,
          authentication: "none",
          wireApi: "openai_chat_completions",
          baseURL: `http://127.0.0.1:${address.port}/${kind}/v1`,
          models: [
            {
              id: `${kind}-upstream`,
              displayName: "Shared Coder",
              identity: { namespace: "shared-vendor", model: "shared-coder" },
              inputModalities: kind === "text" ? ["text"] : ["text", "image"],
              imageDetailModes: kind === "text" ? [] : ["high"],
              efforts: kind === "text" ? ["low"] : ["high"],
              defaultEffort: kind === "text" ? "low" : "high",
              contextWindowTokens: kind === "text" ? 64_000 : 128_000,
            },
          ],
        },
      })
    }
    const selection = {
      provider: "shared-vendor",
      model: "shared-coder",
      effort: "high",
    }
    const rejected = await client.request("model/preview", {
      selection: { ...selection, effort: "low" },
      requirements: { inputModalities: ["image"] },
    })
    expect(rejected.available).toBe(false)
    expect(rejected.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "text-account",
          code: "unsupported_modality",
        }),
        expect.objectContaining({
          accountId: "vision-account",
          code: "unsupported_effort",
        }),
      ]),
    )
    const preview = await client.request("model/preview", {
      selection,
      requirements: { inputModalities: ["image"] },
    })
    expect(preview).toMatchObject({
      available: true,
      target: {
        provider: "vision-account",
        model: "vision-upstream",
        effort: "high",
      },
      efforts: ["high"],
      inputModalities: ["text", "image"],
    })
    await client.request("userPreference/write", selection)
    await page.goto(server.url)
    const selector = page.getByRole("button", {
      name: "Select model and effort",
    })
    await expect(selector).toHaveText("Shared CoderHigh")
    await selector.click()
    await expect(
      page.getByRole("button", { name: "low", exact: true }),
    ).toBeVisible()
    await page.keyboard.press("Escape")
    const imageBytes = await readFile(
      join(environment.root, "workspace", "smoke.png"),
    )
    const imported = await server.request({
      type: "import_attachment_bytes",
      rolloutId: "draft_preview_smoke",
      ownerId: "preview_smoke",
      items: [{ name: "preview.png", data: imageBytes }],
    })
    const image = imported.ok ? imported.attachments?.[0] : undefined
    if (image?.mediaType !== "image/png")
      throw new Error("Preview image import failed")
    // The browser exercises the actual composer and owned attachment assets;
    // only the Electron preload import response is supplied by this fixture.
    await page.evaluate(
      (image) => {
        Object.defineProperty(window, "yakitoriDesktop", {
          configurable: true,
          value: {
            importAttachmentFiles: async () => [image],
            discardDraftAttachments: async () => {},
          },
        })
      },
      { ...image, detail: "original" },
    )
    const editor = page.getByRole("textbox", { name: "Message the Mate" })
    await editor.fill("Inspect the attached preview image.")
    await editor.evaluate((node, base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      )
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File([bytes], "preview.png", { type: "image/png" }),
      )
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      )
    }, imageBytes.toString("base64"))
    await expect(
      page.getByRole("button", { name: "Preview preview.png", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled()
    await page
      .getByRole("button", {
        name: "Use high detail for preview.png",
        exact: true,
      })
      .click()
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeEnabled()
    await selector.click()
    await expect(
      page.getByRole("button", { name: "high", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "low", exact: true }),
    ).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath("model-preview-image-effort.png"),
      animations: "disabled",
    })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page
        .getByRole("main")
        .getByText("Routed through vision.", { exact: true }),
    ).toBeVisible()
    const sent = requests.find(({ body }) =>
      JSON.stringify(body.messages).includes("data:image/png"),
    )
    expect(sent).toMatchObject({
      path: "/vision/v1/chat/completions",
      body: { model: "vision-upstream", reasoning_effort: "high" },
    })
    expect(requests.some(({ path }) => path?.startsWith("/text/"))).toBe(false)
  } finally {
    client?.close()
    await server?.stop()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    await environment.cleanup()
  }
})

test("provider settings preserve settings navigation and restore chat panels", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const errors: string[] = []
  const logs: string[] = []
  let server: ServerProcess | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    const sidebar = page.locator(".sidebar-frame")
    await expect(sidebar).toHaveAttribute("data-open", "true")
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await expect(
      page.getByRole("complementary", { name: "Workspace", exact: true }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const navigation = page.getByRole("complementary", {
      name: "Settings navigation",
    })
    await navigation
      .getByRole("button", { name: "Providers", exact: true })
      .click()
    await expect(
      page.getByText("No accounts connected yet.", { exact: true }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Add account", exact: true }).click()
    await expect(
      page.getByText("Use your ChatGPT plan", { exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Back to app", exact: true }),
    ).toHaveCount(1)
    await expect(sidebar).toBeHidden()
    await expect(page.locator(".workspace-frame")).toBeHidden()
    await expect(
      page.getByRole("button", { name: "Show workspace", exact: true }),
    ).toBeHidden()
    await page.keyboard.press("ControlOrMeta+b")
    await page.keyboard.press("ControlOrMeta+Shift+b")
    for (const width of [1280, 800, 480]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(navigation).toBeVisible()
      await expect(
        navigation.getByRole("button", { name: "Providers", exact: true }),
      ).toHaveAttribute("aria-current", "page")
      await expect(page.getByRole("tab")).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "ChatGPT", exact: true }),
      ).toBeVisible()
      const bounds = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }))
      expect(bounds.content).toBeLessThanOrEqual(bounds.width)
      await page.screenshot({
        path: testInfo.outputPath(`provider-navigation-${width}.png`),
        fullPage: true,
      })
    }
    await navigation
      .getByRole("button", { name: "General", exact: true })
      .click()
    await navigation
      .getByRole("button", { name: "Providers", exact: true })
      .click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole("button", { name: "Back to app", exact: true }).click()
    await expect(navigation).toHaveCount(0)
    await expect(sidebar).toHaveAttribute("data-open", "true")
    await expect(sidebar).toBeVisible()
    await expect(
      page.getByRole("complementary", { name: "Workspace", exact: true }),
    ).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await testInfo.attach("server.log", {
      body: logs.join("\n"),
      contentType: "text/plain",
    })
    const timer = setTimeout(() => void server?.forceStop(), 5_000)
    try {
      await server?.stop()
    } finally {
      clearTimeout(timer)
      await environment.cleanup()
    }
  }
})

test("built GUI sends a turn and restores its transcript after reload", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const errors: string[] = []
  const logs: string[] = []
  let server: ServerProcess | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: "Computer", exact: true }).click()
    const connectComputer = page.getByRole("button", {
      name: "Connect computer",
      exact: true,
    })
    if (process.platform === "darwin")
      await expect(connectComputer).toBeEnabled()
    else await expect(connectComputer).toBeDisabled()
    await runFauxTurn(page)
    await page.reload()
    await expect(
      page.getByRole("main").getByText("Check the CI smoke flow.", {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole("main").getByText("Hello from faux.", { exact: true }),
    ).toBeVisible()
    await runBudgetedGoal(page)
    const imported = await server.request({
      type: "import_attachment_bytes",
      rolloutId: "draft_browser_pdf",
      ownerId: "pdf_smoke",
      items: [{ name: "ordered-smoke.pdf", data: smokePdfBytes }],
    })
    const pdf = imported.ok ? imported.attachments?.[0] : undefined
    if (pdf?.mediaType !== "application/pdf")
      throw new Error("Browser PDF fixture import failed")
    await runProviderFlow(page, testInfo, { browserPdf: pdf })
    await runExternalEngineFlow(page)
    expect(errors).toEqual([])
  } finally {
    try {
      await testInfo.attach("server.log", {
        body: logs.join("\n"),
        contentType: "text/plain",
      })
    } finally {
      // Failed assertions or diagnostics must not strand the owned sidecar.
      const timer = setTimeout(() => void server?.forceStop(), 5_000)
      try {
        await server?.stop()
      } finally {
        clearTimeout(timer)
        await environment.cleanup()
      }
    }
  }
})

test("expired side chats dismiss excerpt actions and leave main chat quoting available", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const logs: string[] = []
  const errors: string[] = []
  let server: ServerProcess | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.clock.install()
    await page.goto(server.url)
    await runFauxTurn(page)
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: /^Side chat/ }).click()
    const side = page.locator("[data-side-chat-id]")
    await side
      .getByRole("textbox", { name: "Message side chat" })
      .fill("Explain the response")
    await side.getByRole("button", { name: "Send side chat message" }).click()
    const sideResponse = side.getByText("Hello from faux.", { exact: true })
    await expect(sideResponse).toBeVisible()
    await expect(side.getByText("Responding…", { exact: true })).toHaveCount(0)
    const selectResponse = async (
      response: ReturnType<typeof page.getByText>,
    ) => {
      await response.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      })
    }
    await selectResponse(sideResponse)
    await expect(
      page.getByRole("toolbar", { name: "Selected text actions" }),
    ).toBeVisible()
    // Advance the renderer past its received lease; the server and persistence
    // remain real, and no process clock or product timeout is changed.
    await page.clock.fastForward(25 * 60 * 60 * 1_000)
    await expect(
      side.getByText("Side chat expired. Start a new side chat to continue."),
    ).toBeVisible()
    await expect(
      page.getByRole("toolbar", { name: "Selected text actions" }),
    ).toHaveCount(0)
    await expect(
      side.getByRole("textbox", { name: "Message side chat" }),
    ).toHaveCount(0)
    await selectResponse(sideResponse)
    await expect(
      page.getByRole("toolbar", { name: "Selected text actions" }),
    ).toHaveCount(0)
    const mainResponse = page
      .getByRole("region", { name: "Response", exact: true })
      .getByText("Hello from faux.", { exact: true })
    await selectResponse(mainResponse)
    await page
      .getByRole("button", { name: "Quote in conversation", exact: true })
      .click()
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: "Open excerpt 1: Assistant message" }),
    ).toBeVisible()
    await expect(
      side.getByRole("button", { name: /^Open excerpt/ }),
    ).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    try {
      await testInfo.attach("expired-side-chat-server.log", {
        body: logs.join("\n"),
        contentType: "text/plain",
      })
    } finally {
      const timer = setTimeout(() => void server?.forceStop(), 5_000)
      try {
        await server?.stop()
      } finally {
        clearTimeout(timer)
        await environment.cleanup()
      }
    }
  }
})

test("reconnect confirms a lost input acknowledgement without resending or clearing a later draft", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const logs: string[] = []
  const errors: string[] = []
  let server: ServerProcess | undefined
  let sentId: number | undefined
  let sends = 0
  let disconnected = false
  let release: (() => void) | undefined
  const replayReady = new Promise<void>((resolve) => {
    release = resolve
  })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.routeWebSocket("**/rpc", (socket) => {
    const peer: WebSocketRoute = socket.connectToServer()
    const reconnecting = disconnected
    socket.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { id?: number; method?: string }
        if (frame.method === "session/input") {
          sends += 1
          sentId = frame.id
        }
      }
      peer.send(message)
    })
    peer.onMessage(async (message) => {
      if (reconnecting) await replayReady
      if (
        !reconnecting &&
        sentId !== undefined &&
        typeof message === "string"
      ) {
        const frame = JSON.parse(message) as { id?: number; method?: string }
        // The server accepts the real input. Drop only this connection's
        // acknowledgement and deliveries; the next connection replays storage.
        if (frame.id === sentId) {
          disconnected = true
          await socket.close({ code: 1012, reason: "Lost acknowledgement" })
          await peer.close()
          return
        }
        if (frame.method !== undefined) return
      }
      socket.send(message)
    })
  })
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    await page.getByRole("button", { name: "New session", exact: true }).click()
    const composer = page.getByRole("textbox", { name: "Message the Mate" })
    await composer.fill("An accepted input with a lost reply.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByText(
        "Sending status is unconfirmed. This input has not been resent.",
        { exact: true },
      ),
    ).toBeVisible()
    await expect(composer).toHaveText("An accepted input with a lost reply.")
    await composer.fill("A later draft must survive reconnect.")
    release?.()
    await expect(
      page.getByRole("main").getByText("Hello from faux.", { exact: true }),
    ).toBeVisible()
    await expect(
      page
        .getByRole("main")
        .getByText("An accepted input with a lost reply.", { exact: true }),
    ).toHaveCount(1)
    await expect(composer).toHaveText("A later draft must survive reconnect.")
    await expect(
      page.getByText(
        "Sending status is unconfirmed. This input has not been resent.",
        { exact: true },
      ),
    ).toHaveCount(0)
    expect(sends).toBe(1)
    expect(errors).toEqual([])
  } finally {
    release?.()
    try {
      await testInfo.attach("server.log", {
        body: logs.join("\n"),
        contentType: "text/plain",
      })
    } finally {
      const timer = setTimeout(() => void server?.forceStop(), 5_000)
      try {
        await server?.stop()
      } finally {
        clearTimeout(timer)
        await environment.cleanup()
      }
    }
  }
})

test("window history restores sessions and drafts without creating duplicate conversations", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  let creations = 0
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const message: unknown = JSON.parse(String(frame.payload))
      if (
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "session/create"
      )
        creations += 1
    }),
  )
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    await page.goto(server.url)
    const project = page.getByRole("combobox", { name: "New session project" })
    await expect(project).not.toHaveText("No project")
    await runFauxTurn(page)
    const composer = page.getByRole("textbox", { name: "Message the Mate" })
    const reply = page.getByText("Hello from faux.", { exact: true })
    await composer.fill("Keep the first unfinished draft")
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Add workspace tab", exact: true })
      .click()
    await page.getByRole("menuitem", { name: /^Files/ }).click()
    await page
      .getByRole("button", { name: "Expand workspace", exact: true })
      .click()
    const workspace = page.getByRole("complementary", {
      name: "Workspace",
      exact: true,
    })
    const files = page.getByRole("tab", { name: "Files", exact: true })
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(project).toBeDisabled()
    // Creation passes through the draft workspace, which has its own layout.
    await expect(workspace).toBeHidden()
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await expect(workspace).toHaveAttribute("data-expanded", "false")
    await page
      .getByRole("button", { name: "Hide workspace", exact: true })
      .click()
    await composer.fill("Keep the second unfinished draft")
    const back = page.getByRole("button", { name: "Go back", exact: true })
    const forward = page.getByRole("button", {
      name: "Go forward",
      exact: true,
    })
    await back.click()
    await expect(workspace).toHaveAttribute("data-expanded", "true")
    await expect(files).toHaveAttribute("aria-selected", "true")
    await page
      .getByRole("button", { name: "Restore workspace size", exact: true })
      .click()
    await expect(reply).toBeVisible()
    await expect(composer).toHaveText("Keep the first unfinished draft")
    await forward.click()
    await expect(reply).toHaveCount(0)
    await expect(composer).toHaveText("Keep the second unfinished draft")
    await expect(workspace).toBeHidden()
    await page.keyboard.press("ControlOrMeta+Shift+b")
    await expect(workspace).toBeVisible()
    await expect(workspace).toHaveAttribute("data-expanded", "false")
    await page
      .getByRole("button", { name: "Close Changes", exact: true })
      .click()
    await expect(workspace.getByRole("tab")).toHaveCount(0)
    await back.click()
    await expect(files).toHaveAttribute("aria-selected", "true")
    await forward.click()
    await expect(workspace).toBeVisible()
    await expect(workspace.getByRole("tab")).toHaveCount(0)
    expect(creations).toBe(2)
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click()
    await back.click()
    await expect(
      page.getByRole("region", { name: "General settings", exact: true }),
    ).toBeVisible()
    await back.click()
    await expect(composer).toHaveText("Keep the second unfinished draft")
    await forward.click()
    await page.getByRole("button", { name: "Chats", exact: true }).click()
    await expect(forward).toBeDisabled()
    // Global navigation must not consume editor selection/cursor shortcuts.
    await composer.focus()
    await page.keyboard.press("Alt+ArrowLeft")
    await expect(
      page.getByRole("region", { name: "General settings", exact: true }),
    ).toHaveCount(0)
    await back.focus()
    await page.keyboard.press("Alt+ArrowLeft")
    await expect(
      page.getByRole("region", { name: "General settings", exact: true }),
    ).toBeVisible()
    await page.keyboard.press("Alt+ArrowRight")
    await expect(composer).toHaveText("Keep the second unfinished draft")
    expect(creations).toBe(2)
  } finally {
    const timer = setTimeout(() => void server?.forceStop(), 5_000)
    try {
      await server?.stop()
    } finally {
      clearTimeout(timer)
      await environment.cleanup()
    }
  }
})
