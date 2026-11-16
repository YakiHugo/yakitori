import { readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
} from "electron"
import type { DesktopUpdateState } from "../protocol/desktop-update.ts"
import { AppUpdater } from "./app-updater.ts"
import { requireTrustedSender } from "./resource-opener.ts"
import { parseDesktopBuildInfo } from "./update-release.ts"
import {
  startUpdateInstaller,
  type UpdateInstallerHandle,
} from "./update-worker.ts"

// Focus changes can be frequent. Cache checks to avoid repeatedly hitting the
// unauthenticated GitHub API; the menu always permits an explicit fresh check.
const backgroundCheckIntervalMs = 60 * 60_000

export async function registerAppUpdates(
  window: BrowserWindow,
  requestQuit: () => void,
): Promise<
  Readonly<{
    prepareQuit(): Promise<void>
    cancelQuit(): Promise<void>
    dispose(): Promise<void>
  }>
> {
  let updater: AppUpdater | undefined
  let installer: UpdateInstallerHandle | undefined
  let lastCheck = 0
  const unavailable: DesktopUpdateState = {
    phase: "unavailable",
    reason: "Updates are available in the installed macOS app.",
  }
  const publish = (state: DesktopUpdateState) => {
    if (!window.isDestroyed())
      window.webContents.send("yakitori:update-state", state)
  }
  if (
    app.isPackaged &&
    process.platform === "darwin" &&
    process.arch === "arm64"
  ) {
    const current = parseDesktopBuildInfo(
      JSON.parse(
        await readFile(
          path.join(process.resourcesPath, "build-info.json"),
          "utf8",
        ),
      ),
    )
    const applicationPath = await realpath(
      path.resolve(process.execPath, "..", "..", ".."),
    )
    const userDataPath = await realpath(app.getPath("userData"))
    const previousInstallationError = await readInstallationFailure(
      path.join(userDataPath, "update-result.json"),
    )
    if (previousInstallationError !== undefined) lastCheck = Date.now()
    updater = new AppUpdater({
      current,
      applicationPath,
      updatesDirectory: path.join(userDataPath, "updates"),
      onState: publish,
      ...(previousInstallationError === undefined
        ? {}
        : { previousInstallationError }),
      async install(prepared) {
        installer = await startUpdateInstaller({
          applicationPath,
          preparedAppPath: prepared.appPath,
          directory: prepared.directory,
          userDataPath,
          logPath: path.join(userDataPath, "update.log"),
        })
        requestQuit()
      },
    })
  }
  const getState = () => updater?.getState() ?? unavailable
  const trusted = (event: Electron.IpcMainInvokeEvent) =>
    requireTrustedSender(event.sender, event.senderFrame, window)
  const channels = [
    "yakitori:update-state-get",
    "yakitori:update-check",
    "yakitori:update-download",
    "yakitori:update-install",
  ] as const
  ipcMain.handle(channels[0], (event) => {
    trusted(event)
    return getState()
  })
  ipcMain.handle(channels[1], async (event) => {
    trusted(event)
    await updater?.check()
  })
  ipcMain.handle(channels[2], async (event) => {
    trusted(event)
    if (updater === undefined) throw new Error(unavailable.reason)
    await updater.download()
  })
  ipcMain.handle(channels[3], async (event) => {
    trusted(event)
    if (updater === undefined) throw new Error(unavailable.reason)
    await updater.install()
  })

  const maybeCheck = () => {
    if (Date.now() - lastCheck < backgroundCheckIntervalMs) return
    lastCheck = Date.now()
    void updater?.check()
  }
  window.webContents.on("did-finish-load", maybeCheck)
  window.on("focus", maybeCheck)
  const menu =
    Menu.getApplicationMenu() ??
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ])
  const applicationMenu = menu.items[0]?.submenu
  if (applicationMenu === undefined)
    throw new Error("The application menu is missing.")
  const quitIndex = applicationMenu.items.findIndex(
    (item) => item.role === "quit",
  )
  applicationMenu.insert(
    quitIndex < 0 ? applicationMenu.items.length : quitIndex,
    new MenuItem({
      id: "check-for-updates",
      label: "Check for Updates…",
      click: () => {
        void (async () => {
          lastCheck = Date.now()
          await updater?.check()
          const state = getState()
          if (state.phase === "idle" || state.phase === "unavailable")
            await dialog.showMessageBox(window, {
              type: "info",
              message:
                state.phase === "unavailable"
                  ? state.reason
                  : "You're up to date.",
              buttons: ["OK"],
            })
        })().catch((error: unknown) => {
          console.error("yakitori: update check failed", error)
        })
      },
    }),
  )
  Menu.setApplicationMenu(menu)
  return {
    async prepareQuit() {
      await updater?.waitForInstaller()
      await installer?.arm()
    },
    async cancelQuit() {
      await updater?.waitForInstaller()
      await installer?.cancel()
      installer = undefined
      updater?.cancelInstallation()
    },
    async dispose() {
      if (!window.isDestroyed()) {
        window.webContents.off("did-finish-load", maybeCheck)
        window.off("focus", maybeCheck)
      }
      for (const channel of channels) ipcMain.removeHandler(channel)
      await updater?.dispose()
    },
  }
}

async function readInstallationFailure(
  filePath: string,
): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined
    throw error
  }
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    await rm(filePath)
    return "The previous update result could not be read. Check for updates to try again."
  }
  await rm(filePath)
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "installed"
  )
    return undefined
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "failed" &&
    "message" in result &&
    typeof result.message === "string"
  )
    return result.message
  return "The previous update did not finish. Check for updates to try again."
}
