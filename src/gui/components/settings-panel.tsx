import { Bell, Keyboard, Monitor } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  getNotificationPermission,
  type NotificationPermissionState,
  sendTestNotification,
} from "../completion-notifications.ts"
import {
  type Preferences,
  usePreferencesStore,
} from "../store/preferences-store.ts"
import { Select } from "./ui/select.tsx"
import "../styles/settings.css"

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
      <div className="settings-group">
        <SettingRow
          title="Appearance"
          description="Choose a theme, or follow your system."
        >
          <Select
            aria-label="Appearance"
            value={preferences.appearance}
            onValueChange={(appearance) => update({ appearance })}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </SettingRow>
        <SettingRow
          title="Send messages with"
          description="Applies to conversations and side chats."
        >
          <Select
            aria-label="Send messages with"
            value={preferences.sendShortcut}
            onValueChange={(sendShortcut) => update({ sendShortcut })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: "⌘ / Ctrl + Enter" },
            ]}
          />
        </SettingRow>
      </div>
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
      <div className="settings-group">
        <SettingRow
          title="When work finishes"
          description="Notify when a conversation finishes successfully."
        >
          <Select
            aria-label="When work finishes"
            value={preferences.notificationMode}
            onValueChange={(notificationMode) => update({ notificationMode })}
            options={[
              { value: "unfocused", label: "When away" },
              { value: "always", label: "Always" },
              { value: "off", label: "Never" },
            ]}
          />
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
      </div>
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
