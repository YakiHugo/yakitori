import { type BrowserWindow, ipcMain, Notification } from "electron"
import type {
  CompletionNotificationRequest,
  NotificationDeliveryResult,
} from "./completion-notification-types.ts"
import { requireTrustedSender } from "./resource-opener.ts"

export function registerCompletionNotifications(window: BrowserWindow): void {
  ipcMain.handle("yakitori:notification-permission", (event) => {
    requireTrustedSender(event.sender, event.senderFrame, window)
    // Electron has no API for reading the OS's per-app notification setting.
    return Notification.isSupported() ? "granted" : "unsupported"
  })
  ipcMain.handle(
    "yakitori:notification-show",
    (event, input: unknown): NotificationDeliveryResult => {
      requireTrustedSender(event.sender, event.senderFrame, window)
      const request = requireNotificationRequest(input)
      if (!Notification.isSupported()) return "unsupported"
      // Main owns native focus; a renderer document's focus can be stale while
      // minimized or while a native dialog / embedded browser has focus.
      if (request.mode === "unfocused" && window.isFocused()) return "suppressed"
      const notification = new Notification({
        title: request.title,
        body: request.body,
        silent: !request.sound,
      })
      notification.on("click", () => {
        if (window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      })
      notification.on("failed", (_event, error) => {
        console.error("yakitori: native completion notification failed", error)
      })
      notification.show()
      return "sent"
    },
  )
}

function requireNotificationRequest(input: unknown): CompletionNotificationRequest {
  if (
    typeof input !== "object" ||
    input === null ||
    !("title" in input) ||
    typeof input.title !== "string" ||
    !("body" in input) ||
    typeof input.body !== "string" ||
    !("mode" in input) ||
    (input.mode !== "unfocused" && input.mode !== "always") ||
    !("sound" in input) ||
    typeof input.sound !== "boolean"
  ) {
    throw new TypeError("Invalid completion notification.")
  }
  return {
    title: input.title,
    body: input.body,
    mode: input.mode,
    sound: input.sound,
  }
}
