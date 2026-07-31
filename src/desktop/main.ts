import { existsSync } from "node:fs"
import type { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow } from "electron"
import {
  createYakitoriApplication,
  listen,
  type YakitoriApplication,
  type YakitoriApplicationOptions,
} from "../server/index.ts"

// The bundle lands at dist/desktop/main.js, so the repo root is two levels up.
// (No new URL("./x", import.meta.url) — the bundler inlines that as a data: URL.)
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const maxLoadAttempts = 20
const loadRetryDelayMs = 500

let application: YakitoriApplication | undefined
let httpServer: Server | undefined
let shutdown: Promise<void> | undefined

// .then(start, failStartup) would miss rejections from start() itself.
void app.whenReady().then(start).catch(failStartup)

app.on("window-all-closed", () => {
  // Single-window local tool: closing the window always exits the app.
  app.quit()
})

app.on("will-quit", (event) => {
  if (shutdown !== undefined) return
  event.preventDefault()
  shutdown = shutdownDesktop().finally(() => {
    app.quit()
  })
})

async function start(): Promise<void> {
  const workspace = process.env.YAKITORI_WORKSPACE ?? process.cwd()
  const storeDir =
    process.env.YAKITORI_STORE_DIR ?? path.join(workspace, ".yakitori")
  application = await createYakitoriApplication(
    applicationOptions(workspace, storeDir),
  )
  httpServer = application.createHttpServer()
  const serverUrl = await bindHttpServer(httpServer)
  console.log(`yakitori: listening on ${serverUrl}`)
  openMainWindow(process.env.ELECTRON_RENDERER_URL ?? serverUrl)
}

function applicationOptions(
  workspace: string,
  storeDir: string,
): YakitoriApplicationOptions {
  const guiStaticDir = app.isPackaged
    ? path.join(process.resourcesPath, "gui")
    : path.join(appRoot, "dist", "gui")
  return {
    rootDir: storeDir,
    workspace,
    ...(existsSync(guiStaticDir) ? { guiStaticDir } : {}),
  }
}

async function bindHttpServer(server: Server): Promise<string> {
  const configuredPort = process.env.PORT
  if (configuredPort === undefined) return listen(server)
  const port = Number(configuredPort)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  return `http://127.0.0.1:${port}`
}

function openMainWindow(targetUrl: string): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Yakitori",
    backgroundColor: "#0a0a0a",
    show: false,
  })
  window.once("ready-to-show", () => {
    window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  const allowedOrigin = new URL(targetUrl).origin
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault()
  })

  // In dev the vite server may not be listening yet when the shell starts.
  let attempts = 0
  const load = () => {
    attempts += 1
    void window.loadURL(targetUrl)
  }
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL !== targetUrl) return
      if (attempts >= maxLoadAttempts) {
        console.error(
          `yakitori: giving up loading ${targetUrl} (${errorCode} ${errorDescription})`,
        )
        return
      }
      setTimeout(load, loadRetryDelayMs)
    },
  )
  load()
}

async function shutdownDesktop(): Promise<void> {
  const server = httpServer
  httpServer = undefined
  if (server !== undefined) {
    // SSE streams keep connections open; force them closed after close().
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    server.closeAllConnections()
    await closed
  }
  await application?.close()
}

function failStartup(error: unknown): void {
  console.error("yakitori: startup failed", error)
  app.exit(1)
}
