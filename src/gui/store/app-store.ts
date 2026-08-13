import { useMemo } from "react"
import { create } from "zustand"
import {
  EventType,
  type ModelSelection,
  type StoredEventEnvelope,
  type TurnStartedEvent,
} from "../../kernel/events.ts"
import type {
  ApiAdmitInputResponse,
  ApiCreateSessionResponse,
  ApiListProvidersResponse,
  ApiListSessionsResponse,
  ApiProviderSummary,
  ApiReadSessionResponse,
  ApiSessionDetail,
  ApiSessionSummary,
  ApiUpdateUserModelPreferenceResponse,
  ApiUserModelPreference,
  ApiListProjectsResponse,
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
  defaultModel: string | undefined
  defaultProvider: string | undefined
  events: StoredEventEnvelope[]
  execution: ExecutionViewState
  inFlightActions: ReadonlySet<string>
  message: string | undefined
  modelSelectionReady: boolean
  modelSelections: Record<string, ModelSelection>
  nextCursor: string | undefined
  promptDraft: string | undefined
  projects: string[]
  providers: ApiProviderSummary[]
  userPreference: ApiUserModelPreference | undefined
  selection: SessionSelectionState
  sessionDetailRevision: number
  sessionListRevision: number
  sessionSelectionIntentRevision: number
  selectedSession: ApiSessionDetail | undefined
  sessions: ApiSessionSummary[]
  stream: EventSource | undefined
  streamStatus: StreamStatus
  currentProject: string | undefined
}

export type AppStoreActions = {
  boot(): Promise<void>
  loadSessions(input?: { readonly append?: boolean }): Promise<boolean>
  loadProjects(): Promise<void>
  loadProviders(): Promise<void>
  createSession(): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  selectProject(path: string): Promise<void>
  addProject(path: string): Promise<void>
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
  setModelSelection(
    sessionId: string,
    selection: ModelSelection | undefined,
  ): void
}

export type AppStore = AppStoreData & AppStoreActions

