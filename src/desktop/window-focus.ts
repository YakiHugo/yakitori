import { app, type BrowserWindow, ipcMain } from "electron"
import { requireTrustedSender } from "./resource-opener.ts"

export function registerWindowFocus(window: BrowserWindow): void {
  ipcMain.handle("yakitori:focus-window", (event) => {
    requireTrustedSender(event.sender, event.senderFrame, window)
    if (window.isMinimized()) window.restore()
    window.show()
    app.focus({ steal: true })
    window.focus()
  })
}
