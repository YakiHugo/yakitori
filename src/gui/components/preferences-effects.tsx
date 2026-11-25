import { useEffect } from "react"
import { startCompletionNotifications } from "../completion-notifications.ts"
import { useTranslation } from "../i18n/use-translation.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { usePreferencesStore } from "../store/preferences-store.ts"

export function PreferencesEffects() {
  const { locale } = useTranslation()
  const appearance = usePreferencesStore((state) => state.appearance)
  const apiBase = useAppStore((state) => state.apiBase)
  useEffect(
    () => startCompletionNotifications(getAppRpcClient(apiBase), apiBase),
    [apiBase],
  )
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        appearance === "dark" || (appearance === "system" && media.matches),
      )
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [appearance])
  return null
}
