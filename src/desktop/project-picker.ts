import { type BrowserWindow, dialog, ipcMain } from "electron"
import { requireTrustedSender } from "./resource-opener.ts"

export function registerProjectPicker(trustedWindow: BrowserWindow): void {
  let pending: Promise<string | null> | undefined
  ipcMain.handle("yakitori:pick-project-folder", (event) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    // One native sheet per window, including repeated renderer invocations.
    pending ??= dialog
      .showOpenDialog(trustedWindow, {
        title: "Choose source folder",
        buttonLabel: "Add folder",
        properties: ["openDirectory", "createDirectory"],
      })
      .then((result) =>
        result.canceled ? null : (result.filePaths[0] ?? null),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  })
}
