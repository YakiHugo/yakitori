import { resolve } from "node:path"
import { expect, test, type WebSocketRoute } from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import {
  createSmokeEnvironment,
  runBudgetedGoal,
  runFauxTurn,
  runExternalEngineFlow,
  runProviderFlow,
  smokePdfBytes,
} from "./fixtures.ts"

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
