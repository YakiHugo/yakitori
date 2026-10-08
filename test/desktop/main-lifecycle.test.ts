import { afterEach, expect, it, vi } from "vitest"

const shell = vi.hoisted(() => ({
  load: vi.fn(),
  exit: vi.fn(),
  stop: vi.fn(),
}))
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    app: Object.assign(new EventEmitter(), {
      whenReady: () => Promise.resolve(),
      isPackaged: false,
      exit: shell.exit,
      quit: vi.fn(),
    }),
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn() },
      })
      isDestroyed = () => false
      loadURL = shell.load
    },
    dialog: {},
  }
})
vi.mock("../../src/server/env-file.ts", () => ({
  loadLocalEnvFile: vi.fn(),
  resolveYakitoriHome: () => "/tmp",
}))
vi.mock("../../src/desktop/server-process.ts", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    spawnServerProcess: async () => ({
      child: new EventEmitter(),
      url: "http://127.0.0.1:4142",
      stop: shell.stop,
    }),
  }
})
vi.mock("../../src/desktop/attachment-importer.ts", () => ({
  registerAttachmentImporter: vi.fn(),
}))
vi.mock("../../src/desktop/clipboard-writer.ts", () => ({
  registerClipboardWriter: vi.fn(),
}))
vi.mock("../../src/desktop/completion-notifications.ts", () => ({
  registerCompletionNotifications: vi.fn(),
}))
vi.mock("../../src/desktop/project-picker.ts", () => ({
  registerProjectPicker: vi.fn(),
}))
vi.mock("../../src/desktop/resource-opener.ts", () => ({
  registerResourceOpener: vi.fn(),
}))
vi.mock("../../src/desktop/workspace-browser.ts", () => ({
  registerWorkspaceBrowser: vi.fn(),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it("waits for sidecar shutdown before exiting after renderer load retries fail", async () => {
  vi.useFakeTimers()
  vi.stubEnv("YAKITORI_WORKSPACE", "/tmp")
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  shell.load.mockRejectedValue(new Error("Renderer unavailable"))
  let finishStop: (() => void) | undefined
  shell.stop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishStop = resolve
      }),
  )
  await import("../../src/desktop/main.ts")
  await vi.advanceTimersByTimeAsync(10_000)
  expect(shell.load).toHaveBeenCalledTimes(20)
  expect(shell.stop).toHaveBeenCalledTimes(1)
  expect(shell.exit).not.toHaveBeenCalled()
  finishStop?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(shell.exit).toHaveBeenCalledWith(1)
})
