import { readFile, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { expect, test, type WebSocketRoute } from "@playwright/test"
import { parse, stringify } from "smol-toml"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import {
  createSmokeEnvironment,
  runBudgetedGoal,
  runExternalEngineFlow,
  runFauxTurn,
  runProviderFlow,
  smokePdfBytes,
} from "./fixtures.ts"

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
