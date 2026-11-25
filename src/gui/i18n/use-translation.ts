import { useSyncExternalStore } from "react"
import { usePreferencesStore } from "../store/preferences-store.ts"
import { type Locale, resolveLocale } from "./locale.ts"
import { type Translate, translators } from "./messages.ts"

function subscribeToLocale(onChange: () => void): () => void {
  const unsubscribe = usePreferencesStore.subscribe((next, previous) => {
    if (next.language !== previous.language) onChange()
  })
  window.addEventListener("languagechange", onChange)
  return () => {
    unsubscribe()
    window.removeEventListener("languagechange", onChange)
  }
}

export function getLocale(): Locale {
  return resolveLocale(
    usePreferencesStore.getState().language,
    navigator.languages ?? (navigator.language ? [navigator.language] : []),
  )
}

// Read the current locale for asynchronous feedback without restarting the work.
export const translate: Translate = (message, ...values) =>
  translators[getLocale()](message, ...values)

export function useTranslation(): Readonly<{ locale: Locale; t: Translate }> {
  const locale = useSyncExternalStore(subscribeToLocale, getLocale)
  return { locale, t: translators[locale] }
}
