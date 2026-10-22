import type { BrowserWindow } from "electron"
import { expect, it, vi } from "vitest"
import { registerWindowFocus } from "../../src/desktop/window-focus.ts"

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  focus: vi.fn(),
}))
vi.mock("electron", () => ({
  ipcMain: { handle: electron.handle },
  app: { focus: electron.focus },
}))

it("restores the trusted GUI window and refuses focus requests from other frames", () => {
  const webContents = { mainFrame: {} }
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  registerWindowFocus(window as unknown as BrowserWindow)
  const handler = electron.handle.mock.calls.at(-1)?.[1] as (event: {
    sender: unknown
    senderFrame: unknown
  }) => void
  for (const event of [
    { sender: {}, senderFrame: webContents.mainFrame },
    { sender: webContents, senderFrame: {} },
  ])
    expect(() => handler(event)).toThrow("untrusted frame")
  expect(window.show).not.toHaveBeenCalled()
  handler({ sender: webContents, senderFrame: webContents.mainFrame })
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
  expect(electron.focus).toHaveBeenCalledWith({ steal: true })
})