export function createInitialAppState(): AppStoreData {
  return {
    apiBase: initialApiBase(),
    apiRevision: 0,
    busy: false,
    defaultModel: undefined,
    defaultProvider: undefined,
    events: [],
    execution: createExecutionViewState(),
    inFlightActions: new Set(),
    message: undefined,
    modelSelectionReady: true,
    modelSelections: initialModelSelections(),
    nextCursor: undefined,
    promptDraft: undefined,
    projects: [],
    providers: [],
    userPreference: undefined,
    selection: createSessionSelectionState(),
    sessionDetailRevision: 0,
    sessionListRevision: 0,
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessions: [],
    stream: undefined,
    streamStatus: "idle",
    currentProject: undefined,
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  const restoringModelSelections = new Set<string>()
  let userPreferenceRevision = 0
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
    const restored = restoringModelSelections.has(event.sessionId)
      ? modelSelectionFromTurn(event)
      : undefined
    const modelSelections =
      restored === undefined
        ? state.modelSelections
        : { ...state.modelSelections, [event.sessionId]: restored }
    if (restored !== undefined) persistModelSelections(modelSelections)
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
      modelSelections,
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
          onReplayComplete: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            restoringModelSelections.delete(selection.sessionId)
            set({ modelSelectionReady: true })
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
    restoringModelSelections.clear()
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
      await get().loadProviders()
      await get().loadProjects()
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
      const workingDirectory = get().currentProject
      let applied = false
      const completed = await runTask(
        async () => {
          const response = await requestJson<ApiListSessionsResponse>(
            get().apiBase,
            `/sessions?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${workingDirectory === undefined ? "" : `&workingDirectory=${encodeURIComponent(workingDirectory)}`}`,
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

    loadProjects: async () => {
      try {
        const response = await requestJson<ApiListProjectsResponse>(
          get().apiBase,
          "/projects",
        )
        const projects = [...response.projects]
        const current = get().currentProject
        const remembered = window.localStorage.getItem("yakitori.project")
        const currentProject =
          current !== undefined && projects.includes(current)
            ? current
            : remembered !== null && projects.includes(remembered)
              ? remembered
              : projects[0]
        set({
          projects,
          ...(currentProject === undefined ? {} : { currentProject }),
        })
      } catch {
        // Older servers without the projects route return 404; project state
        // stays empty and the switcher stays hidden.
      }
    },

    loadProviders: async () => {
      try {
        const response = await requestJson<ApiListProvidersResponse>(
          get().apiBase,
          "/providers",
        )
        set({
          providers: [...response.providers],
          defaultProvider: response.defaultProvider,
          defaultModel: response.defaultModel,
          userPreference: response.userPreference,
        })
      } catch {
        // Older servers without the providers route return 404; the model
        // selector stays hidden.
      }
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
                ...(get().currentProject === undefined
                  ? {}
                  : { workingDirectory: get().currentProject }),
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

    deleteSession: async (sessionId) => {
      const key = `delete:${sessionId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(async () => {
        await requestJson(
          get().apiBase,
          `/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        )
        if (get().selection.sessionId === sessionId) {
          closeStream()
          clearSessionSelection(get().selection)
          set((state) => ({
            selection: { ...state.selection },
            sessionDetailRevision: state.sessionDetailRevision + 1,
            sessionSelectionIntentRevision:
              state.sessionSelectionIntentRevision + 1,
            selectedSession: undefined,
            events: [],
            execution: createExecutionViewState(),
          }))
        }
        await get().loadSessions()
      })
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    selectProject: async (path) => {
      if (get().currentProject === path) return
      set({ currentProject: path })
      window.localStorage.setItem("yakitori.project", path)
      closeStream()
      clearSessionSelection(get().selection)
      set((state) => ({
        selection: { ...state.selection },
        sessionDetailRevision: state.sessionDetailRevision + 1,
        sessionListRevision: state.sessionListRevision + 1,
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        selectedSession: undefined,
        events: [],
        execution: createExecutionViewState(),
        nextCursor: undefined,
        promptDraft: undefined,
      }))
      await get().loadSessions()
    },

    addProject: async (path) => {
      const trimmed = path.trim()
      if (trimmed === "") return
      await runTask(async () => {
        const previous = get().projects
        const response = await requestJson<ApiListProjectsResponse>(
          get().apiBase,
          "/projects",
          { method: "POST", body: { path: trimmed } },
        )
        const projects = [...response.projects]
        set({ projects })
        // The response carries only the list; the previously unknown entry is
        // the server's resolved realpath for the added project.
        const added = projects.find(
          (candidate) => !previous.includes(candidate),
        )
        await get().selectProject(added ?? trimmed)
      })
    },

    selectSession: async (sessionId) => {
      set((state) => ({
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
      }))
      if (get().modelSelections[sessionId] === undefined) {
        restoringModelSelections.add(sessionId)
        set({ modelSelectionReady: false })
      } else {
        restoringModelSelections.delete(sessionId)
        set({ modelSelectionReady: true })
      }
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
      if (!selection || !get().modelSelectionReady) return

      await runTask(
        async () => {
          const state = get()
          const modelSelection = resolveEffectiveModel({
            sessionCurrent: state.modelSelections[selection.sessionId],
            userPreference: state.userPreference,
            defaultProvider: state.defaultProvider,
            defaultModel: state.defaultModel,
          })
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
                ...(modelSelection === undefined ? {} : { modelSelection }),
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

    setModelSelection: (sessionId, selection) => {
      userPreferenceRevision += 1
      const preferenceRevision = userPreferenceRevision
      restoringModelSelections.delete(sessionId)
      const modelSelections = { ...get().modelSelections }
      if (selection === undefined) delete modelSelections[sessionId]
      else modelSelections[sessionId] = selection
      set({ modelSelections })
      persistModelSelections(modelSelections)
      if (selection === undefined) return
      void runTask(async () => {
        const response =
          await requestJson<ApiUpdateUserModelPreferenceResponse>(
            get().apiBase,
            "/user-preference",
            { method: "PUT", body: selection },
          )
        if (preferenceRevision !== userPreferenceRevision) return
        set({ userPreference: response.userPreference })
      })
    },
  }
})

export function resolveEffectiveModel(input: {
  readonly sessionCurrent: ModelSelection | undefined
  readonly userPreference: ApiUserModelPreference | undefined
  readonly defaultProvider: string | undefined
  readonly defaultModel: string | undefined
}): ModelSelection | undefined {
  if (input.sessionCurrent !== undefined) return input.sessionCurrent
  if (input.userPreference !== undefined) return input.userPreference
  if (input.defaultProvider === undefined || input.defaultModel === undefined) {
    return undefined
  }
  return { provider: input.defaultProvider, model: input.defaultModel }
}

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

function initialModelSelections(): Record<string, ModelSelection> {
  // Same window indirection as initialApiBase for the Node 24 stub.
  const raw = window.localStorage.getItem("yakitori.modelSelections")
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as Record<string, ModelSelection>
  } catch {
    return {}
  }
}

function modelSelectionFromTurn(
  event: StoredEventEnvelope,
): ModelSelection | undefined {
  if (event.type !== EventType.TurnStarted) return undefined
  const context = (event.data as TurnStartedEvent["data"]).executionContext
  if (context === undefined) return undefined
  return {
    provider: context.provider,
    model: context.model,
    ...(context.effort === undefined ? {} : { effort: context.effort }),
    ...(context.speed === undefined ? {} : { speed: context.speed }),
  }
}

function persistModelSelections(
  modelSelections: Readonly<Record<string, ModelSelection>>,
): void {
  window.localStorage.setItem(
    "yakitori.modelSelections",
    JSON.stringify(modelSelections),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}
