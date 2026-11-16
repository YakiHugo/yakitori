import { EventEmitter } from "node:events"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { beforeEach, expect, type Mock, test, vi } from "vitest"
import { registerAppUpdates } from "../../src/desktop/app-update-bridge.ts"
import type { DesktopUpdateState } from "../../src/protocol/desktop-update.ts"

type UpdaterOptions = ConstructorParameters<
  typeof import("../../src/desktop/app-updater.ts").AppUpdater
>[0]
type UpdaterStub = {
  options: UpdaterOptions
  check: Mock<() => Promise<void>>
  download: Mock<() => Promise<void>>
  install: Mock<() => Promise<void>>
  dispose: Mock<() => Promise<void>>
}
type MenuAction = { id?: string; role?: string; click?: () => void }

const mock = vi.hoisted(() => ({
  userData: "",
  sourcePath: "",
  failSourceWrite: false,
  updaters: [] as UpdaterStub[],
  handlers: new Map<string, (event: Electron.IpcMainInvokeEvent) => unknown>(),
  menuItems: [] as MenuAction[],
  chooseDirectory: vi.fn(),
  showMessageBox: vi.fn(),
  checkLocal: vi.fn(),
  startInstaller: vi.fn(),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (
        mock.failSourceWrite &&
        args[0] === `${mock.sourcePath}.${process.pid}.tmp`
      )
        throw Object.assign(new Error("Source save denied"), { code: "EACCES" })
      return fs.writeFile(...args)
    },
  }
})

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => mock.userData },
  dialog: {
    showOpenDialog: mock.chooseDirectory,
    showMessageBox: mock.showMessageBox,
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: Electron.IpcMainInvokeEvent) => unknown,
    ) => mock.handlers.set(channel, handler),
    removeHandler: (channel: string) => mock.handlers.delete(channel),
  },
  Menu: {
    getApplicationMenu: () => ({
      items: [
        {
          submenu: {
            items: mock.menuItems,
            insert: (index: number, item: MenuAction) =>
              mock.menuItems.splice(index, 0, item),
          },
        },
      ],
    }),
    setApplicationMenu: vi.fn(),
  },
  MenuItem: class {
    constructor(options: MenuAction) {
      Object.assign(this, options)
    }
  },
}))

vi.mock("../../src/desktop/resource-opener.ts", () => ({
  requireTrustedSender: vi.fn(),
}))
vi.mock("../../src/desktop/update-local.ts", () => ({
  checkLocalDesktopUpdate: mock.checkLocal,
}))
vi.mock("../../src/desktop/update-worker.ts", () => ({
  startUpdateInstaller: mock.startInstaller,
}))
vi.mock("../../src/desktop/app-updater.ts", () => ({
  AppUpdater: class {
    options: UpdaterOptions
    check = vi.fn(async () => {})
    download = vi.fn(async () => {})
    install = vi.fn(async () => {
      await this.options.install({
        directory: "/prepared",
        appPath: "/prepared/Yakitori.app",
      })
    })
    dispose = vi.fn(async () => {})
    getState = (): DesktopUpdateState => ({
      phase: "idle",
      current: this.options.current,
    })
    waitForInstaller = vi.fn(async () => {})
    cancelInstallation = vi.fn()
    constructor(options: UpdaterOptions) {
      this.options = options
      mock.updaters.push(this)
    }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mock.updaters.length = 0
  mock.handlers.clear()
  mock.menuItems.splice(0, mock.menuItems.length, { role: "quit" })
  mock.failSourceWrite = false
  mock.showMessageBox.mockResolvedValue({ response: 0 })
  mock.checkLocal.mockResolvedValue({
    release: {
      source: "local",
      version: "0.0.0",
      commit: "a".repeat(40),
      buildNumber: 0,
      buildAttempt: 0,
      publishedAt: "2026-11-15T01:02:03Z",
      releaseUrl: "",
    },
    prepare: vi.fn(),
  })
  mock.startInstaller.mockResolvedValue({ arm: vi.fn(), cancel: vi.fn() })
})

async function fixture(
  action: (value: {
    oldWorkspace: string
    newWorkspace: string
    window: EventEmitter & { webContents: EventEmitter }
    requestQuit: Mock<() => void>
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-update-bridge-")),
  )
  const descriptors = new Map(
    ["resourcesPath", "platform", "arch"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(process, name),
    ]),
  )
  let bridge: Awaited<ReturnType<typeof registerAppUpdates>> | undefined
  try {
    mock.userData = join(root, "profile")
    mock.sourcePath = join(mock.userData, "update-source.json")
    const resources = join(root, "resources")
    const oldWorkspace = join(root, "old-source")
    const newWorkspace = join(root, "new-source")
    await Promise.all(
      [mock.userData, resources, oldWorkspace, newWorkspace].map((path) =>
        mkdir(path),
      ),
    )
    await writeFile(
      mock.sourcePath,
      JSON.stringify({ workspace: oldWorkspace }),
    )
    await writeFile(
      join(resources, "build-info.json"),
      JSON.stringify({
        repository: "YakiHugo/yakitori",
        version: "0.0.0",
        commit: "a".repeat(40),
        dirty: false,
        channel: "local",
        buildNumber: 0,
        buildAttempt: 0,
        builtAt: "2026-11-15T01:02:03Z",
        platform: "darwin",
        arch: "arm64",
      }),
    )
    Object.defineProperty(process, "resourcesPath", {
      value: resources,
      configurable: true,
    })
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    })
    Object.defineProperty(process, "arch", {
      value: "arm64",
      configurable: true,
    })
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
    })
    const requestQuit = vi.fn<() => void>()
    mock.chooseDirectory.mockResolvedValue({
      canceled: false,
      filePaths: [newWorkspace],
    })
    bridge = await registerAppUpdates(
      window as unknown as BrowserWindow,
      requestQuit,
    )
    await action({ oldWorkspace, newWorkspace, window, requestQuit })
  } finally {
    mock.failSourceWrite = false
    await bridge?.dispose()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process, name, descriptor)
      else Reflect.deleteProperty(process, name)
    }
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
}

