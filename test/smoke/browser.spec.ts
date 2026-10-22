import { readFile, writeFile } from "node:fs/promises"
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
      stringify({ provider: "removed-account", model: "scripted" }),
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
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await page.getByRole("button", { name: "Choose another model" }).click()
    await expect(
      page.getByRole("button", {
        name: /Default.*Default model is unavailable/,
      }),
    ).toBeDisabled()
    await page.getByRole("button", { name: "scripted", exact: true }).click()
    await expect(
      page.getByText(/Selected model is no longer available/),
    ).toHaveCount(0)
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
    await expect(
      page.getByText(/Selected model is no longer available/),
    ).toHaveCount(0)
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
    await expect(project).not.toHaveValue("")
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
