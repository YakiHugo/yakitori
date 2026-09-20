import { create } from "zustand"

export type NotificationMode = "off" | "unfocused" | "always"
export type Preferences = Readonly<{
  appearance: "light" | "dark" | "system"
  sendShortcut: "enter" | "mod-enter"
  notificationMode: NotificationMode
  notificationSound: boolean
}>

export const defaultPreferences: Preferences = {
  appearance: "light",
  sendShortcut: "enter",
  // Follow Codex's notification condition: only interrupt when unfocused.
  notificationMode: "unfocused",
  notificationSound: true,
}

const storageKey = "yakitori.preferences"

export function readPreferences(): Preferences {
  const saved = localStorage.getItem(storageKey)
  if (!saved) return defaultPreferences
  let value: unknown
  try {
    value = JSON.parse(saved)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return defaultPreferences
  }
  if (typeof value !== "object" || value === null) return defaultPreferences
  return {
    appearance:
      "appearance" in value &&
      (value.appearance === "dark" || value.appearance === "system")
        ? value.appearance
        : defaultPreferences.appearance,
    sendShortcut:
      "sendShortcut" in value && value.sendShortcut === "mod-enter"
        ? "mod-enter"
        : defaultPreferences.sendShortcut,
    notificationMode:
      "notificationMode" in value &&
      (value.notificationMode === "off" || value.notificationMode === "always")
        ? value.notificationMode
        : defaultPreferences.notificationMode,
    notificationSound:
      "notificationSound" in value &&
      typeof value.notificationSound === "boolean"
        ? value.notificationSound
        : defaultPreferences.notificationSound,
  }
}

export const usePreferencesStore = create<
  Preferences & {
    updatePreferences(patch: Partial<Preferences>): void
  }
>()((set, get) => ({
  ...readPreferences(),
  updatePreferences(patch) {
    const { updatePreferences: _, ...current } = get()
    const next = { ...current, ...patch }
    // Persist before publishing: a failed write must not claim to be saved.
    localStorage.setItem(storageKey, JSON.stringify(next))
    set(next)
  },
}))
