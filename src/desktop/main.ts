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
const forceQuitDelayMs = 10_000

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
  // A second will-quit while shutdown is in progress is the force-quit
  // hatch: it falls through without preventDefault, so Electron exits now.
  if (shutdown !== undefined) return
  event.preventDefault()
  const forceQuit = setTimeout(() => {
    app.exit(1)
  }, forceQuitDelayMs)
  // Backstop only; the timer must never keep the process alive by itself.
  forceQuit.unref()
  shutdown = shutdownDesktop().then(
    () => {
      clearTimeout(forceQuit)
      app.quit()
    },
    (error: unknown) => {
      clearTimeout(forceQuit)
      console.error("yakitori: shutdown failed", error)
      app.exit(1)
    },
  )
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
  // PORT=0 binds an ephemeral port, so derive the URL from the bound address.
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on a TCP address.")
  }
  return `http://127.0.0.1:${address.port}`
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
  // The GUI needs no renderer permissions; deny every request.
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false)
    },
  )
  const allowedOrigin = new URL(targetUrl).origin
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault()
  })

  // Fire-and-forget, but nothing rejects unhandled: loadWithRetry catches
  // every loadURL failure, and the catch here covers anything unexpected.
  void loadWithRetry(window, targetUrl).catch(failStartup)
}

// In dev the vite server may not be listening yet when the shell starts, so
// retry off loadURL's own promise (did-fail-load URL normalization made the
// old event-based guard never match the target URL).
async function loadWithRetry(
  window: BrowserWindow,
  targetUrl: string,
): Promise<void> {
  for (let attempt = 1; attempt <= maxLoadAttempts; attempt += 1) {
    if (window.isDestroyed()) return
    try {
      await window.loadURL(targetUrl)
      return
    } catch (error) {
      if (window.isDestroyed()) return
      if (attempt === maxLoadAttempts) {
        console.error(`yakitori: giving up loading ${targetUrl}`, error)
        app.exit(1)
        return
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, loadRetryDelayMs)
      })
    }
  }
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
  // Startup may already have created the application (e.g. bindHttpServer
  // failed with EADDRINUSE); close it before exiting so the store is not
  // left open.
  if (application === undefined) {
    app.exit(1)
    return
  }
  void application
    .close()
    .catch((closeError: unknown) => {
      console.error("yakitori: application close failed", closeError)
    })
    .finally(() => {
      app.exit(1)
    })
}
