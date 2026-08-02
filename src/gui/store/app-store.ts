import { useMemo } from "react"
import { create } from "zustand"
import type { StoredEventEnvelope } from "../../kernel/index.ts"
import type {
  ApiAdmitInputResponse,
  ApiCreateSessionResponse,
  ApiListSessionsResponse,
  ApiReadSessionResponse,
  ApiSessionDetail,
  ApiSessionSummary,
} from "../../server/protocol.ts"
import { acknowledgeAdmission, reserveAdmission } from "../admission-outbox.ts"
import {
  createExecutionViewState,
  type ExecutionView,
  type ExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../execution-view.ts"
import {
  ApiRequestError,
  cancelSessionInput,
  openSessionEventStream,
  requestJson,
} from "../lib/api-client.ts"
import {
  beginSessionSelection,
  clearSessionSelection,
  createSessionSelectionState,
  currentSessionSelection,
  isCurrentSessionSelection,
  type SessionSelection,
  type SessionSelectionState,
} from "../session-selection.ts"

export type StreamStatus = "connected" | "connecting" | "disconnected" | "idle"

export type AppStoreData = {
  apiBase: string
  apiRevision: number
  busy: boolean
  events: StoredEventEnvelope[]
  execution: ExecutionViewState
  inFlightActions: ReadonlySet<string>
  message: string | undefined
  nextCursor: string | undefined
  promptDraft: string | undefined
  selection: SessionSelectionState
  sessionDetailRevision: number
  sessionListRevision: number
  sessionSelectionIntentRevision: number
  selectedSession: ApiSessionDetail | undefined
  sessions: ApiSessionSummary[]
  stream: EventSource | undefined
  streamStatus: StreamStatus
}

export type AppStoreActions = {
  boot(): Promise<void>
  loadSessions(input?: { readonly append?: boolean }): Promise<boolean>
  createSession(): Promise<void>
  selectSession(sessionId: string): Promise<void>
  admitInput(text: string): Promise<void>
  cancelTurn(turnId: string): Promise<void>
  cancelQueuedInput(inputId: string): Promise<void>
  resolvePermission(
    turnId: string,
    permissionRequestId: string,
    behavior: "allow" | "deny",
  ): Promise<void>
  connectApiBase(apiBase: string): void
  setPromptDraft(text: string): void
}

export type AppStore = AppStoreData & AppStoreActions

export function createInitialAppState(): AppStoreData {
  return {
    apiBase: initialApiBase(),
    apiRevision: 0,
    busy: false,
    events: [],
    execution: createExecutionViewState(),
    inFlightActions: new Set(),
    message: undefined,
    nextCursor: undefined,
    promptDraft: undefined,
    selection: createSessionSelectionState(),
    sessionDetailRevision: 0,
    sessionListRevision: 0,
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessions: [],
    stream: undefined,
    streamStatus: "idle",
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  const runTask = async (
    task: () => Promise<void>,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> => {
    activeTaskCount += 1
    set({ busy: true })
    if (isCurrent()) set({ message: undefined })
    try {
      await task()
      return true
    } catch (error) {
      if (isCurrent()) set({ message: errorMessage(error, "Request failed.") })
      return false
    } finally {
      activeTaskCount -= 1
      set({ busy: activeTaskCount > 0 })
    }
  }

  const syncSelection = (): void => {
    set({ selection: { ...get().selection } })
  }

  const activateSession = (sessionId: string): SessionSelection => {
    set((state) => ({
      sessionDetailRevision: state.sessionDetailRevision + 1,
    }))
    const selection = beginSessionSelection(get().selection, sessionId)
    syncSelection()
    return selection
  }

  const closeStream = (): void => {
    get().stream?.close()
    set({ stream: undefined, streamStatus: "idle" })
  }

  const mergeEvent = (event: StoredEventEnvelope): void => {
    const state = get()
    if (state.events.some((candidate) => candidate.id === event.id)) return
    set({
      events: [...state.events, event].sort(
        (left, right) => left.seq - right.seq,
      ),
      execution: reduceExecutionView(state.execution, {
        type: "durable",
        event,
        ...(state.selectedSession === undefined
          ? {}
          : { session: state.selectedSession }),
      }),
    })
  }

  const refreshSelectedSession = async (
    selection: SessionSelection,
  ): Promise<boolean> => {
    const requestRevision = get().sessionDetailRevision + 1
    set({ sessionDetailRevision: requestRevision })
    let response: ApiReadSessionResponse
    try {
      response = await requestJson<ApiReadSessionResponse>(
        get().apiBase,
        `/sessions/${encodeURIComponent(selection.sessionId)}`,
      )
    } catch (error) {
      if (
        !isCurrentSessionSelection(get().selection, selection) ||
        get().sessionDetailRevision !== requestRevision
      ) {
        return false
      }
      throw error
    }
    if (
      !isCurrentSessionSelection(get().selection, selection) ||
      get().sessionDetailRevision !== requestRevision
    ) {
      return false
    }
    set({
      selectedSession: response.session,
      execution: reduceExecutionView(get().execution, {
        type: "session",
        session: response.session,
      }),
    })
    return true
  }

  const connectEvents = (selection: SessionSelection, after: number): void => {
    if (!isCurrentSessionSelection(get().selection, selection)) return
    closeStream()

    try {
      set({ streamStatus: "connecting" })
      const source = openSessionEventStream(
        get().apiBase,
        selection.sessionId,
        after,
        {
          onOpen: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            set({ streamStatus: "connected" })
          },
          onEvent: (event) => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            mergeEvent(event)
            void refreshSelectedSession(selection).then(
              () => {},
              (error: unknown) => {
                if (!isCurrentSessionSelection(get().selection, selection)) {
                  return
                }
                set({
                  message: errorMessage(error, "Could not refresh session."),
                })
              },
            )
          },
          onTransient: (event) => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            set({
              execution: reduceExecutionView(get().execution, {
                type: "transient",
                event,
              }),
            })
          },
          onError: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            set({ streamStatus: "disconnected" })
          },
        },
      )
      set({ stream: source })
    } catch (error) {
      closeStream()
      if (!isCurrentSessionSelection(get().selection, selection)) return
      set({ message: errorMessage(error, "Could not open event stream.") })
    }
  }

  const clearSessionState = (): void => {
    const state = get()
    clearSessionSelection(state.selection)
    set({
      apiRevision: state.apiRevision + 1,
      events: [],
      execution: createExecutionViewState(),
      inFlightActions: new Set(),
      selection: { ...state.selection },
      sessionDetailRevision: state.sessionDetailRevision + 1,
      sessionListRevision: state.sessionListRevision + 1,
      sessionSelectionIntentRevision: state.sessionSelectionIntentRevision + 1,
      sessions: [],
      nextCursor: undefined,
      promptDraft: undefined,
      selectedSession: undefined,
    })
  }

  return {
    ...createInitialAppState(),

    boot: async () => {
      const apiRevision = get().apiRevision
      const intentRevision = get().sessionSelectionIntentRevision
      const loaded = await get().loadSessions()
      if (
        !loaded ||
        get().apiRevision !== apiRevision ||
        get().sessionSelectionIntentRevision !== intentRevision
      ) {
        return
      }
      const session = get().sessions.at(0)
      if (session) {
        await get().selectSession(session.id)
        return
      }
      closeStream()
      clearSessionSelection(get().selection)
      set((state) => ({
        selection: { ...state.selection },
        sessionDetailRevision: state.sessionDetailRevision + 1,
        selectedSession: undefined,
        events: [],
        execution: createExecutionViewState(),
      }))
    },

    loadSessions: async (input = {}) => {
      const apiRevision = get().apiRevision
      const requestRevision = get().sessionListRevision + 1
      set({ sessionListRevision: requestRevision })
      const existingSessions = get().sessions
      const cursor = input.append ? get().nextCursor : undefined
      let applied = false
      const completed = await runTask(
        async () => {
          const response = await requestJson<ApiListSessionsResponse>(
            get().apiBase,
            `/sessions?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
          if (
            get().apiRevision !== apiRevision ||
            get().sessionListRevision !== requestRevision
          ) {
            return
          }
          set({
            sessions: input.append
              ? [...existingSessions, ...response.sessions]
              : [...response.sessions],
            nextCursor: response.nextCursor,
          })
          applied = true
        },
        () =>
          get().apiRevision === apiRevision &&
          get().sessionListRevision === requestRevision,
      )
      return completed && applied
    },

    createSession: async () => {
      const apiRevision = get().apiRevision
      const intentRevision = get().sessionSelectionIntentRevision + 1
      set({ sessionSelectionIntentRevision: intentRevision })
      await runTask(
        async () => {
          const response = await requestJson<ApiCreateSessionResponse>(
            get().apiBase,
            "/sessions",
            {
              method: "POST",
              body: {
                title: `Session ${new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`,
              },
            },
          )

          if (get().apiRevision !== apiRevision) return
          await get().loadSessions()
          if (get().sessionSelectionIntentRevision !== intentRevision) return
          const selection = activateSession(response.session.id)
          set({
            selectedSession: response.session,
            events: [response.event],
            execution: reduceExecutionView(createExecutionViewState(), {
              type: "durable",
              event: response.event,
              session: response.session,
            }),
            promptDraft: undefined,
          })
          connectEvents(selection, response.event.seq)
        },
        () =>
          get().apiRevision === apiRevision &&
          get().sessionSelectionIntentRevision === intentRevision,
      )
    },

    selectSession: async (sessionId) => {
      set((state) => ({
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
      }))
      const selection = activateSession(sessionId)
      closeStream()
      set({
        events: [],
        execution: createExecutionViewState(),
        promptDraft: undefined,
        selectedSession: undefined,
      })
      await runTask(
        async () => {
          const applied = await refreshSelectedSession(selection)
          if (!applied) return
          connectEvents(selection, 0)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
    },

    admitInput: async (text) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return

      await runTask(
        async () => {
          const pendingAdmission = await reserveAdmission(window.localStorage, {
            apiBase: get().apiBase,
            sessionId: selection.sessionId,
            text,
          })
          if (!isCurrentSessionSelection(get().selection, selection)) return
          const response = await requestJson<ApiAdmitInputResponse>(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/inputs`,
            {
              method: "POST",
              body: {
                requestId: pendingAdmission.requestId,
                content: {
                  kind: "text",
                  text,
                },
              },
            },
          )
          if (
            response.requestId !== pendingAdmission.requestId ||
            response.event.sessionId !== selection.sessionId
          ) {
            throw new Error("Admission response did not match the request.")
          }
          await acknowledgeAdmission(window.localStorage, pendingAdmission)
          if (!isCurrentSessionSelection(get().selection, selection)) return
          if (get().promptDraft?.trim() === text) {
            set({ promptDraft: undefined })
          }
          mergeEvent(response.event)
          await refreshSelectedSession(selection)
          if (!isCurrentSessionSelection(get().selection, selection)) return
          await get().loadSessions()
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
    },

    cancelTurn: async (turnId) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return
      const key = `cancel:${turnId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          await requestJson(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
            { method: "POST", body: { reason: "user_cancel" } },
          )
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    cancelQueuedInput: async (inputId) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return
      const key = `cancel-input:${inputId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          try {
            const response = await cancelSessionInput(
              get().apiBase,
              selection.sessionId,
              inputId,
            )
            if (!isCurrentSessionSelection(get().selection, selection)) return
            // Merge the recorded fact now; the SSE replay dedups by event id.
            mergeEvent(response.event)
          } catch (error) {
            // 409 means the input already left the pending queue (usually it
            // just started); the detail refresh below reconciles the view.
            if (!(error instanceof ApiRequestError && error.status === 409)) {
              throw error
            }
          }
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    resolvePermission: async (turnId, permissionRequestId, behavior) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return
      const key = `permission:${permissionRequestId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          await requestJson(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/turns/${encodeURIComponent(turnId)}/permissions/${encodeURIComponent(permissionRequestId)}/resolve`,
            {
              method: "POST",
              body: {
                behavior,
                reason: {
                  kind: behavior === "allow" ? "user_allowed" : "user_denied",
                },
              },
            },
          )
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    connectApiBase: (apiBase) => {
      set({ apiBase })
      window.localStorage.setItem("yakitori.apiBase", apiBase)
      closeStream()
      clearSessionState()
      void get().boot()
    },

    setPromptDraft: (text) => {
      set({ promptDraft: text })
    },
  }
})

export function useExecutionView(): ExecutionView {
  const execution = useAppStore((state) => state.execution)
  return useMemo(() => projectExecutionView(execution), [execution])
}

function initialApiBase(): string {
  const queryApi = new URLSearchParams(window.location.search).get("api")
  if (queryApi) return queryApi
  // Read via window: Node 24 exposes a bare global localStorage stub whose
  // methods throw, and test environments leave it in place.
  return (
    window.localStorage.getItem("yakitori.apiBase") ?? window.location.origin
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}
