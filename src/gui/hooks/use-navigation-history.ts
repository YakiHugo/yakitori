import { useEffect, useRef, useState } from "react"
import { type SettingsSection, useAppStore } from "../store/app-store.ts"
import {
  chooseNewEngine,
  clearEngineSelection,
  selectEngineSession,
  useEngineStore,
} from "../store/engine-store.ts"

type Destination =
  | { kind: "session"; sessionId: string }
  | { kind: "draft"; projectId: string | undefined }
  | {
      kind: "engine"
      engineId: string
      sessionId: string | undefined
      projectId: string | undefined
    }

type Visit = {
  destination: Destination
  settings: SettingsSection | undefined
  intent: number
}

function currentVisit(): Visit {
  const app = useAppStore.getState()
  const engine = useEngineStore.getState()
  return {
    destination: engine.engineId
      ? {
          kind: "engine",
          engineId: engine.engineId,
          sessionId: engine.sessionId,
          projectId: app.currentProject,
        }
      : app.selection.sessionId
        ? { kind: "session", sessionId: app.selection.sessionId }
        : { kind: "draft", projectId: app.currentProject },
    settings: app.settingsSection,
    intent: app.sessionSelectionIntentRevision,
  }
}

// History belongs to this window. It records navigation, never token updates,
// and restores drafts without starting another server-side session creation.
export function useNavigationHistory() {
  const history = useRef({
    apiBase: useAppStore.getState().apiBase,
    visits: [currentVisit()],
    index: 0,
  })
  const [position, setPosition] = useState({ back: false, forward: false })

  useEffect(() => {
    let active = true
    let queued = false
    const record = () => {
      if (queued) return
      queued = true
      // Selection actions update both stores in several synchronous steps.
      // Only the final destination is a visit, not the intermediate cleared state.
      queueMicrotask(() => {
        queued = false
        if (!active) return
        const next = currentVisit()
        const state = history.current
        const apiBase = useAppStore.getState().apiBase
        if (state.apiBase !== apiBase) {
          history.current = { apiBase, visits: [next], index: 0 }
        } else {
          const previous = state.visits[state.index]
          if (!previous) return
          const sameDestination =
            JSON.stringify(previous.destination) ===
            JSON.stringify(next.destination)
          if (sameDestination && previous.settings === next.settings) {
            state.visits[state.index] = next
            return
          }
          // A draft receiving its newly created ID is still the same visit.
          const created =
            previous.intent === next.intent &&
            previous.settings === next.settings &&
            ((previous.destination.kind === "draft" &&
              next.destination.kind === "session") ||
              (previous.destination.kind === "engine" &&
                next.destination.kind === "engine" &&
                previous.destination.engineId === next.destination.engineId &&
                previous.destination.sessionId === undefined &&
                next.destination.sessionId !== undefined))
          const initialProject =
            next.intent === 0 &&
            state.visits.length === 1 &&
            previous.settings === undefined &&
            next.settings === undefined &&
            previous.destination.kind === "draft" &&
            next.destination.kind === "draft"
          if (created || initialProject) {
            state.visits[state.index] = next
          } else {
            state.visits = [...state.visits.slice(0, state.index + 1), next]
            state.index += 1
          }
        }
        const { index, visits } = history.current
        setPosition({ back: index > 0, forward: index < visits.length - 1 })
      })
    }
    const unsubscribeApp = useAppStore.subscribe(record)
    const unsubscribeEngine = useEngineStore.subscribe(record)
    return () => {
      active = false
      unsubscribeApp()
      unsubscribeEngine()
    }
  }, [])

  const move = (offset: number) => {
    const state = history.current
    const index = state.index + offset
    const visit = state.visits[index]
    if (!visit) return
    state.index = index
    const app = useAppStore.getState()
    const target = visit.destination
    if (JSON.stringify(currentVisit().destination) !== JSON.stringify(target)) {
      if (target.kind === "engine") {
        if (target.sessionId) {
          void selectEngineSession({
            id: target.sessionId,
            engineId: target.engineId,
            ...(target.projectId === undefined
              ? {}
              : { projectId: target.projectId }),
          })
        } else {
          app.clearSessionSelection({ projectId: target.projectId })
          chooseNewEngine(target.engineId)
        }
      } else {
        clearEngineSelection()
        if (target.kind === "session") void app.selectSession(target.sessionId)
        else app.clearSessionSelection({ projectId: target.projectId })
      }
    }
    if (visit.settings) app.openSettings(visit.settings)
    else app.closeSettings()
    setPosition({ back: index > 0, forward: index < state.visits.length - 1 })
  }
  return {
    canGoBack: position.back,
    canGoForward: position.forward,
    back: () => move(-1),
    forward: () => move(1),
  }
}
