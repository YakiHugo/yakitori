import { create } from "zustand"
import type {
  EngineDescriptor,
  EngineSessionSnapshot,
  EngineSessionSummary,
} from "../../protocol/engine.ts"
import type { InputDraft } from "../../protocol/user-input.ts"
import { projectEngineSession } from "../engine-session-view.ts"
import { textInputDraft } from "../input-draft.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "./app-store.ts"

const selectionKey = "yakitori.engineSession"
const pendingKey = (sessionId: string) => `yakitori.enginePending:${sessionId}`
type EngineState = {
  engines: readonly EngineDescriptor[]
  sessions: readonly EngineSessionSummary[]
  engineId?: string | undefined
  sessionId?: string | undefined
  snapshot?: EngineSessionSnapshot | undefined
  pendingRequestId?: string | undefined
  draft: InputDraft
  error?: string | undefined
  loading: boolean
  sending: boolean
  stopping: boolean
}
export const initialEngineState: EngineState = {
  engines: [],
  sessions: [],
  draft: textInputDraft(""),
  loading: false,
  sending: false,
  stopping: false,
}
export const useEngineStore = create<EngineState>(() => initialEngineState)
const client = () => getAppRpcClient(useAppStore.getState().apiBase)
let revision = 0
let refreshing = false
let refreshAgain = false

export function clearEngineSelection() {
  revision += 1
  localStorage.removeItem(selectionKey)
  useEngineStore.setState({
    engineId: undefined,
    sessionId: undefined,
    snapshot: undefined,
    pendingRequestId: undefined,
    draft: textInputDraft(""),
    error: undefined,
    loading: false,
    sending: false,
    stopping: false,
  })
}
export function chooseNewEngine(engineId: string) {
  useAppStore.getState().clearSessionSelection()
  clearEngineSelection()
  useEngineStore.setState({ engineId: engineId || undefined })
}
export async function selectEngineSession(session: EngineSessionSummary) {
  useAppStore.getState().clearSessionSelection({ projectId: session.projectId })
  clearEngineSelection()
  useEngineStore.setState({
    engineId: session.engineId,
    sessionId: session.id,
    pendingRequestId: localStorage.getItem(pendingKey(session.id)) ?? undefined,
    loading: true,
  })
  localStorage.setItem(selectionKey, session.id)
  await refreshEngineSelection()
}

// A burst of token notifications causes at most one read in flight and one
// trailing read. The final notification cannot be lost behind an older read.
async function refreshEngineSelection() {
  refreshAgain = true
  if (refreshing) return
  refreshing = true
  try {
    while (refreshAgain) {
      refreshAgain = false
      const captured = revision
      const id = useEngineStore.getState().sessionId
      if (id === undefined) continue
      try {
        const snapshot = await client().request("engineSession/read", {
          sessionId: id,
        })
        if (revision === captured && useEngineStore.getState().sessionId === id)
          useEngineStore.setState((current) => {
            const receipt = snapshot.requests.find(
              (request) => request.requestId === current.pendingRequestId,
            )
            const resolved =
              receipt !== undefined &&
              receipt.status !== "unknown" &&
              receipt.status !== "pending"
            if (
              resolved &&
              localStorage.getItem(pendingKey(id)) === current.pendingRequestId
            )
              localStorage.removeItem(pendingKey(id))
            return {
              snapshot,
              loading: false,
              pendingRequestId: resolved ? undefined : current.pendingRequestId,
              stopping:
                current.stopping &&
                projectEngineSession(snapshot).activeTurnId !== undefined,
            }
          })
      } catch (error) {
        if (revision === captured)
          useEngineStore.setState({ error: String(error), loading: false })
      }
    }
  } finally {
    refreshing = false
  }
}