function click(id: string): void {
  const item = mock.menuItems.find((candidate) => candidate.id === id)
  if (!item?.click) throw new Error(`Missing app menu action: ${id}`)
  item.click()
}

async function invoke(channel: string): Promise<unknown> {
  const handler = mock.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler({} as Electron.IpcMainInvokeEvent)
}

test("a failed source save preserves the configured source and keeps the old updater usable", async () => {
  await fixture(async ({ oldWorkspace, newWorkspace }) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const old = mock.updaters[0]
    expect(old).toBeDefined()
    mock.failSourceWrite = true
    click("update-source-local")
    await vi.waitFor(() =>
      expect(mock.showMessageBox).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "error",
          message: "Source save denied",
        }),
      ),
    )
    expect(mock.checkLocal).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: newWorkspace }),
    )
    expect(JSON.parse(await readFile(mock.sourcePath, "utf8"))).toEqual({
      workspace: oldWorkspace,
    })
    expect(await readdir(mock.userData)).toEqual(["update-source.json"])
    expect(mock.updaters).toHaveLength(1)
    expect(old?.dispose).not.toHaveBeenCalled()
    await invoke("yakitori:update-check")
    await invoke("yakitori:update-download")
    expect(old?.check).toHaveBeenCalledOnce()
    expect(old?.download).toHaveBeenCalledOnce()
    await old?.options.localSource?.(new AbortController().signal)
    expect(mock.checkLocal).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: oldWorkspace }),
    )
  })
})

test("pending source validation blocks update actions and swaps the updater only after saving the chosen source", async () => {
  await fixture(async ({ oldWorkspace, newWorkspace, window, requestQuit }) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const validation =
      Promise.withResolvers<
        Awaited<
          ReturnType<
            typeof import("../../src/desktop/update-local.ts").checkLocalDesktopUpdate
          >
        >
      >()
    mock.checkLocal.mockReturnValueOnce(validation.promise)
    const old = mock.updaters[0]
    click("update-source-local")
    await vi.waitFor(() => expect(mock.checkLocal).toHaveBeenCalledOnce())
    await expect(invoke("yakitori:update-check")).rejects.toThrow()
    await expect(invoke("yakitori:update-download")).rejects.toThrow()
    await expect(invoke("yakitori:update-install")).rejects.toThrow()
    click("check-for-updates")
    window.emit("focus")
    window.webContents.emit("did-finish-load")
    expect(old?.check).not.toHaveBeenCalled()
    expect(old?.download).not.toHaveBeenCalled()
    expect(old?.install).not.toHaveBeenCalled()
    expect(old?.dispose).not.toHaveBeenCalled()
    expect(mock.startInstaller).not.toHaveBeenCalled()
    expect(requestQuit).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(mock.sourcePath, "utf8"))).toEqual({
      workspace: oldWorkspace,
    })
    expect(mock.updaters).toHaveLength(1)
    validation.resolve({
      release: {
        source: "local",
        version: "0.0.0",
        commit: "b".repeat(40),
        buildNumber: 0,
        buildAttempt: 0,
        publishedAt: "2026-11-15T01:02:03Z",
        releaseUrl: "",
      },
      prepare: vi.fn(),
    })
    await vi.waitFor(() => expect(mock.updaters).toHaveLength(2))
    const next = mock.updaters[1]
    await vi.waitFor(() => expect(next?.check).toHaveBeenCalledOnce())
    expect(old?.dispose).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(mock.sourcePath, "utf8"))).toEqual({
      workspace: newWorkspace,
    })
    expect(await readdir(mock.userData)).toEqual(["update-source.json"])
    await invoke("yakitori:update-download")
    expect(next?.download).toHaveBeenCalledOnce()
    expect(old?.download).not.toHaveBeenCalled()
    await next?.options.localSource?.(new AbortController().signal)
    expect(mock.checkLocal).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: newWorkspace }),
    )
  })
})
