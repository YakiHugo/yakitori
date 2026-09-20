import type { BrowserWindow } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerClipboardWriter } from "../../src/desktop/clipboard-writer.ts"

type Request = { sender: unknown; senderFrame: unknown }
type Handler = (event: Request, text: unknown) => void
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  writeText: vi.fn(),
}))
vi.mock("electron", () => ({
  clipboard: { writeText: electron.writeText },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      electron.handlers.set(channel, handler),
  },
}))

beforeEach(() => {
  electron.handlers.clear()
  electron.writeText.mockReset()
})

function register() {
  const mainFrame = {}
  const webContents = { mainFrame }
  const isDestroyed = vi.fn(() => false)
  registerClipboardWriter({
    webContents,
    isDestroyed,
  } as unknown as BrowserWindow)
  const handler = electron.handlers.get("yakitori:write-clipboard-text")
  if (!handler) throw new Error("Clipboard IPC handler was not registered.")
  return {
    handler,
    event: { sender: webContents, senderFrame: mainFrame },
    isDestroyed,
  }
}

describe("trusted desktop clipboard writes", () => {
  it("writes exact Unicode and multiline text from the main GUI frame", () => {
    const { handler, event } = register()
    handler(event, "复制\nconst answer = 42;\n")
    expect(electron.writeText).toHaveBeenCalledWith(
      "复制\nconst answer = 42;\n",
    )
  })

  it("refuses remote browser contents, subframes, and a closed GUI before writing", () => {
    const { handler, event, isDestroyed } = register()
    expect(() => handler({ ...event, sender: {} }, "remote")).toThrow(
      "untrusted frame",
    )
    expect(() => handler({ ...event, senderFrame: {} }, "iframe")).toThrow(
      "untrusted frame",
    )
    expect(() => handler({ ...event, senderFrame: null }, "detached")).toThrow(
      "untrusted frame",
    )
    isDestroyed.mockReturnValue(true)
    expect(() => handler(event, "closed")).toThrow("untrusted frame")
    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it("rejects nontext input and propagates native failure to the caller", () => {
    const { handler, event } = register()
    expect(() => handler(event, { text: "not a string" })).toThrow(
      "must be a string",
    )
    expect(electron.writeText).not.toHaveBeenCalled()
    electron.writeText.mockImplementation(() => {
      throw new Error("Clipboard busy")
    })
    expect(() => handler(event, "retry me")).toThrow("Clipboard busy")
  })
})