export async function initializeEngineSessions() {
  const rpc = client()
  rpc.subscribeToEngineSessionChanges((sessionId) => {
    if (sessionId === undefined) {
      void Promise.all([
        rpc.request("engine/list", {}),
        rpc.request("engineSession/list", {}),
      ]).then(
        ([{ engines }, { sessions }]) =>
          useEngineStore.setState({ engines, sessions }),
        (error: unknown) => useEngineStore.setState({ error: String(error) }),
      )
    }
    if (
      sessionId === undefined ||
      sessionId === useEngineStore.getState().sessionId
    )
      void refreshEngineSelection()
  })
  useAppStore.subscribe((state, previous) => {
    if (
      state.sessionSelectionIntentRevision !==
      previous.sessionSelectionIntentRevision
    )
      clearEngineSelection()
  })
  try {
    const [{ engines }, { sessions }] = await Promise.all([
      rpc.request("engine/list", {}),
      rpc.request("engineSession/list", {}),
    ])
    useEngineStore.setState({ engines, sessions })
    const saved = localStorage.getItem(selectionKey)
    const session = sessions.find((entry) => entry.id === saved)
    if (session) await selectEngineSession(session)
  } catch (error) {
    useEngineStore.setState({ error: String(error) })
  }
}

export async function sendEngineInput(text: string) {
  const state = useEngineStore.getState()
  const view =
    state.snapshot === undefined
      ? undefined
      : projectEngineSession(state.snapshot)
  if (
    !state.engineId ||
    state.sending ||
    state.pendingRequestId ||
    view?.activeTurnId ||
    view?.uncertain.length ||
    !text.trim()
  )
    return
  const captured = revision
  useEngineStore.setState({ sending: true, error: undefined })
  try {
    let sessionId = state.sessionId
    if (sessionId === undefined) {
      const app = useAppStore.getState()
      const cwd = app.projects.find(
        (project) => project.id === app.currentProject,
      )?.roots[0]
      const created = await client().request("engineSession/create", {
        engineId: state.engineId,
        ...(cwd === undefined ? {} : { cwd }),
        ...(app.currentProject === undefined
          ? {}
          : { projectId: app.currentProject }),
      })
      const session = created.session
      useEngineStore.setState((current) => ({
        sessions: [
          ...current.sessions.filter((entry) => entry.id !== session.id),
          session,
        ],
      }))
      if (revision !== captured) return
      sessionId = session.id
      localStorage.setItem(selectionKey, sessionId)
      useEngineStore.setState({ sessionId, snapshot: created })
    }
    const requestId = `request_${crypto.randomUUID()}`
    localStorage.setItem(pendingKey(sessionId), requestId)
    useEngineStore.setState({ pendingRequestId: requestId })
    const result = await client().request("engineSession/send", {
      sessionId,
      requestId,
      text,
    })
    if (localStorage.getItem(pendingKey(sessionId)) === requestId)
      localStorage.removeItem(pendingKey(sessionId))
    if (revision !== captured) return
    useEngineStore.setState({ pendingRequestId: undefined })
    if (result.status === "rejected") throw new Error(result.reason)
    useEngineStore.setState({ draft: textInputDraft("") })
    const { engines } = await client().request("engine/list", {})
    useEngineStore.setState({ engines })
    await refreshEngineSelection()
  } catch (error) {
    if (revision === captured) {
      useEngineStore.setState({
        error: `${String(error)} Input was not automatically retried.`,
      })
      await refreshEngineSelection()
    }
  } finally {
    if (revision === captured) useEngineStore.setState({ sending: false })
  }
}

export async function cancelEngineTurn(turnId: string) {
  const sessionId = useEngineStore.getState().sessionId
  if (!sessionId || useEngineStore.getState().stopping) return
  const captured = revision
  useEngineStore.setState({ stopping: true, error: undefined })
  try {
    await client().request("engineSession/cancel", { sessionId, turnId })
    await refreshEngineSelection()
  } catch (error) {
    if (revision === captured)
      useEngineStore.setState({ error: String(error), stopping: false })
  }
}
export async function answerEnginePermission(
  turnId: string,
  requestId: string,
  optionId: string,
) {
  const sessionId = useEngineStore.getState().sessionId
  if (!sessionId) return
  const captured = revision
  try {
    const accepted = await client().request("engineSession/respondPermission", {
      sessionId,
      turnId,
      requestId,
      optionId,
    })
    if (!accepted)
      throw new Error("This permission request is no longer pending.")
    await refreshEngineSelection()
  } catch (error) {
    if (revision === captured) useEngineStore.setState({ error: String(error) })
  }
}
