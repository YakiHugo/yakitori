import type {
  CompletionNotificationRequest,
  NotificationDeliveryResult,
  NotificationPermissionState,
} from "../desktop/completion-notification-types.ts"
import type { AppRpcClient } from "./lib/rpc-client.ts"
import { usePreferencesStore } from "./store/preferences-store.ts"

export type { NotificationDeliveryResult, NotificationPermissionState }

type CompletionSource = Pick<AppRpcClient, "subscribeToCompletions">

// A client's lifetime spans session selection, reconnects, and React effect
// remounts. Consume even suppressed completions so settings/focus changes never
// turn an old completion into a notification.
const consumedByClient = new WeakMap<CompletionSource, Set<string>>()

export function startCompletionNotifications(
  client: CompletionSource,
  apiBase: string,
): () => void {
  const apiOrigin = new URL(apiBase, window.location.href).origin
  const consumed = consumedByClient.get(client) ?? new Set<string>()
  consumedByClient.set(client, consumed)
  return client.subscribeToCompletions((completion) => {
    const key = JSON.stringify([completion.sessionId, completion.turnId])
    if (consumed.has(key)) return
    consumed.add(key)
    const { notificationMode, notificationSound } =
      usePreferencesStore.getState()
    if (notificationMode === "off") return
    void showNotification(
      {
        title: "Yakitori — task complete",
        body: completion.title?.trim() || "Your task has finished.",
        mode: notificationMode,
        sound: notificationSound,
      },
      `yakitori:${JSON.stringify([apiOrigin, completion.sessionId, completion.turnId])}`,
    )
  })
}

export async function getNotificationPermission(): Promise<NotificationPermissionState> {
  const native = window.yakitoriDesktop?.notifications
  if (native !== undefined) return native.permission()
  return typeof Notification === "undefined"
    ? "unsupported"
    : Notification.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const native = window.yakitoriDesktop?.notifications
  if (native !== undefined) return native.permission()
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission === "default"
    ? Notification.requestPermission()
    : Notification.permission
}

export async function sendTestNotification(): Promise<NotificationDeliveryResult> {
  try {
    const permission = await requestNotificationPermission()
    if (permission === "unsupported") return "unsupported"
    if (permission !== "granted") return "denied"
    return showNotification({
      title: "Yakitori — test notification",
      body: "You'll be notified when a task finishes.",
      mode: "always",
      sound: usePreferencesStore.getState().notificationSound,
    })
  } catch (error) {
    console.error("yakitori: notification permission request failed", error)
    return "failed"
  }
}

async function showNotification(
  request: CompletionNotificationRequest,
  tag?: string,
): Promise<NotificationDeliveryResult> {
  try {
    const native = window.yakitoriDesktop?.notifications
    if (native !== undefined) return await native.show(request)
    if (typeof Notification === "undefined") return "unsupported"
    if (
      request.mode === "unfocused" &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    ) {
      return "suppressed"
    }
    // Only the explicit settings action requests permission. A live completion
    // must never open a browser prompt or replay after a later permission grant.
    if (Notification.permission !== "granted") return "denied"
    const notification = new Notification(request.title, {
      body: request.body,
      silent: !request.sound,
      // The browser replaces same-origin notifications sharing a tag, including
      // deliveries from other tabs. Keep its default renotify=false.
      ...(tag === undefined ? {} : { tag }),
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return "sent"
  } catch (error) {
    console.error("yakitori: completion notification failed", error)
    return "failed"
  }
}
