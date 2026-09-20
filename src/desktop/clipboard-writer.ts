import { type BrowserWindow, clipboard, ipcMain } from "electron"
import { requireTrustedSender } from "./resource-opener.ts"

export function registerClipboardWriter(trustedWindow: BrowserWindow): void {
  ipcMain.handle("yakitori:write-clipboard-text", (event, text: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    if (typeof text !== "string")
      throw new TypeError("Clipboard text must be a string.")
    clipboard.writeText(text)
  })
}
