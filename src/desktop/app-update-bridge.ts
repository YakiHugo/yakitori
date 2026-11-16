import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
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
import { checkLocalDesktopUpdate } from "./update-local.ts"
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
  let changingSource = false
  let disposed = false
  let sourceChangeAbort: AbortController | undefined
  const requireStableSource = () => {
    if (disposed) throw new Error("The application is closing.")
    if (changingSource)
      throw new Error(
        "The update source is changing. Try again when it finishes.",
      )
  }
  let chooseLocalSource: (() => Promise<void>) | undefined
  let chooseReleaseSource: (() => Promise<void>) | undefined
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
    const sourcePath = path.join(userDataPath, "update-source.json")
    let workspace: string | undefined
    let sourceError: string | undefined
    try {
      const value: unknown = JSON.parse(await readFile(sourcePath, "utf8"))
      if (
        typeof value === "object" &&
        value !== null &&
        "workspace" in value &&
        typeof value.workspace === "string" &&
        path.isAbsolute(value.workspace)
      )
        workspace = value.workspace
      else
        throw new Error(
          "Choose a local workspace or CI releases in the app menu.",
        )
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        sourceError =
          "The update source could not be read. Choose an update source in the app menu."
    }
    const createUpdater = () => {
      const chosenWorkspace = workspace
      const initialError = previousInstallationError ?? sourceError
      return new AppUpdater({
        current,
        applicationPath,
        updatesDirectory: path.join(userDataPath, "updates"),
        onState: publish,
        ...(initialError === undefined
          ? {}
          : { previousInstallationError: initialError }),
        ...(chosenWorkspace === undefined
          ? {}
          : {
              localSource: (signal) =>
                checkLocalDesktopUpdate({
                  workspace: chosenWorkspace,
                  installedAppPath: applicationPath,
                  logPath: path.join(userDataPath, "local-build.log"),
                  signal,
                }),
            }),
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
    updater = createUpdater()
    if (sourceError !== undefined) lastCheck = Date.now()
    const changeSource = async (selected: string | undefined) => {
      requireStableSource()
      changingSource = true
      sourceChangeAbort = new AbortController()
      try {
        const phase = updater?.getState().phase
        if (
          phase === "installing" ||
          phase === "preparing" ||
          phase === "downloading"
        )
          throw new Error(
            "Finish or cancel the current update before changing its source.",
          )
        if (selected !== undefined)
          await checkLocalDesktopUpdate({
            workspace: selected,
            installedAppPath: applicationPath,
            logPath: path.join(userDataPath, "local-build.log"),
            signal: sourceChangeAbort.signal,
          })
        if (disposed) throw new Error("The application is closing.")
        // Failed persistence must leave the current, usable updater in place.
        if (selected === undefined) await rm(sourcePath, { force: true })
        else {
          const temporary = `${sourcePath}.${process.pid}.tmp`
          try {
            await writeFile(
              temporary,
              JSON.stringify({ workspace: selected }),
              {
                mode: 0o600,
              },
            )
            await rename(temporary, sourcePath)
          } finally {
            await rm(temporary, { force: true })
          }
        }
        if (disposed) throw new Error("The application is closing.")
        const previous = updater
        workspace = selected
        sourceError = undefined
        updater = createUpdater()
        await previous?.dispose()
        lastCheck = Date.now()
        if (!disposed) await updater.check()
      } finally {
        changingSource = false
        sourceChangeAbort = undefined
      }
    }
    chooseLocalSource = async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "Choose the local Yakitori source",
        buttonLabel: "Use local workspace",
        properties: ["openDirectory"],
        ...(workspace === undefined ? {} : { defaultPath: workspace }),
      })
      if (!result.canceled && result.filePaths[0])
        await changeSource(await realpath(result.filePaths[0]))
    }
    chooseReleaseSource = () => changeSource(undefined)
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
    requireStableSource()
    await updater?.check()
  })
  ipcMain.handle(channels[2], async (event) => {
    trusted(event)
    requireStableSource()
    if (updater === undefined) throw new Error(unavailable.reason)
    await updater.download()
  })
  ipcMain.handle(channels[3], async (event) => {
    trusted(event)
    requireStableSource()
    if (updater === undefined) throw new Error(unavailable.reason)
    await updater.install()
  })

  const maybeCheck = () => {
    if (disposed || changingSource) return
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
          requireStableSource()
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
  for (const [id, label, action] of [
    [
      "update-source-local",
      "Use Local Workspace for Updates…",
      chooseLocalSource,
    ],
    [
      "update-source-release",
      "Use CI Releases for Updates",
      chooseReleaseSource,
    ],
  ] as const) {
    applicationMenu.insert(
      applicationMenu.items.findIndex(
        (item) => item.id === "check-for-updates",
      ),
      new MenuItem({
        id,
        label,
        enabled: action !== undefined,
        click: () => {
          void action?.().catch((error: unknown) => {
            console.error("yakitori: could not change update source", error)
            if (!window.isDestroyed())
              void dialog
                .showMessageBox(window, {
                  type: "error",
                  message:
                    error instanceof Error ? error.message : String(error),
                  buttons: ["OK"],
                })
                .catch((reportError: unknown) => console.error(reportError))
          })
        },
      }),
    )
  }
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
      disposed = true
      sourceChangeAbort?.abort()
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
