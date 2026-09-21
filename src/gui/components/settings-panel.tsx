import { Bell, Keyboard, Monitor, Settings2 } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  getNotificationPermission,
  type NotificationPermissionState,
  sendTestNotification,
} from "../completion-notifications.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  type Preferences,
  usePreferencesStore,
} from "../store/preferences-store.ts"
import "../styles/settings.css"

export function SettingsButton() {
  const openSettings = useAppStore((state) => state.openSettings)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "," ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return
      event.preventDefault()
      useAppStore.getState().openSettings()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  return (
    <div className="settings-entry">
      <button
        type="button"
        className="sidebar-row w-full"
        onClick={() => openSettings()}
        title="Settings (⌘,)"
      >
        <Settings2 size={16} />
        <span className="flex-1 text-left">Settings</span>
        <kbd>⌘ ,</kbd>
      </button>
    </div>
  )
}

export function GeneralSettingsSection() {
  const preferences = usePreferencesStore()
  const [error, setError] = useState<string>()
  const update = (patch: Partial<Preferences>) => {
    try {
      preferences.updatePreferences(patch)
      setError(undefined)
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      setError("Your preferences could not be saved. Check available storage.")
    }
  }
  return (
    <>
      <div className="settings-section-heading">
        <Monitor size={22} />
        <h3>General</h3>
        <p>A workspace that works your way.</p>
      </div>
      <SettingRow
        title="Appearance"
        description="Choose a theme, or follow your system."
      >
        <select
          aria-label="Appearance"
          value={preferences.appearance}
          onChange={(event) =>
            update({
              appearance: event.target.value as Preferences["appearance"],
            })
          }
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </SettingRow>
      <SettingRow
        title="Send messages with"
        description="Applies to conversations and side chats."
      >
        <select
          aria-label="Send messages with"
          value={preferences.sendShortcut}
          onChange={(event) =>
            update({
              sendShortcut: event.target.value as Preferences["sendShortcut"],
            })
          }
        >
          <option value="enter">Enter</option>
          <option value="mod-enter">⌘ / Ctrl + Enter</option>
        </select>
      </SettingRow>
      <div className="settings-hint">
        <Keyboard size={16} />
        <span>
          {preferences.sendShortcut === "enter"
            ? "Use Shift + Enter to add a new line."
            : "Enter adds a new line. ⌘ / Ctrl + Enter sends your message."}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="settings-saved">
        Changes are saved automatically on this device.
      </p>
    </>
  )
}

export function NotificationSettingsSection() {
  const preferences = usePreferencesStore()
  const [error, setError] = useState<string>()
  const update = (patch: Partial<Preferences>) => {
    try {
      preferences.updatePreferences(patch)
      setError(undefined)
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      setError("Your preferences could not be saved. Check available storage.")
    }
  }
  return (
    <>
      <div className="settings-section-heading">
        <Bell size={22} />
        <h3>Notifications</h3>
        <p>Step away. Know when your work is ready.</p>
      </div>
      <SettingRow
        title="When work finishes"
        description="Notify when a conversation finishes successfully."
      >
        <select
          aria-label="When work finishes"
          value={preferences.notificationMode}
          onChange={(event) =>
            update({
              notificationMode: event.target
                .value as Preferences["notificationMode"],
            })
          }
        >
          <option value="unfocused">When away</option>
          <option value="always">Always</option>
          <option value="off">Never</option>
        </select>
      </SettingRow>
      <SettingRow
        title="Notification sound"
        description="Play a sound with system notifications."
      >
        <input
          type="checkbox"
          role="switch"
          aria-checked={preferences.notificationSound}
          aria-label="Notification sound"
          className="settings-switch"
          checked={preferences.notificationSound}
          disabled={preferences.notificationMode === "off"}
          onChange={(event) =>
            update({ notificationSound: event.target.checked })
          }
        />
      </SettingRow>
      <p className="settings-hint">
        “When away” sends notifications only while the app window is not in
        focus.
      </p>
      <NotificationCheck />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="settings-saved">
        Changes are saved automatically on this device.
      </p>
    </>
  )
}

function NotificationCheck() {
  const [permission, setPermission] = useState<NotificationPermissionState>()
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<string>()
  useEffect(() => {
    let current = true
    const refresh = () => {
      void getNotificationPermission().then(
        (value) => {
          if (current) setPermission(value)
        },
        () => {
          if (current) setMessage("Could not check notification availability.")
        },
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      current = false
      window.removeEventListener("focus", refresh)
    }
  }, [])
  return (
    <div className="settings-notification-check">
      <p>
        {permission === "unsupported"
          ? "System notifications are unavailable in this environment."
          : permission === "denied"
            ? "Notifications are blocked. Allow them in your browser’s site settings."
            : window.yakitoriDesktop?.notifications
              ? "Delivery follows your system notification and Focus settings."
              : permission === "default"
                ? "Send a test to allow notifications in this browser."
                : "Browser notifications are enabled."}
      </p>
      <button
        type="button"
        disabled={
          testing || permission === "unsupported" || permission === "denied"
        }
        onClick={async () => {
          setTesting(true)
          const result = await sendTestNotification()
          setMessage(
            result === "sent"
              ? "Test notification sent. If it does not appear, check your system notification settings."
              : result === "denied"
                ? "Permission was not granted. Allow notifications in your browser’s site settings."
                : result === "unsupported"
                  ? "System notifications are unavailable in this environment."
                  : "The test notification could not be sent.",
          )
          if (result === "denied") setPermission("denied")
          if (result === "sent") setPermission("granted")
          if (result === "unsupported") setPermission("unsupported")
          setTesting(false)
        }}
      >
        {testing ? "Sending…" : "Send test notification"}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  )
}

function SettingRow({
  title,
  description,
  children,
}: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return (
    <div className="settings-row">
      <div>
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}
