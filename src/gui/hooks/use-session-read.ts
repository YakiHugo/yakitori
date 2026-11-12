import { useEffect } from "react"
import { useAppStore } from "../store/app-store.ts"
import { useEngineStore } from "../store/engine-store.ts"
import { useSessionReadStore } from "../store/session-read-store.ts"

export function useSessionRead(): void {
  const apiBase = useAppStore((state) => state.apiBase)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const completionSeq = useAppStore((state) =>
    state.selectedSession?.id === state.selection.sessionId
      ? state.selectedSession?.latestCompletionSeq
      : undefined,
  )
  const visible = useAppStore(
    (state) =>
      state.hydratingSessionId === undefined &&
      state.settingsSection === undefined &&
      state.execution.lastSeq >=
        (state.selectedSession?.latestCompletionSeq ?? 0),
  )
  const externalEngine = useEngineStore((state) => state.engineId)
  const markRead = useSessionReadStore((state) => state.markRead)
  const syncFromStorage = useSessionReadStore((state) => state.syncFromStorage)

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === localStorage) syncFromStorage()
    }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [syncFromStorage])

  useEffect(() => {
    if (!sessionId || completionSeq === undefined || !visible || externalEngine)
      return
    const read = () => {
      if (document.visibilityState === "visible" && document.hasFocus())
        markRead(apiBase, sessionId, completionSeq)
    }
    read()
    window.addEventListener("focus", read)
    document.addEventListener("visibilitychange", read)
    return () => {
      window.removeEventListener("focus", read)
      document.removeEventListener("visibilitychange", read)
    }
  }, [apiBase, sessionId, completionSeq, visible, externalEngine, markRead])
}
