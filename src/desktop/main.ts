import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, dialog } from "electron"
import { loadLocalEnvFile } from "../server/env-file.ts"
import { registerAttachmentImporter } from "./attachment-importer.ts"
import { registerResourceOpener } from "./resource-opener.ts"
import { type ServerProcess, spawnServerProcess } from "./server-process.ts"

// The bundle lands at dist/desktop/main.js, so the repo root is two levels up.
// (No new URL("./x", import.meta.url) — the bundler inlines that as a data: URL.)
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Dev spawns the sidecar from the checkout with cwd at the repo root, so the
// child picks up the local .env itself. Packaged installs have no checkout
// .env; users configure keys via their shell environment instead.
if (!app.isPackaged) {
  loadLocalEnvFile(path.join(appRoot, ".env"))
}

const maxLoadAttempts = 20
const loadRetryDelayMs = 500
const forceQuitDelayMs = 10_000

let serverProcess: ServerProcess | undefined
let stopping = false
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
  stopping = true
  const forceQuit = setTimeout(() => {
    app.exit(1)
  }, forceQuitDelayMs)
  // Backstop only; the timer must never keep the process alive by itself.
  forceQuit.unref()
  shutdown = (serverProcess?.stop() ?? Promise.resolve()).then(
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

// Thin shell: the main process only spawns/manages the sidecar server child
// and the window. Dev and prod share the topology; only the spawn differs.
async function start(): Promise<void> {
  const workspace = await resolveWorkspace()
  const storeDir =
    process.env.YAKITORI_STORE_DIR ?? path.join(workspace, ".yakitori")
  const child = app.isPackaged
    ? await spawnServerProcess({
        command: process.execPath,
        args: [packagedServerEntry()],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          YAKITORI_WORKSPACE: workspace,
          YAKITORI_STORE_DIR: storeDir,
          YAKITORI_GUI_DIR: path.join(process.resourcesPath, "gui"),
        },
      })
    : await spawnServerProcess({
        command: "node",
        // --watch restarts the child on server edits without touching the
        // window. A fixed dev port keeps the GUI's api param valid across
        // restarts; prod binds ephemeral ports instead.
        args: ["--watch", path.join(appRoot, "src", "server", "start.ts")],
        cwd: appRoot,
        env: {
          ...process.env,
          PORT: process.env.PORT ?? "4142",
          YAKITORI_WORKSPACE: workspace,
          YAKITORI_STORE_DIR: storeDir,
        },
      })
  serverProcess = child
  child.child.on("exit", (code, signal) => {
    if (stopping) return
    console.error(
      `yakitori: sidecar server exited unexpectedly (code ${code}, signal ${signal})`,
    )
    app.exit(1)
  })
  console.log(`yakitori: sidecar listening on ${child.url}`)
  openMainWindow(windowTarget(child.url), workspace, child)
}

function windowTarget(serverUrl: string): string {
  const renderer = process.env.ELECTRON_RENDERER_URL
  // Prod serves the built GUI same-origin from the sidecar itself.
  if (renderer === undefined) return serverUrl
  const url = new URL(renderer)
  url.searchParams.set("api", serverUrl)
  return url.toString()
}

// asar contents are unreadable to a plain Node child, so the server entry is
// unpacked from the bundle and spawned with ELECTRON_RUN_AS_NODE.
function packagedServerEntry(): string {
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "dist",
    "desktop",
    "server.js",
  )
}

// Dev launches resolve the workspace from the checkout (process.cwd()).
// Packaged launches from Finder have cwd "/", so they pick once via a native
// dialog and remember the choice in the user-data config.
async function resolveWorkspace(): Promise<string> {
  const configured = process.env.YAKITORI_WORKSPACE
  if (configured !== undefined) return configured
  if (!app.isPackaged) return process.cwd()
  const saved = readSavedWorkspace()
  if (saved !== undefined) return saved
  const picked = await dialog.showOpenDialog({
    title: "Choose a Yakitori workspace",
    properties: ["openDirectory", "createDirectory"],
  })
  const fallback = path.join(app.getPath("home"), "Yakitori")
  const workspace = picked.canceled
    ? fallback
    : (picked.filePaths[0] ?? fallback)
  mkdirSync(workspace, { recursive: true })
  // Losing the saved choice only means the picker reappears next launch;
  // it must not fail this startup.
  try {
    writeFileSync(
      workspaceConfigPath(),
      `${JSON.stringify({ workspace }, null, 2)}\n`,
    )
  } catch (error) {
    console.error("yakitori: could not persist workspace choice", error)
  }
  return workspace
}

function readSavedWorkspace(): string | undefined {
  if (!existsSync(workspaceConfigPath())) return undefined
  // A corrupt config must not block startup; fall back to the picker.
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(workspaceConfigPath(), "utf8"),
    )
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("workspace" in parsed) ||
      typeof parsed.workspace !== "string" ||
      !existsSync(parsed.workspace)
    ) {
      return undefined
    }
    return parsed.workspace
  } catch {
    return undefined
  }
}

function workspaceConfigPath(): string {
  return path.join(app.getPath("userData"), "workspace.json")
}

function openMainWindow(
  targetUrl: string,
  workspace: string,
  server: ServerProcess,
): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Yakitori",
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "preload.cjs",
      ),
    },
  })
  registerResourceOpener(workspace, window)
  registerAttachmentImporter(server, window)
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

function failStartup(error: unknown): void {
  console.error("yakitori: startup failed", error)
  stopping = true
  // Startup may already have spawned the sidecar (e.g. the window load
  // failed); stop it before exiting so no orphaned server is left behind.
  void (serverProcess?.stop() ?? Promise.resolve())
    .catch((stopError: unknown) => {
      console.error("yakitori: sidecar stop failed", stopError)
    })
    .finally(() => {
      app.exit(1)
    })
}
