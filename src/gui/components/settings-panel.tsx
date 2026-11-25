import { useTranslation } from "../i18n/use-translation.ts"
import { Keyboard } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  getNotificationPermission,
  type NotificationPermissionState,
  sendTestNotification,
} from "../completion-notifications.ts"
import type { Message } from "../i18n/messages.ts"
import {
  type Preferences,
  usePreferencesStore,
} from "../store/preferences-store.ts"
import { Select } from "./ui/select.tsx"
import "../styles/settings.css"

function usePreferenceSettings() {
  const preferences = usePreferencesStore()
  const [saveFailed, setSaveFailed] = useState(false)
  const update = (patch: Partial<Preferences>) => {
    try {
      preferences.updatePreferences(patch)
      setSaveFailed(false)
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      setSaveFailed(true)
    }
  }
  return { preferences, saveFailed, update }
}

export function GeneralSettingsSection() {
  const { t } = useTranslation()
  const { preferences, saveFailed, update } = usePreferenceSettings()
  return (
    <>
      <div className="settings-group">
        <SettingRow
          title={t("Language")}
          description={t("Choose the language used in the app.")}
        >
          <Select
            aria-label={t("Language")}
            value={preferences.language}
            onValueChange={(language) => update({ language })}
            options={[
              { value: "system", label: t("System") },
              { value: "en", label: "English" },
              { value: "zh-CN", label: "简体中文" },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t("Appearance")}
          description={t("Choose a theme, or follow your system.")}
        >
          <Select
            aria-label={t("Appearance")}
            value={preferences.appearance}
            onValueChange={(appearance) => update({ appearance })}
            options={[
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
              { value: "system", label: t("System") },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t("Send messages with")}
          description={t("Applies to conversations and side chats.")}
        >
          <Select
            aria-label={t("Send messages with")}
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
            ? t("Use Shift + Enter to add a new line.")
            : t("Enter adds a new line. ⌘ / Ctrl + Enter sends your message.")}
        </span>
      </div>
      {saveFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t("Your preferences could not be saved. Check available storage.")}
        </p>
      )}
    </>
  )
}

export function NotificationSettingsSection() {
  const { t } = useTranslation()
  const { preferences, saveFailed, update } = usePreferenceSettings()
  return (
    <>
      <div className="settings-group">
        <SettingRow
          title={t("When work finishes")}
          description={t("Notify when a conversation finishes successfully.")}
        >
          <Select
            aria-label={t("When work finishes")}
            value={preferences.notificationMode}
            onValueChange={(notificationMode) => update({ notificationMode })}
            options={[
              { value: "unfocused", label: t("When away") },
              { value: "always", label: t("Always") },
              { value: "off", label: t("Never") },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t("Notification sound")}
          description={t("Play a sound with system notifications.")}
        >
          <input
            type="checkbox"
            role="switch"
            aria-checked={preferences.notificationSound}
            aria-label={t("Notification sound")}
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
        {t(
          "“When away” sends notifications only while the app window is not in focus.",
        )}
      </p>
      <NotificationCheck />
      {saveFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t("Your preferences could not be saved. Check available storage.")}
        </p>
      )}
    </>
  )
}

function NotificationCheck() {
  const { t } = useTranslation()
  const [permission, setPermission] = useState<NotificationPermissionState>()
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<Message>()
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
          ? t("System notifications are unavailable in this environment.")
          : permission === "denied"
            ? t(
                "Notifications are blocked. Allow them in your browser’s site settings.",
              )
            : window.yakitoriDesktop?.notifications
              ? t(
                  "Delivery follows your system notification and Focus settings.",
                )
              : permission === "default"
                ? t("Send a test to allow notifications in this browser.")
                : t("Browser notifications are enabled.")}
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
        {testing ? t("Sending…") : t("Send test notification")}
      </button>
      {message && <p role="status">{t(message)}</p>}
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
